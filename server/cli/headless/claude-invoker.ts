// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Claude Invoker
 *
 * Handles spawning and managing Claude CLI processes.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { generateMcpConfig } from './mcp-config.js';
import { detectErrorInStderr, } from './output-utils.js';
import { buildMultimodalMessage } from './prompt-utils.js';
import { assessStall, type StallContext } from './stall-assessor.js';
import type {
  ExecutionResult,
  ResolvedHeadlessConfig,
  ToolUseAccumulator,
} from './types.js';

export interface ClaudeInvokerOptions {
  config: ResolvedHeadlessConfig;
  runningProcesses: Map<number, ChildProcess>;
}

// ========== Stall Detection Helpers ==========

/** Summarize a tool's input for stall assessment context */
function summarizeToolInput(input: Record<string, unknown>): string | undefined {
  try {
    if (input.description) {
      return String(input.description).slice(0, 200);
    }
    if (input.prompt) {
      return String(input.prompt).slice(0, 200);
    }
    if (input.command) {
      return String(input.command).slice(0, 200);
    }
    if (input.pattern) {
      return `pattern: ${String(input.pattern).slice(0, 100)}`;
    }
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return undefined;
  }
}

/** Terminate a stalled process: SIGTERM then SIGKILL after 5s */
function terminateStallProcess(
  claudeProcess: ChildProcess,
  interval: ReturnType<typeof setInterval>,
  config: ResolvedHeadlessConfig,
  message: string,
): void {
  clearInterval(interval);
  config.outputCallback?.(message);
  claudeProcess.kill('SIGTERM');
  setTimeout(() => {
    if (!claudeProcess.killed) {
      claudeProcess.kill('SIGKILL');
    }
  }, 5000);
}

interface StallAssessmentParams {
  stallCtx: StallContext;
  config: ResolvedHeadlessConfig;
  now: number;
  extensionsGranted: number;
  maxExtensions: number;
}

/** Run stall assessment and return updated state if extended, null otherwise */
async function runStallAssessment(
  params: StallAssessmentParams,
): Promise<{ extensionsGranted: number; currentKillDeadline: number } | null> {
  const { stallCtx, config, now, extensionsGranted, maxExtensions } = params;
  try {
    const verdict = await assessStall(stallCtx, config.claudeCommand, config.verbose);
    if (verdict.action === 'extend') {
      const newExtensions = extensionsGranted + 1;
      config.outputCallback?.(
        `\n[[MSTRO_STALL_EXTENDED]] Assessment: process likely working. ${verdict.reason}. Extension ${newExtensions}/${maxExtensions}.\n`
      );
      if (config.verbose) {
        console.log(`[STALL] Extended by ${Math.round(verdict.extensionMs / 60_000)} min: ${verdict.reason}`);
      }
      return { extensionsGranted: newExtensions, currentKillDeadline: now + verdict.extensionMs };
    }
    config.outputCallback?.(
      `\n[[MSTRO_STALL_CONFIRMED]] Assessment: process likely stalled. ${verdict.reason}.\n`
    );
    if (config.verbose) {
      console.log(`[STALL] Assessment says stalled: ${verdict.reason}`);
    }
  } catch (err) {
    if (config.verbose) {
      console.log(`[STALL] Assessment error: ${err}`);
    }
  }
  return null;
}

// ========== Stream Event Handlers ==========

interface StreamHandlerContext {
  config: ResolvedHeadlessConfig;
  accumulatedAssistantResponse: string;
  accumulatedThinking: string;
  accumulatedToolUse: ToolUseAccumulator[];
  toolInputBuffers: Map<number, { name: string; id: string; inputJson: string; startTime: number }>;
}

function handleSessionCapture(
  parsed: any,
  captured: { claudeSessionId?: string }
): void {
  if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
    captured.claudeSessionId = parsed.session_id;
  }
  if (parsed.type === 'result' && parsed.session_id && !captured.claudeSessionId) {
    captured.claudeSessionId = parsed.session_id;
  }
}

