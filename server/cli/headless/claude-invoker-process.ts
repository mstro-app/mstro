// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { type ChildProcess, spawn } from 'node:child_process';
import { getAuthProxyPort, getAuthProxyToken } from '../../services/auth-proxy.js';
import { cleanupSandboxCommand, initializeSandbox, isSandboxAvailable, wrapCommandForSandbox } from '../../services/sandbox-config.js';
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

  // Sandboxed sessions: restrict all file operations to the working directory
  if (config.sandboxed) {
    args.push('--append-system-prompt', `SECURITY: You are running in sandboxed mode for a shared user. You MUST NOT read, write, list, or access any files or directories outside the working directory (${config.workingDir}). This includes home directories, /etc, /tmp, /proc, and any path that does not start with ${config.workingDir}. If asked to access files outside this boundary, refuse the request and explain that access is restricted to the project directory.`);
  }

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

// ========== Sandbox Helpers ==========

/** Configure env vars for sandboxed execution with auth proxy credential injection. */
function configureSandboxEnv(spawnEnv: Record<string, string | undefined>, authProxyPort: number): void {
  if (authProxyPort <= 0) {
    throw new Error('[[MSTRO_ERROR:AUTH_PROXY_UNAVAILABLE]] Cannot start sandboxed session — auth proxy is not running. Credentials cannot be safely isolated.');
  }
  // Embed the proxy secret token in the dummy API key so it's automatically sent
  // as x-api-key with every request. The proxy validates and strips it.
  const proxyToken = getAuthProxyToken();
  spawnEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${authProxyPort}`;
  spawnEnv.ANTHROPIC_API_KEY = `sk-ant-proxy00-${proxyToken}`;
  delete spawnEnv.ANTHROPIC_AUTH_TOKEN;
  delete spawnEnv.CLAUDE_CODE_OAUTH_TOKEN;
}

/** Build the sandboxed spawn command via sandbox-runtime. */
async function buildSandboxedCommand(
  config: ResolvedHeadlessConfig,
  args: string[],
): Promise<{ command: string; args: string[] }> {
  await initializeSandbox(config.workingDir);
  const fullCommand = [config.claudeCommand, ...args].map(a => `'${a.replace(/\0/g, '').replace(/'/g, "'\\''")}'`).join(' ');
  const wrappedCommand = await wrapCommandForSandbox(fullCommand);
  return { command: '/bin/sh', args: ['-c', wrappedCommand] };
}

// ========== Process Spawning ==========

/** Spawn the Claude CLI process and register it */
export async function spawnAndRegister(
  config: ResolvedHeadlessConfig,
  prompt: string,
  hasImageAttachments: boolean,
  useStreamJson: boolean,
  runningProcesses: Map<number, ChildProcess>,
  perfStart: number,
): Promise<ChildProcess> {
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
    ? sanitizeEnvForSandbox(process.env, config.workingDir, { overrideHome: false })
    : { ...process.env };
  const spawnEnv = config.extraEnv
    ? { ...baseEnv, ...config.extraEnv }
    : baseEnv;

  // Hard sandbox: use sandbox-runtime for filesystem isolation + auth proxy for credential protection.
  // sandbox-runtime handles platform-specific wrapping (bwrap on Linux, sandbox-exec on macOS).
  const useSandbox = config.sandboxed && isSandboxAvailable();

  let spawnCommand: string;
  let spawnArgs: string[];

  if (useSandbox) {
    configureSandboxEnv(spawnEnv, getAuthProxyPort());
    const sandboxed = await buildSandboxedCommand(config, args);
    spawnCommand = sandboxed.command;
    spawnArgs = sandboxed.args;
    verboseLog(config.verbose, `[SANDBOX] Using sandbox-runtime (auth proxy port: ${getAuthProxyPort()})`);
  } else {
    spawnCommand = config.claudeCommand;
    spawnArgs = args;
    if (config.sandboxed) {
      verboseLog(config.verbose, '[SANDBOX] sandbox-runtime not available — falling back to soft sandbox (env sanitization + system prompt)');
    }
  }

  const claudeProcess = spawn(spawnCommand, spawnArgs, {
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

  claudeProcess.on('exit', () => {
    if (useSandbox) void cleanupSandboxCommand();
  });

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
