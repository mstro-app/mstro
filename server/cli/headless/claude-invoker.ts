// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Claude Invoker
 *
 * Handles spawning and managing Claude CLI processes.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { sanitizeEnvForSandbox } from '../../services/sandbox-utils.js';
import { generateMcpConfig } from './mcp-config.js';
import { detectErrorInStderr, } from './output-utils.js';
import { buildMultimodalMessage } from './prompt-utils.js';
import { killProcessGroup } from './runner.js';
import { assessStall, assessToolTimeout, classifyError, type StallContext } from './stall-assessor.js';
import { ToolWatchdog } from './tool-watchdog.js';
import type {
  ExecutionResult,
  ResolvedHeadlessConfig,
  ToolUseAccumulator,
  ToolUseEvent,
} from './types.js';

/** Parsed JSON from Claude CLI stream — structure varies by event type */
// biome-ignore lint/suspicious/noExplicitAny: external CLI stream JSON with heterogeneous shapes
type StreamJson = any;

export interface ClaudeInvokerOptions {
  config: ResolvedHeadlessConfig;
  runningProcesses: Map<number, ChildProcess>;
}

// ========== Signal Helpers ==========

/** Map a Node.js signal name to its numeric value for exit code computation */
function signalToNumber(signal: string): number | undefined {
  const map: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6,
    SIGKILL: 9, SIGTERM: 15, SIGUSR1: 10, SIGUSR2: 12,
  };
  return map[signal];
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
  if (claudeProcess.pid) killProcessGroup(claudeProcess.pid, 'SIGTERM');
  setTimeout(() => {
    if (!claudeProcess.killed && claudeProcess.pid) {
      killProcessGroup(claudeProcess.pid, 'SIGKILL');
    }
  }, 5000);
}

interface StallAssessmentParams {
  stallCtx: StallContext;
  config: ResolvedHeadlessConfig;
  now: number;
  extensionsGranted: number;
  maxExtensions: number;
  toolWatchdogActive?: boolean;
}