function handleThinkingDelta(event: any, ctx: StreamHandlerContext): string {
  if (
    event.type !== 'content_block_delta' ||
    event.delta?.type !== 'thinking_delta' ||
    !event.delta?.thinking
  ) {
    return ctx.accumulatedThinking;
  }

  const thinking = event.delta.thinking;
  const updated = ctx.accumulatedThinking + thinking;

  if (ctx.config.thinkingCallback) {
    ctx.config.thinkingCallback(thinking);
  } else if (ctx.config.outputCallback) {
    ctx.config.outputCallback(thinking);
  } else {
    process.stdout.write(thinking);
  }

  return updated;
}

function handleTextDelta(event: any, ctx: StreamHandlerContext): string {
  if (
    event.type !== 'content_block_delta' ||
    event.delta?.type !== 'text_delta' ||
    !event.delta?.text
  ) {
    return ctx.accumulatedAssistantResponse;
  }

  const text = event.delta.text;
  const updated = ctx.accumulatedAssistantResponse + text;

  if (ctx.config.outputCallback) {
    ctx.config.outputCallback(text);
  }

  return updated;
}

function handleToolStart(event: any, ctx: StreamHandlerContext): void {
  if (
    event.type !== 'content_block_start' ||
    event.content_block?.type !== 'tool_use'
  ) {
    return;
  }

  const toolName = event.content_block.name;
  const toolId = event.content_block.id;
  const index = event.index;

  ctx.toolInputBuffers.set(index, {
    name: toolName,
    id: toolId,
    inputJson: '',
    startTime: Date.now()
  });

  if (ctx.config.toolUseCallback) {
    ctx.config.toolUseCallback({ type: 'tool_start', toolName, toolId, index });
  }
}

function handleToolInputDelta(event: any, ctx: StreamHandlerContext): void {
  if (
    event.type !== 'content_block_delta' ||
    event.delta?.type !== 'input_json_delta'
  ) {
    return;
  }

  const index = event.index;
  const partialJson = event.delta.partial_json;

  const toolBuffer = ctx.toolInputBuffers.get(index);
  if (toolBuffer) {
    toolBuffer.inputJson += partialJson;
  }

  if (ctx.config.toolUseCallback) {
    ctx.config.toolUseCallback({ type: 'tool_input_delta', partialJson, index });
  }
}

function handleToolComplete(event: any, ctx: StreamHandlerContext): void {
  if (event.type !== 'content_block_stop') {
    return;
  }

  const index = event.index;
  const toolBuffer = ctx.toolInputBuffers.get(index);
  if (!toolBuffer) {
    return;
  }

  let completeInput: any = {};
  try {
    completeInput = JSON.parse(toolBuffer.inputJson);
  } catch (_e) {
    // Input might not be valid JSON yet
  }

  ctx.accumulatedToolUse.push({
    toolName: toolBuffer.name,
    toolId: toolBuffer.id,
    toolInput: completeInput,
    startTime: toolBuffer.startTime
  });

  if (ctx.config.toolUseCallback) {
    ctx.config.toolUseCallback({
      type: 'tool_complete',
      toolName: toolBuffer.name,
      toolId: toolBuffer.id,
      index,
      completeInput
    });
  }
}

function handleToolResult(parsed: any, ctx: StreamHandlerContext): void {
  if (parsed.type !== 'user' || !parsed.message?.content) {
    return;
  }

  for (const content of parsed.message.content) {
    if (content.type !== 'tool_result') {
      continue;
    }

    const toolId = content.tool_use_id;
    const result = content.content;
    const isError = content.is_error || false;
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

    const toolEntry = ctx.accumulatedToolUse.find(t => t.toolId === toolId);
    if (toolEntry) {
      toolEntry.result = resultStr;
      toolEntry.isError = isError;
      toolEntry.duration = Date.now() - toolEntry.startTime;
    }

    if (ctx.config.toolUseCallback) {
      ctx.config.toolUseCallback({ type: 'tool_result', toolId, result: resultStr, isError });
    }
  }
}

