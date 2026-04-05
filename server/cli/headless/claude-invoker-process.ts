// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { type ChildProcess, spawn } from 'node:child_process';
import { sanitizeEnvForSandbox } from '../../services/sandbox-utils.js';
import type { StreamHandlerContext } from './claude-invoker-stream.js';
import { flushNativeTimeoutBuffers, verboseLog } from './claude-invoker-stream.js';
import { herror } from './headless-logger.js';
import { generateMcpConfig } from './mcp-config.js';
import { buildMultimodalMessage } from './prompt-utils.js';
import type { ExecutionResult, ResolvedHeadlessConfig } from './types.js';

// ========== Signal Helpers ==========

/** Map a Node.js signal name to its numeric value for exit code computation */
function signalToNumber(signal: string): number | undefined {
  const map: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6,
    SIGKILL: 9, SIGTERM: 15, SIGUSR1: 10, SIGUSR2: 12,
  };
  return map[signal];
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

export function handleSpawnError(
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

export function buildClaudeArgs(
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

  if (config.disallowedTools && config.disallowedTools.length > 0) {
    args.push('--disallowedTools', config.disallowedTools.join(','));
  }

  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
    args.push('--permission-prompt-tool', 'mcp__mstro-bouncer__approval_prompt');
  } else {
    args.push('--permission-mode', 'acceptEdits');
  }

  // Reduce Edit-without-Read errors by reminding the model
  args.push('--append-system-prompt', 'IMPORTANT: Always use the Read tool to read a file before using Edit or Write on it. Never edit a file you have not read in this session.');

  if (!hasImageAttachments) {
    // Strip null bytes — Node.js spawn rejects args containing \0
    args.push(prompt.replaceAll('\0', ''));
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
      herror('[STDIN] Write error:', err.message);
    }
    config.outputCallback?.(`\n[[MSTRO_ERROR:STDIN_WRITE_FAILED]] Failed to send image data to Claude: ${err.message}\n`);
  });
  const multimodalMessage = buildMultimodalMessage(prompt, config.imageAttachments!);
  claudeProcess.stdin!.write(multimodalMessage);
  claudeProcess.stdin!.end();
}

// ========== Process Spawning ==========

/** Spawn the Claude CLI process and register it */
export function spawnAndRegister(
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

// ========== Result Building ==========

export function buildCloseResult(
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