/** Run stall assessment and return updated state if extended, null otherwise */
async function runStallAssessment(
  params: StallAssessmentParams,
): Promise<{ extensionsGranted: number; currentKillDeadline: number } | null> {
  const { stallCtx, config, now, extensionsGranted, maxExtensions, toolWatchdogActive } = params;
  try {
    const verdict = await assessStall(stallCtx, config.claudeCommand, config.verbose, toolWatchdogActive);
    if (verdict.action === 'extend') {
      const newExtensions = extensionsGranted + 1;
      const elapsedMin = Math.round(stallCtx.elapsedTotalMs / 60_000);
      const pendingNames = stallCtx.pendingToolNames ?? new Set<string>();

      // Emit a progress message instead of a scary stall warning.
      // Task subagents get a friendlier message since long silence is expected.
      if (pendingNames.has('Task')) {
        config.outputCallback?.(
          `\n[[MSTRO_STALL_EXTENDED]] Task subagent still running (${elapsedMin} min elapsed). ${verdict.reason}.\n`
        );
      } else {
        config.outputCallback?.(
          `\n[[MSTRO_STALL_EXTENDED]] Process still working (${elapsedMin} min elapsed). ${verdict.reason}. Extension ${newExtensions}/${maxExtensions}.\n`
        );
      }
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

// ========== Native Timeout Detection ==========

/** Regex matching Claude Code's internal tool timeout messages */
const NATIVE_TIMEOUT_PATTERN = /^(\w+) timed out — (continuing|retrying) with (\d+) results? preserved$/;

/** Quick prefix check: does incomplete text look like it might be a timeout?
 *  Matches any capitalized tool name followed by " timed" — no hardcoded set
 *  needed because the full NATIVE_TIMEOUT_PATTERN validates on the next chunk. */
const TIMEOUT_PREFIX_PATTERN = /^[A-Z]\w* timed/;

interface NativeTimeoutEvent {
  toolName: string;
  action: 'continuing' | 'retrying';
  preservedCount: number;
}

/**
 * Detects Claude Code's internal tool timeout messages in the text stream.
 *
 * Buffers text at newline boundaries to detect complete timeout lines.
 * Non-matching text is forwarded immediately to minimize streaming latency.
 */
class NativeTimeoutDetector {
  private lineBuffer = '';
  private detectedTimeouts: NativeTimeoutEvent[] = [];
  /** Text buffered after native timeouts — held back from streaming until context is assessed */
  private postTimeoutBuffer = '';

  /**
   * Process a text_delta chunk.
   * Returns passthrough text (for outputCallback) and any detected timeouts.
   *
   * After the first native timeout is detected, subsequent passthrough text
   * is held in postTimeoutBuffer instead of returned as passthrough. This
   * prevents confused "What were you working on?" responses from streaming
   * to the user before context loss can be assessed.
   */
  processChunk(text: string): { passthrough: string; timeouts: NativeTimeoutEvent[] } {
    const timeouts: NativeTimeoutEvent[] = [];
    let passthrough = '';

    this.lineBuffer += text;

    const lines = this.lineBuffer.split('\n');
    const incomplete = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(NATIVE_TIMEOUT_PATTERN);

      if (match) {
        const event: NativeTimeoutEvent = {
          toolName: match[1],
          action: match[2] as 'continuing' | 'retrying',
          preservedCount: parseInt(match[3], 10),
        };
        timeouts.push(event);
        this.detectedTimeouts.push(event);
        // Suppress this line from passthrough — replaced by structured marker
      } else {
        passthrough += `${line}\n`;
      }
    }

    // Handle incomplete trailing text
    if (incomplete) {
      if (TIMEOUT_PREFIX_PATTERN.test(incomplete)) {
        // Looks like the start of a timeout message — hold it
        this.lineBuffer = incomplete;
      } else {
        passthrough += incomplete;
        this.lineBuffer = '';
      }
    } else {
      this.lineBuffer = '';
    }

    // After native timeouts, buffer passthrough text instead of returning it.
    // The session manager will assess context loss and either flush or discard.
    if (this.detectedTimeouts.length > 0 && passthrough) {
      this.postTimeoutBuffer += passthrough;
      passthrough = '';
    }

    return { passthrough, timeouts };
  }

  /** Flush any held buffer (call on stream end).
   *  Also checks remaining buffer for timeout patterns so the last
   *  timeout message (without trailing newline) is always counted.
   */
  flush(): string {
    const remaining = this.lineBuffer;
    this.lineBuffer = '';

    // Check if the unflushed buffer IS a timeout message
    if (remaining) {
      const trimmed = remaining.trim();
      const match = trimmed.match(NATIVE_TIMEOUT_PATTERN);
      if (match) {
        this.detectedTimeouts.push({
          toolName: match[1],
          action: match[2] as 'continuing' | 'retrying',
          preservedCount: parseInt(match[3], 10),
        });
        // Return empty — this was a timeout message, not user-visible text
        return '';
      }
    }

    return remaining;
  }

  /** Get count of detected timeouts */
  get timeoutCount(): number {
    return this.detectedTimeouts.length;
  }

  /** Get buffered post-timeout text (for session manager to flush or discard) */
  get bufferedPostTimeoutOutput(): string {
    return this.postTimeoutBuffer;
  }
}

// ========== Stream Event Handlers ==========

interface StreamHandlerContext {
  config: ResolvedHeadlessConfig;
  accumulatedAssistantResponse: string;
  accumulatedThinking: string;
  accumulatedToolUse: ToolUseAccumulator[];
  toolInputBuffers: Map<number, { name: string; id: string; inputJson: string; startTime: number }>;
  nativeTimeoutDetector: NativeTimeoutDetector;
  /** When true, assistant text is buffered instead of forwarded to outputCallback.
   *  Active during resume mode until thinking/tool activity confirms Claude has context. */
  resumeAssessmentActive: boolean;
  /** Buffered assistant text during resume assessment */
  resumeAssessmentBuffer: string;
  /** Cumulative API token usage from message_start/message_delta events */
  apiTokenUsage: { inputTokens: number; outputTokens: number };
  /** Tracks cumulative output_tokens within the current step (message_delta is cumulative per-step) */
  currentStepOutputTokens: number;
  /** Timestamp of the last token usage change (tokens still flowing = process alive) */
  lastTokenActivityTime: number;
  /** Claude Code result event stop_reason (e.g., 'end_turn', 'max_tokens') */
  stopReason?: string;
}

function handleSessionCapture(
  parsed: StreamJson,
  captured: { claudeSessionId?: string }
): void {
  if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
    captured.claudeSessionId = parsed.session_id;
  }
  if (parsed.type === 'result' && parsed.session_id && !captured.claudeSessionId) {
    captured.claudeSessionId = parsed.session_id;
  }
}

function handleThinkingDelta(event: StreamJson, ctx: StreamHandlerContext): string {
  if (
    event.type !== 'content_block_delta' ||
    event.delta?.type !== 'thinking_delta' ||
    !event.delta?.thinking
  ) {
    return ctx.accumulatedThinking;
  }

  // Thinking activity confirms Claude has context — flush resume buffer
  if (ctx.resumeAssessmentActive) {
    ctx.resumeAssessmentActive = false;
    if (ctx.resumeAssessmentBuffer) {
      ctx.config.outputCallback?.(ctx.resumeAssessmentBuffer);
      ctx.resumeAssessmentBuffer = '';
    }
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

function handleTextDelta(event: StreamJson, ctx: StreamHandlerContext): string {
  if (
    event.type !== 'content_block_delta' ||
    event.delta?.type !== 'text_delta' ||
    !event.delta?.text
  ) {
    return ctx.accumulatedAssistantResponse;
  }

  const text = event.delta.text;

  // Always accumulate raw text for checkpoint context
  const updated = ctx.accumulatedAssistantResponse + text;

  // Route through native timeout detector to intercept Claude Code's internal timeout messages
  const { passthrough, timeouts } = ctx.nativeTimeoutDetector.processChunk(text);

  // Emit structured markers for detected native timeouts
  for (const timeout of timeouts) {
    ctx.config.outputCallback?.(
      `\n[[MSTRO_NATIVE_TIMEOUT]] ${timeout.toolName} timed out \u2014 ${timeout.action} with ${timeout.preservedCount} results preserved\n`
    );
  }

  // When resume assessment is active, buffer text instead of forwarding.
  // This prevents confused "What were you working on?" responses from streaming
  // to the user before we can assess whether Claude retained context.
  if (ctx.resumeAssessmentActive) {
    if (passthrough) {
      ctx.resumeAssessmentBuffer += passthrough;
    }
    return updated;
  }

  // Forward non-timeout text to output
  if (passthrough && ctx.config.outputCallback) {
    ctx.config.outputCallback(passthrough);
  }

  return updated;
}

function handleToolStart(event: StreamJson, ctx: StreamHandlerContext): void {
  if (
    event.type !== 'content_block_start' ||
    event.content_block?.type !== 'tool_use'
  ) {
    return;
  }

  // Tool activity confirms Claude has context — flush resume buffer
  if (ctx.resumeAssessmentActive) {
    ctx.resumeAssessmentActive = false;
    if (ctx.resumeAssessmentBuffer) {
      ctx.config.outputCallback?.(ctx.resumeAssessmentBuffer);
      ctx.resumeAssessmentBuffer = '';
    }
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

function handleToolInputDelta(event: StreamJson, ctx: StreamHandlerContext): void {
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

function handleToolComplete(event: StreamJson, ctx: StreamHandlerContext): void {
  if (event.type !== 'content_block_stop') {
    return;
  }

  const index = event.index;
  const toolBuffer = ctx.toolInputBuffers.get(index);
  if (!toolBuffer) {
    return;
  }

  let completeInput: Record<string, unknown> = {};
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

  // Clean up the input buffer — it's no longer needed after accumulation
  ctx.toolInputBuffers.delete(index);

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

/** Accumulate input tokens from a message_start event. Returns true if any tokens were added. */
function handleMessageStartTokens(event: StreamJson, ctx: StreamHandlerContext): boolean {
  if (event.type !== 'message_start' || !event.message?.usage) return false;
  const usage = event.message.usage;
  ctx.currentStepOutputTokens = 0;
  let changed = false;
  if (typeof usage.input_tokens === 'number') {
    ctx.apiTokenUsage.inputTokens += usage.input_tokens;
    changed = true;
  }
  if (typeof usage.cache_creation_input_tokens === 'number') {
    ctx.apiTokenUsage.inputTokens += usage.cache_creation_input_tokens;
    changed = true;
  }
  if (typeof usage.cache_read_input_tokens === 'number') {
    ctx.apiTokenUsage.inputTokens += usage.cache_read_input_tokens;
    changed = true;
  }
  verboseLog(ctx.config.verbose,
    `[TOKENS] message_start: input=${usage.input_tokens ?? 0} cache_create=${usage.cache_creation_input_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0} → total_input=${ctx.apiTokenUsage.inputTokens}`);
  return changed;
}

/** Accumulate output tokens from a message_delta event. Returns true if any tokens were added.
 * message_delta carries CUMULATIVE output token count for the current step.
 * Per Anthropic docs: "The token counts shown in the usage field of the
 * message_delta event are cumulative" and there can be "one or more message_delta
 * events" per message. We track the delta from the previous value to avoid
 * double-counting when multiple message_delta events fire per step. */
function handleMessageDeltaTokens(event: StreamJson, ctx: StreamHandlerContext): boolean {
  if (event.type !== 'message_delta' || !event.usage) return false;
  if (typeof event.usage.output_tokens !== 'number') return false;
  const increment = event.usage.output_tokens - ctx.currentStepOutputTokens;
  verboseLog(ctx.config.verbose,
    `[TOKENS] message_delta: output=${event.usage.output_tokens} (step_prev=${ctx.currentStepOutputTokens} increment=${increment}) → total_output=${ctx.apiTokenUsage.outputTokens + Math.max(increment, 0)}`);
  if (increment <= 0) return false;
  ctx.apiTokenUsage.outputTokens += increment;
  ctx.currentStepOutputTokens = event.usage.output_tokens;
  return true;
}

function handleTokenUsage(event: StreamJson, ctx: StreamHandlerContext): void {
  const changed = handleMessageStartTokens(event, ctx) || handleMessageDeltaTokens(event, ctx);
  if (changed) {
    ctx.lastTokenActivityTime = Date.now();
    ctx.config.tokenUsageCallback?.({ ...ctx.apiTokenUsage });
  }
}

/**
 * Extract definitive token usage from the result event emitted at the end of a Claude session.
 * The result event's `usage` field contains the authoritative total — it overrides any
 * accumulated stream-based counts which may be incomplete (e.g., when extended thinking
 * suppresses stream_event emissions).
 */
function handleResultTokenUsage(parsed: StreamJson, ctx: StreamHandlerContext): void {
  if (!parsed.usage) return;
  const u = parsed.usage;
  const input = (typeof u.input_tokens === 'number' ? u.input_tokens : 0)
    + (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0)
    + (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0);
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;

  if (input > 0 || output > 0) {
    verboseLog(ctx.config.verbose,
      `[TOKENS] Result event usage: input=${input} output=${output} ` +
      `(stream accumulated: input=${ctx.apiTokenUsage.inputTokens} output=${ctx.apiTokenUsage.outputTokens})`);
    // Replace with authoritative counts from the result event
    ctx.apiTokenUsage = { inputTokens: input, outputTokens: output };
    ctx.lastTokenActivityTime = Date.now();
    ctx.config.tokenUsageCallback?.({ ...ctx.apiTokenUsage });
  }
}

function handleToolResult(parsed: StreamJson, ctx: StreamHandlerContext): void {
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

function processStreamEvent(parsed: StreamJson, ctx: StreamHandlerContext): void {
  // Handle error events from Claude CLI (API errors, model errors, etc.)
  if (parsed.type === 'error') {
    const errorMessage = parsed.error?.message || parsed.message || JSON.stringify(parsed);
    ctx.config.outputCallback?.(`\n[[MSTRO_ERROR:CLAUDE_ERROR]] ${errorMessage}\n`);
    return;
  }

  // Handle result events — extract definitive token usage, stop_reason, and surface errors
  if (parsed.type === 'result') {
    handleResultTokenUsage(parsed, ctx);
    if (parsed.stop_reason) {
      ctx.stopReason = parsed.stop_reason;
    }
    if (parsed.is_error) {
      const errorMessage = parsed.error || parsed.result || 'Unknown error in result';
      ctx.config.outputCallback?.(`\n[[MSTRO_ERROR:CLAUDE_RESULT_ERROR]] ${errorMessage}\n`);
      return;
    }
  }

  if (parsed.type === 'stream_event' && parsed.event) {
    const event = parsed.event;
    ctx.accumulatedThinking = handleThinkingDelta(event, ctx);
    ctx.accumulatedAssistantResponse = handleTextDelta(event, ctx);
    handleToolStart(event, ctx);
    handleToolInputDelta(event, ctx);
    handleToolComplete(event, ctx);
    handleTokenUsage(event, ctx);
  }
  handleToolResult(parsed, ctx);
}

// ========== Close Handler Helpers ==========

/** Flush native timeout detector buffers and return post-timeout output if any */
function flushNativeTimeoutBuffers(ctx: StreamHandlerContext): string | undefined {
  const remaining = ctx.nativeTimeoutDetector.flush();
  const buffered = ctx.nativeTimeoutDetector.bufferedPostTimeoutOutput;
  const postTimeout = (buffered + remaining) || undefined;

  // Only flush remaining text if there were no native timeouts
  // (when there are timeouts, the session manager decides what to show)
  if (!postTimeout && remaining) {
    ctx.config.outputCallback?.(remaining);
  }

  return postTimeout;
}

/** Classify unmatched stderr via Haiku when process exits with error */
async function classifyUnmatchedStderr(
  stderr: string,
  errorAlreadySurfaced: boolean,
  code: number | null,
  config: ResolvedHeadlessConfig,
): Promise<void> {
  if (!stderr || errorAlreadySurfaced || code === 0) return;

  try {
    const classified = await classifyError(stderr, config.claudeCommand, config.verbose);
    if (classified) {
      config.outputCallback?.(`\n[[MSTRO_ERROR:${classified.errorCode}]] ${classified.message}\n`);
    }
  } catch {
    // Haiku classification failed — proceed without it
  }
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

/** Write image attachments to the Claude process stdin as stream-json */
function writeImageAttachmentsToStdin(
  claudeProcess: ChildProcess,
  prompt: string,
  config: ResolvedHeadlessConfig,
): void {
  claudeProcess.stdin!.on('error', (err) => {
    if (config.verbose) {
      console.error('[STDIN] Write error:', err.message);
    }
    config.outputCallback?.(`\n[[MSTRO_ERROR:STDIN_WRITE_FAILED]] Failed to send image data to Claude: ${err.message}\n`);
  });
  const multimodalMessage = buildMultimodalMessage(prompt, config.imageAttachments!);
  claudeProcess.stdin!.write(multimodalMessage);
  claudeProcess.stdin!.end();
}

/** Mutable state for stall detection, shared between the interval callback and the outer function */
interface StallState {
  lastActivityTime: number;
  stallWarningEmitted: boolean;
  assessmentInProgress: boolean;
  extensionsGranted: number;
  currentKillDeadline: number;
  nextWarningAfter: number;
}

/** Run a single stall-check tick. Extracted to reduce cognitive complexity of executeClaudeCommand. */
async function runStallCheckTick(
  state: StallState,
  opts: {
    perfStart: number;
    stallWarningMs: number;
    stallHardCapMs: number;
    maxExtensions: number;
    stallAssessEnabled: boolean;
    toolWatchdogActive: boolean;
    prompt: string;
    pendingTools: Map<string, string>;
    lastToolInputSummary: string | undefined;
    totalToolCalls: number;
    claudeProcess: ChildProcess;
    stallCheckInterval: ReturnType<typeof setInterval>;
    config: ResolvedHeadlessConfig;
    lastTokenActivityTime: number;
  },
): Promise<void> {
  const now = Date.now();
  const silenceMs = now - state.lastActivityTime;
  const totalElapsed = now - opts.perfStart;
  const tokenSilenceMs = now - opts.lastTokenActivityTime;

  if (totalElapsed >= opts.stallHardCapMs) {
    terminateStallProcess(opts.claudeProcess, opts.stallCheckInterval, opts.config,
      `\n[[MSTRO_ERROR:EXECUTION_STALLED]] Hard time limit reached (${Math.round(opts.stallHardCapMs / 60000)} min total). Terminating process.\n`
    );
    return;
  }

  // Token activity pushes the kill deadline forward — tokens flowing means
  // the process is alive even if stdout is silent (e.g. silent thinking).
  if (tokenSilenceMs < 60_000 && now < state.currentKillDeadline) {
    const killMs = opts.config.stallKillMs ?? 1_800_000;
    state.currentKillDeadline = Math.max(state.currentKillDeadline, now + killMs);
  }

  if (now >= state.currentKillDeadline) {
    terminateStallProcess(opts.claudeProcess, opts.stallCheckInterval, opts.config,
      `\n[[MSTRO_ERROR:EXECUTION_STALLED]] No output for ${Math.round(silenceMs / 60_000)} minutes. Terminating process.\n`
    );
    return;
  }

  if (silenceMs < opts.stallWarningMs || state.stallWarningEmitted || now < state.nextWarningAfter || state.assessmentInProgress) return;

  const stallCtx: StallContext = {
    originalPrompt: opts.prompt,
    silenceMs,
    lastToolName: opts.pendingTools.size > 0 ? Array.from(opts.pendingTools.values()).pop() : undefined,
    lastToolInputSummary: opts.lastToolInputSummary,
    pendingToolCount: opts.pendingTools.size,
    pendingToolNames: new Set(opts.pendingTools.values()),
    totalToolCalls: opts.totalToolCalls,
    elapsedTotalMs: totalElapsed,
    tokenSilenceMs,
  };

  if (opts.stallAssessEnabled && state.extensionsGranted < opts.maxExtensions) {
    state.assessmentInProgress = true;
    const result = await runStallAssessment({ stallCtx, config: opts.config, now, extensionsGranted: state.extensionsGranted, maxExtensions: opts.maxExtensions, toolWatchdogActive: opts.toolWatchdogActive });
    state.assessmentInProgress = false;

    if (result) {
      state.extensionsGranted = result.extensionsGranted;
      state.currentKillDeadline = result.currentKillDeadline;
      state.nextWarningAfter = now + opts.stallWarningMs;
      return;
    }
  }

  state.stallWarningEmitted = true;
  const killIn = Math.round((state.currentKillDeadline - now) / 60_000);
  opts.config.outputCallback?.(
    `\n[[MSTRO_ERROR:EXECUTION_STALLED]] No output for ${Math.round(silenceMs / 60_000)} minutes. Will terminate in ${killIn} minutes if no activity.\n`
  );
}

// ========== Tool Tracking Setup ==========

/** Shared mutable state for tool event handlers */
interface ToolTrackingState {
  pendingTools: Map<string, string>;
  counters: { lastToolInputSummary: string | undefined; totalToolCalls: number };
  toolIdToName: Map<string, string>;
  toolIdToInput: Map<string, Record<string, unknown>>;
  watchdog: ToolWatchdog | null;
  stallState: StallState;
  ctx: StreamHandlerContext;
  onTimeout: (hungToolId: string) => void;
}

interface ToolTrackingResult {
  pendingTools: Map<string, string>;
  watchdog: ToolWatchdog | null;
  toolWatchdogActive: boolean;
  counters: { lastToolInputSummary: string | undefined; totalToolCalls: number };
  /** Must be called after stallCheckInterval is created, to wire up the kill handler */
  setKillContext: (claudeProcess: ChildProcess, stallCheckInterval: ReturnType<typeof setInterval>) => void;
}

/** Handle tool_start events. Extracted to reduce cognitive complexity. */
function onToolStart(event: ToolUseEvent, s: ToolTrackingState): void {
  const id = event.toolId!;
  s.pendingTools.set(id, event.toolName!);
  s.counters.totalToolCalls++;
  s.toolIdToName.set(id, event.toolName!);
  if (s.watchdog) {
    s.watchdog.startWatch(id, event.toolName!, {}, () => { s.onTimeout(id); });
  }
}

/** Handle tool_complete events. Extracted to reduce cognitive complexity. */
function onToolComplete(event: ToolUseEvent, s: ToolTrackingState): void {
  const id = event.toolId!;
  const input = event.completeInput ?? {};
  s.counters.lastToolInputSummary = summarizeToolInput(input);
  s.toolIdToInput.set(id, input);
  if (!s.watchdog) return;
  const toolName = s.toolIdToName.get(id);
  if (toolName) {
    s.watchdog.startWatch(id, toolName, input, () => { s.onTimeout(id); });
  }
}

/** Handle tool_result events. Extracted to reduce cognitive complexity. */
function onToolResult(event: ToolUseEvent, s: ToolTrackingState): void {
  const id = event.toolId!;
  s.pendingTools.delete(id);
  s.stallState.stallWarningEmitted = false;
  s.stallState.lastActivityTime = Date.now();
  const toolEntry = s.ctx.accumulatedToolUse.find(t => t.toolId === id);
  if (!s.watchdog || !toolEntry) return;
  const toolName = s.toolIdToName.get(id);
  if (toolName && toolEntry.duration) {
    s.watchdog.recordCompletion(toolName, toolEntry.duration);
  }
  s.watchdog.clearWatch(id);
}

/** Resolve a display URL from tool input for timeout messages */
function resolveToolUrl(toolInput: Record<string, unknown>): string | undefined {
  if (toolInput.url) return String(toolInput.url);
  if (toolInput.query) return String(toolInput.query);
  return undefined;
}

/** Handle a tool timeout by building a checkpoint and killing the process. */
function executeToolTimeout(
  hungToolId: string,
  watchdog: ToolWatchdog,
  killCtx: { claudeProcess: ChildProcess; stallCheckInterval: ReturnType<typeof setInterval> },
  s: ToolTrackingState,
  config: ResolvedHeadlessConfig,
  prompt: string,
  sessionCapture: { claudeSessionId?: string },
  perfStart: number,
): void {
  const checkpoint = watchdog.buildCheckpoint(
    prompt, s.ctx.accumulatedAssistantResponse, s.ctx.accumulatedThinking,
    s.ctx.accumulatedToolUse, hungToolId, sessionCapture.claudeSessionId, perfStart,
  );

  const toolName = s.toolIdToName.get(hungToolId) || 'unknown';
  const toolInput = s.toolIdToInput.get(hungToolId) || {};
  const timeoutMs = watchdog.getTimeout(toolName);
  const url = resolveToolUrl(toolInput);

  config.outputCallback?.(
    `\n[[MSTRO_TOOL_TIMEOUT]] ${toolName} timed out after ${Math.round(timeoutMs / 1000)}s${url ? ` fetching: ${url.slice(0, 100)}` : ''}. ${s.ctx.accumulatedToolUse.filter(t => t.result !== undefined).length} completed results preserved.\n`
  );

  if (checkpoint) {
    config.onToolTimeout?.(checkpoint);
  }

  verboseLog(config.verbose, `[WATCHDOG] Killing process due to ${toolName} timeout`);
  watchdog.clearAll();
  clearInterval(killCtx.stallCheckInterval);
  if (killCtx.claudeProcess.pid) killProcessGroup(killCtx.claudeProcess.pid, 'SIGTERM');
  const proc = killCtx.claudeProcess;
  setTimeout(() => { if (!proc.killed && proc.pid) killProcessGroup(proc.pid, 'SIGKILL'); }, 5000);
}

/** Set up tool activity tracking and watchdog. Extracted to reduce cognitive complexity. */
function setupToolTracking(
  config: ResolvedHeadlessConfig,
  stallState: StallState,
  ctx: StreamHandlerContext,
  sessionCapture: { claudeSessionId?: string },
  prompt: string,
  perfStart: number,
): ToolTrackingResult {
  const pendingTools = new Map<string, string>();
  const counters = { lastToolInputSummary: undefined as string | undefined, totalToolCalls: 0 };

  const toolWatchdogActive = config.enableToolWatchdog !== false;
  const watchdog = toolWatchdogActive
    ? new ToolWatchdog({
        profiles: config.toolTimeoutProfiles,
        verbose: config.verbose,
        onTiebreaker: async (toolName, toolInput, elapsedMs, tokenSilenceMs) => {
          return assessToolTimeout(toolName, toolInput, elapsedMs, config.claudeCommand, config.verbose, tokenSilenceMs);
        },
        getTokenSilenceMs: () => {
          const last = ctx.lastTokenActivityTime;
          return last > 0 ? Date.now() - last : undefined;
        },
      })
    : null;

  // Deferred kill context — set after stallCheckInterval is created
  let killCtx: { claudeProcess: ChildProcess; stallCheckInterval: ReturnType<typeof setInterval> } | null = null;

  const trackingState: ToolTrackingState = {
    pendingTools, counters,
    toolIdToName: new Map(), toolIdToInput: new Map(),
    watchdog, stallState, ctx,
    onTimeout: (hungToolId) => {
      if (!watchdog || !killCtx) return;
      executeToolTimeout(hungToolId, watchdog, killCtx, trackingState, config, prompt, sessionCapture, perfStart);
    },
  };

  const origToolUseCallback = config.toolUseCallback;

  config.toolUseCallback = (event) => {
    if (event.type === 'tool_start' && event.toolName && event.toolId) {
      onToolStart(event, trackingState);
    } else if (event.type === 'tool_complete' && event.completeInput && event.toolId) {
      onToolComplete(event, trackingState);
    } else if (event.type === 'tool_result' && event.toolId) {
      onToolResult(event, trackingState);
    }
    origToolUseCallback?.(event);
  };

  return {
    pendingTools, watchdog, toolWatchdogActive, counters,
    setKillContext: (claudeProcess, stallCheckInterval) => {
      killCtx = { claudeProcess, stallCheckInterval };
    },
  };
}

/** Log messages when verbose mode is enabled. Extracted to reduce cognitive complexity. */
function verboseLog(verbose: boolean | undefined, ...msgs: string[]): void {
  if (verbose) {
    for (const msg of msgs) console.log(msg);
  }
}

/** Spawn the Claude CLI process and register it. Extracted to reduce cognitive complexity. */
function spawnAndRegister(
  config: ResolvedHeadlessConfig,
  prompt: string,
  hasImageAttachments: boolean,
  useStreamJson: boolean,
  runningProcesses: Map<number, ChildProcess>,
  perfStart: number,
): ChildProcess {
  const mcpConfigPath = generateMcpConfig(config.workingDir, config.verbose);

  if (!mcpConfigPath && config.outputCallback) {
    config.outputCallback(
      '\n[[MSTRO_ERROR:BOUNCER_UNAVAILABLE]] Security bouncer not available. Running with limited permissions — file edits allowed, but shell commands may be restricted.\n'
    );
  }

  const args = buildClaudeArgs(config, prompt, hasImageAttachments, useStreamJson, mcpConfigPath);

  verboseLog(config.verbose,
    `[PERF] About to spawn: ${Date.now() - perfStart}ms`,
    `[PERF] Command: ${config.claudeCommand} ${args.join(' ')}`,
  );

  const baseEnv = config.sandboxed
    ? sanitizeEnvForSandbox(process.env, config.workingDir)
    : { ...process.env };
  const spawnEnv = config.extraEnv
    ? { ...baseEnv, ...config.extraEnv }
    : baseEnv;

  const claudeProcess = spawn(config.claudeCommand, args, {
    cwd: config.workingDir,
    detached: true,
    env: spawnEnv,
    stdio: [hasImageAttachments ? 'pipe' : 'ignore', 'pipe', 'pipe']
  });

  if (hasImageAttachments && claudeProcess.stdin) {
    writeImageAttachmentsToStdin(claudeProcess, prompt, config);
  }

  if (claudeProcess.pid) {
    runningProcesses.set(claudeProcess.pid, claudeProcess);
  }

  verboseLog(config.verbose, `[PERF] Spawned: ${Date.now() - perfStart}ms`);

  return claudeProcess;
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
  verboseLog(config.verbose, `[PERF] executeMovement started`);

  const hasImageAttachments = config.imageAttachments && config.imageAttachments.length > 0;
  const useStreamJson = hasImageAttachments || config.thinkingCallback || config.outputCallback || config.toolUseCallback;

  const claudeProcess = spawnAndRegister(config, prompt, !!hasImageAttachments, !!useStreamJson, runningProcesses, perfStart);

  let stdout = '';
  let stderr = '';
  let thinkingBuffer = '';
  let firstStdoutReceived = false;
  let errorAlreadySurfaced = false;

  const sessionCapture: { claudeSessionId?: string } = {};
  // Activate resume assessment buffering when resuming a session.
  // Text is held until thinking/tool activity confirms Claude has context.
  const isResumeMode = !!(config.continueSession && config.claudeSessionId);

  const ctx: StreamHandlerContext = {
    config,
    accumulatedAssistantResponse: '',
    accumulatedThinking: '',
    accumulatedToolUse: [],
    toolInputBuffers: new Map(),
    nativeTimeoutDetector: new NativeTimeoutDetector(),
    resumeAssessmentActive: isResumeMode,
    resumeAssessmentBuffer: '',
    apiTokenUsage: { inputTokens: 0, outputTokens: 0 },
    currentStepOutputTokens: 0,
    lastTokenActivityTime: Date.now(),
  };

  // Stall detection state (mutable object shared with runStallCheckTick)
  const stallState: StallState = {
    lastActivityTime: Date.now(),
    stallWarningEmitted: false,
    assessmentInProgress: false,
    extensionsGranted: 0,
    currentKillDeadline: Date.now() + (config.stallKillMs ?? 1_800_000),
    nextWarningAfter: 0,
  };

  // Tool activity tracking for stall assessment context
  const toolTracking = setupToolTracking(config, stallState, ctx, sessionCapture, prompt, perfStart);
  const { pendingTools, watchdog, toolWatchdogActive } = toolTracking;
  // Mutable counters accessed by stall check tick
  const toolCounters = toolTracking.counters;

  claudeProcess.stdout!.on('data', (data) => {
    stallState.lastActivityTime = Date.now();
    stallState.stallWarningEmitted = false;
    stallState.nextWarningAfter = 0; // Real activity resets throttle
    // Push kill deadline forward on any activity
    const killMs = config.stallKillMs ?? 1_800_000;
    stallState.currentKillDeadline = Date.now() + killMs;

    if (!firstStdoutReceived) {
      firstStdoutReceived = true;
      verboseLog(config.verbose, `[PERF] First stdout data: ${Date.now() - perfStart}ms`);
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

  // eslint-disable-next-line prefer-const
  let stallCheckInterval: ReturnType<typeof setInterval>;
  stallCheckInterval = setInterval(() => {
    runStallCheckTick(stallState, {
      perfStart, stallWarningMs, stallHardCapMs, maxExtensions, stallAssessEnabled,
      toolWatchdogActive, prompt, pendingTools, lastToolInputSummary: toolCounters.lastToolInputSummary, totalToolCalls: toolCounters.totalToolCalls,
      claudeProcess, stallCheckInterval, config, lastTokenActivityTime: ctx.lastTokenActivityTime,
    });
  }, 10_000);

  // Wire up the kill context now that stallCheckInterval exists
  toolTracking.setKillContext(claudeProcess, stallCheckInterval);

  return new Promise((resolve, reject) => {
    claudeProcess.on('close', async (code, signal) => {
      clearInterval(stallCheckInterval);
      watchdog?.clearAll();
      await classifyUnmatchedStderr(stderr, errorAlreadySurfaced, code, config);
      if (claudeProcess.pid) runningProcesses.delete(claudeProcess.pid);
      resolve(buildCloseResult(ctx, stdout, stderr, code, signal, sessionCapture));
    });

    claudeProcess.on('error', (error: NodeJS.ErrnoException) => {
      clearInterval(stallCheckInterval);
      watchdog?.clearAll();
      if (claudeProcess.pid) runningProcesses.delete(claudeProcess.pid);
      handleSpawnError(error, config, reject);
    });
  });
}

function buildCloseResult(
  ctx: StreamHandlerContext,
  stdout: string,
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  sessionCapture: { claudeSessionId?: string },
): ExecutionResult {
  const postTimeout = flushNativeTimeoutBuffers(ctx);
  const resumeBuffered = ctx.resumeAssessmentActive ? (ctx.resumeAssessmentBuffer || undefined) : undefined;
  const exitCode = code ?? (signal ? 128 + (signalToNumber(signal) ?? 0) : 0);
  const hasTokenUsage = ctx.apiTokenUsage.inputTokens > 0 || ctx.apiTokenUsage.outputTokens > 0;
  return {
    output: stdout,
    error: stderr || undefined,
    exitCode,
    signalName: signal || undefined,
    assistantResponse: ctx.accumulatedAssistantResponse || undefined,
    thinkingOutput: ctx.accumulatedThinking || undefined,
    toolUseHistory: ctx.accumulatedToolUse.length > 0 ? ctx.accumulatedToolUse : undefined,
    claudeSessionId: sessionCapture.claudeSessionId,
    nativeTimeoutCount: ctx.nativeTimeoutDetector.timeoutCount || undefined,
    postTimeoutOutput: postTimeout,
    resumeBufferedOutput: resumeBuffered,
    apiTokenUsage: hasTokenUsage ? { ...ctx.apiTokenUsage } : undefined,
    stopReason: ctx.stopReason,
  };
}