function processStreamLines(
  buffer: string,
  sessionCapture: { claudeSessionId?: string },
  ctx: StreamHandlerContext
): string {
  const lines = buffer.split('\n');
  const remainder = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      handleSessionCapture(parsed, sessionCapture);
      processStreamEvent(parsed, ctx);
    } catch (_e) {
      // Ignore parse errors
    }
  }

  return remainder;
}

function processStreamEvent(parsed: any, ctx: StreamHandlerContext): void {
  if (parsed.type === 'stream_event' && parsed.event) {
    const event = parsed.event;
    ctx.accumulatedThinking = handleThinkingDelta(event, ctx);
    ctx.accumulatedAssistantResponse = handleTextDelta(event, ctx);
    handleToolStart(event, ctx);
    handleToolInputDelta(event, ctx);
    handleToolComplete(event, ctx);
  }
  handleToolResult(parsed, ctx);
}

// ========== Error Handling ==========

const SPAWN_ERROR_MAP: Record<string, { code: string; message: string }> = {
  ENOENT: {
    code: 'CLAUDE_NOT_INSTALLED',
    message: 'Claude Code is not installed or not in PATH. Please install Claude Code: npm install -g @anthropic-ai/claude-code'
  },
  EACCES: {
    code: 'PERMISSION_DENIED',
    message: 'Permission denied when running Claude Code. Please check file permissions.'
  }
};

function handleSpawnError(
  error: NodeJS.ErrnoException,
  config: ResolvedHeadlessConfig,
  reject: (reason: Error) => void
): void {
  const mapped = error.code ? SPAWN_ERROR_MAP[error.code] : undefined;
  if (!mapped) {
    reject(error);
    return;
  }

  const formatted = `[[MSTRO_ERROR:${mapped.code}]] ${mapped.message}`;
  if (config.outputCallback) {
    config.outputCallback(`\n${formatted}\n`);
  }
  reject(new Error(formatted));
}

// ========== Argument Building ==========

function buildClaudeArgs(
  config: ResolvedHeadlessConfig,
  prompt: string,
  hasImageAttachments: boolean,
  useStreamJson: boolean,
  mcpConfigPath: string | null
): string[] {
  const args = ['--print'];

  if (config.model && config.model !== 'default') {
    args.push('--model', config.model);
  }

  if (useStreamJson) {
    args.push('--output-format', 'stream-json', '--include-partial-messages', '--verbose');
  }

  if (hasImageAttachments) {
    args.push('--input-format', 'stream-json');
  }

  if (config.claudeSessionId) {
    args.push('--resume', config.claudeSessionId);
  } else if (config.continueSession) {
    args.push('--continue');
  }

  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
    args.push('--permission-prompt-tool', 'mcp__mstro-bouncer__approval_prompt');
  } else {
    // Bouncer unavailable: use acceptEdits so file operations work without stdin prompts.
    // Bash still requires approval — Claude Code will skip tools it can't get permission for,
    // which is better than hanging on a stdin prompt that can never be answered.
    args.push('--permission-mode', 'acceptEdits');
  }

  if (!hasImageAttachments) {
    args.push(prompt);
  }

  return args;
}

/**
 * Execute a Claude CLI command for a single movement
 * Supports multimodal prompts via --input-format stream-json when image attachments are present
 */
export async function executeClaudeCommand(
  prompt: string,
  _movementId: string,
  _sessionNumber: number,
  options: ClaudeInvokerOptions
): Promise<ExecutionResult> {
  const { config, runningProcesses } = options;
  const perfStart = Date.now();
  if (config.verbose) {
    console.log(`[PERF] executeMovement started`);
  }

  const hasImageAttachments = config.imageAttachments && config.imageAttachments.length > 0;
  const useStreamJson = hasImageAttachments || config.thinkingCallback || config.outputCallback || config.toolUseCallback;
  const mcpConfigPath = generateMcpConfig(config.workingDir, config.verbose);

  if (!mcpConfigPath && config.outputCallback) {
    config.outputCallback(
      '\n[[MSTRO_ERROR:BOUNCER_UNAVAILABLE]] Security bouncer not available. Running with limited permissions — file edits allowed, but shell commands may be restricted.\n'
    );
  }

  const args = buildClaudeArgs(config, prompt, !!hasImageAttachments, !!useStreamJson, mcpConfigPath);

  if (config.verbose) {
    console.log(`[PERF] About to spawn: ${Date.now() - perfStart}ms`);
    console.log(`[PERF] Command: ${config.claudeCommand} ${args.join(' ')}`);
  }

  const claudeProcess = spawn(config.claudeCommand, args, {
    cwd: config.workingDir,
    env: { ...process.env },
    stdio: [hasImageAttachments ? 'pipe' : 'ignore', 'pipe', 'pipe']
  });

  if (hasImageAttachments && claudeProcess.stdin) {
    const multimodalMessage = buildMultimodalMessage(prompt, config.imageAttachments!);
    claudeProcess.stdin.write(multimodalMessage);
    claudeProcess.stdin.end();
  }

  if (claudeProcess.pid) {
    runningProcesses.set(claudeProcess.pid, claudeProcess);
  }

  if (config.verbose) {
    console.log(`[PERF] Spawned: ${Date.now() - perfStart}ms`);
  }

  let stdout = '';
  let stderr = '';
  let thinkingBuffer = '';
  let firstStdoutReceived = false;
  let errorAlreadySurfaced = false;

  const sessionCapture: { claudeSessionId?: string } = {};
  const ctx: StreamHandlerContext = {
    config,
    accumulatedAssistantResponse: '',
    accumulatedThinking: '',
    accumulatedToolUse: [],
    toolInputBuffers: new Map(),
  };

  // Stall detection state
  let lastActivityTime = Date.now();
  let stallWarningEmitted = false;
  let assessmentInProgress = false;
  let extensionsGranted = 0;
  let currentKillDeadline = Date.now() + (config.stallKillMs ?? 1_800_000);

  // Tool activity tracking for stall assessment context
  let lastToolName: string | undefined;
  let lastToolInputSummary: string | undefined;
  let pendingToolCount = 0;
  let totalToolCalls = 0;

  // Wrap the existing tool handlers to track activity
  const origToolUseCallback = config.toolUseCallback;
  config.toolUseCallback = (event) => {
    if (event.type === 'tool_start' && event.toolName) {
      lastToolName = event.toolName;
      pendingToolCount++;
      totalToolCalls++;
    } else if (event.type === 'tool_complete' && event.completeInput) {
      lastToolInputSummary = summarizeToolInput(event.completeInput);
    } else if (event.type === 'tool_result') {
      pendingToolCount = Math.max(0, pendingToolCount - 1);
    }
    origToolUseCallback?.(event);
  };

  claudeProcess.stdout!.on('data', (data) => {
    lastActivityTime = Date.now();
    stallWarningEmitted = false;
    // Push kill deadline forward on any activity
    const killMs = config.stallKillMs ?? 1_800_000;
    currentKillDeadline = Date.now() + killMs;

    if (!firstStdoutReceived) {
      firstStdoutReceived = true;
      if (config.verbose) {
        console.log(`[PERF] First stdout data: ${Date.now() - perfStart}ms`);
      }
    }

    const chunk = data.toString();
    stdout += chunk;

    if (useStreamJson) {
      thinkingBuffer = processStreamLines(thinkingBuffer + chunk, sessionCapture, ctx);
    }
  });

  claudeProcess.stderr!.on('data', async (data) => {
    const chunk = data.toString();
    stderr += chunk;

    if (errorAlreadySurfaced) return;

    const error = detectErrorInStderr(stderr);
    if (error) {
      errorAlreadySurfaced = true;
      if (config.outputCallback) {
        config.outputCallback(`\n[[MSTRO_ERROR:${error.errorCode}]] ${error.message}\n`);
      }
    }
  });

  // Stall detection with intelligent assessment
  const stallWarningMs = config.stallWarningMs ?? 300_000;
  const stallHardCapMs = config.stallHardCapMs ?? 3_600_000;
  const maxExtensions = config.stallMaxExtensions ?? 3;
  const stallAssessEnabled = config.stallAssessEnabled !== false;

  const stallCheckInterval = setInterval(async () => {
    const now = Date.now();
    const silenceMs = now - lastActivityTime;
    const totalElapsed = now - perfStart;

    // Hard cap: absolute wall-clock limit regardless of extensions
    if (totalElapsed >= stallHardCapMs) {
      terminateStallProcess(claudeProcess, stallCheckInterval, config,
        `\n[[MSTRO_ERROR:EXECUTION_STALLED]] Hard time limit reached (${Math.round(stallHardCapMs / 60000)} min total). Terminating process.\n`
      );
      return;
    }

    // Kill deadline reached
    if (now >= currentKillDeadline) {
      terminateStallProcess(claudeProcess, stallCheckInterval, config,
        `\n[[MSTRO_ERROR:EXECUTION_STALLED]] No output for ${Math.round(silenceMs / 60_000)} minutes. Terminating process.\n`
      );
      return;
    }

    // Warning + assessment trigger
    if (silenceMs < stallWarningMs || stallWarningEmitted) return;

    stallWarningEmitted = true;
    const killIn = Math.round((currentKillDeadline - now) / 60_000);
    config.outputCallback?.(
      `\n[[MSTRO_ERROR:EXECUTION_STALLED]] No output for ${Math.round(silenceMs / 60_000)} minutes. Will terminate in ${killIn} minutes if no activity.\n`
    );

    // Run stall assessment if enabled and we haven't exhausted extensions
    if (!stallAssessEnabled || assessmentInProgress || extensionsGranted >= maxExtensions) return;

    assessmentInProgress = true;
    const stallCtx: StallContext = {
      originalPrompt: prompt,
      silenceMs,
      lastToolName,
      lastToolInputSummary,
      pendingToolCount,
      totalToolCalls,
      elapsedTotalMs: totalElapsed,
    };

    const result = await runStallAssessment({ stallCtx, config, now, extensionsGranted, maxExtensions });
    if (result) {
      extensionsGranted = result.extensionsGranted;
      currentKillDeadline = result.currentKillDeadline;
      stallWarningEmitted = false; // Allow re-warning after extension
    }
    assessmentInProgress = false;
  }, 10_000);

  return new Promise((resolve, reject) => {
    claudeProcess.on('close', (code) => {
      clearInterval(stallCheckInterval);
      if (claudeProcess.pid) {
        runningProcesses.delete(claudeProcess.pid);
      }
      resolve({
        output: stdout,
        error: stderr || undefined,
        exitCode: code || 0,
        assistantResponse: ctx.accumulatedAssistantResponse || undefined,
        thinkingOutput: ctx.accumulatedThinking || undefined,
        toolUseHistory: ctx.accumulatedToolUse.length > 0 ? ctx.accumulatedToolUse : undefined,
        claudeSessionId: sessionCapture.claudeSessionId
      });
    });

    claudeProcess.on('error', (error: NodeJS.ErrnoException) => {
      clearInterval(stallCheckInterval);
      if (claudeProcess.pid) {
        runningProcesses.delete(claudeProcess.pid);
      }
      handleSpawnError(error, config, reject);
    });
  });
}
