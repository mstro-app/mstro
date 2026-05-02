// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HandlerContext } from './handler-context.js';
import type { GitFileStatus, WSContext } from './types.js';

/** Send a gitError response to the client. */
export function sendGitError(ctx: HandlerContext, ws: WSContext, tabId: string, error: unknown): void {
  ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
}

/** Detect git provider from remote URL */
export function detectGitProvider(remoteUrl: string): 'github' | 'gitlab' | 'unknown' {
  if (remoteUrl.includes('github.com')) return 'github';
  if (remoteUrl.includes('gitlab.com') || remoteUrl.includes('gitlab')) return 'gitlab';
  return 'unknown';
}

/** Execute a git command and return stdout */
export function executeGitCommand(args: string[], workingDir: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const git = spawn('git', args, {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    git.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    git.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    git.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    git.on('error', (err: Error) => {
      resolve({ stdout: '', stderr: err.message, exitCode: 1 });
    });
  });
}

/** Map of simple escape sequences to their character values */
const ESCAPE_CHARS: Record<string, string> = {
  '\\': '\\',
  '"': '"',
  'n': '\n',
  't': '\t',
  'r': '\r',
};

/** Check if position i starts an octal escape sequence (\nnn) */
function isOctalEscape(str: string, i: number): boolean {
  return i + 3 < str.length &&
    /[0-7]/.test(str[i + 1]) &&
    /[0-7]{2}/.test(str.slice(i + 2, i + 4));
}

/**
 * Unquote a git-quoted path (C-style quoting)
 */
export function unquoteGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) {
    return path;
  }

  const inner = path.slice(1, -1);
  let result = '';
  let i = 0;

  while (i < inner.length) {
    if (inner[i] !== '\\' || i + 1 >= inner.length) {
      result += inner[i];
      i++;
      continue;
    }

    const next = inner[i + 1];
    const escaped = ESCAPE_CHARS[next];

    if (escaped !== undefined) {
      result += escaped;
      i += 2;
    } else if (isOctalEscape(inner, i)) {
      result += String.fromCharCode(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 4;
    } else {
      result += inner[i];
      i++;
    }
  }

  return result;
}

/** Parse git status --porcelain output into structured format */
export function parseGitStatus(porcelainOutput: string): { staged: GitFileStatus[]; unstaged: GitFileStatus[]; untracked: GitFileStatus[] } {
  const staged: GitFileStatus[] = [];
  const unstaged: GitFileStatus[] = [];
  const untracked: GitFileStatus[] = [];

  const lines = porcelainOutput.split('\n').filter(line => line.length >= 4);

  for (const line of lines) {
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const rawPath = line.slice(3);

    const path = unquoteGitPath(rawPath);

    let filePath = path;
    let originalPath: string | undefined;
    if (rawPath.includes(' -> ')) {
      const parts = rawPath.split(' -> ');
      originalPath = unquoteGitPath(parts[0]);
      filePath = unquoteGitPath(parts[1]);
    }

    if (indexStatus === '?' && workTreeStatus === '?') {
      untracked.push({ path: filePath, status: '?', staged: false });
      continue;
    }

    if (indexStatus !== ' ' && indexStatus !== '?') {
      staged.push({ path: filePath, status: indexStatus as GitFileStatus['status'], staged: true, originalPath });
    }

    if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
      unstaged.push({ path: filePath, status: workTreeStatus as GitFileStatus['status'], staged: false, originalPath });
    }
  }

  return { staged, unstaged, untracked };
}

/** Check if a binary runs successfully (exit code 0) */
export function spawnCheck(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/** Spawn a process and capture stdout/stderr */
export function spawnWithOutput(bin: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    proc.on('error', (err: Error) => resolve({ stdout: '', stderr: err.message, exitCode: 1 }));
  });
}

/** Truncate a diff to stay within token limits. */
export function truncateDiff(diff: string, maxLength = 8000): string {
  if (diff.length <= maxLength) return diff;
  const headSize = Math.floor(maxLength / 2);
  const tailSize = Math.floor(maxLength * 0.44);
  return `${diff.slice(0, headSize)}\n\n... [diff truncated] ...\n\n${diff.slice(-tailSize)}`;
}

/** Result of a Haiku spawn. `timedOut` is set when the process was killed by our timer. */
export interface HaikuResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Spawn Claude Haiku with a prompt file and return captured output.
 *
 * Default timeout is 90s — measured p99 of Haiku responses is ~31s for tiny
 * bouncer prompts; commit-message and PR-description prompts ship a full diff
 * and run materially longer. 90s gives a 3x margin while still failing fast
 * enough that the UI doesn't spin forever. */
export function spawnHaikuWithPrompt(
  prompt: string,
  systemPrompt: string,
  workingDir: string,
  timeoutMs = 90000,
): Promise<HaikuResult> {
  return new Promise((resolve) => {
    const tempDir = join(workingDir, '.mstro', 'tmp');
    if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
    // randomUUID — Date.now() collided when two requests fired in the same ms.
    const promptFile = join(tempDir, `haiku-${randomUUID()}.txt`);
    writeFileSync(promptFile, prompt);

    const args = ['--print', '--model', 'haiku', '--system-prompt', systemPrompt, promptFile];
    const proc = spawn('claude', args, { cwd: workingDir, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      try { unlinkSync(promptFile); } catch { /* ignore cleanup errors */ }
      resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      try { unlinkSync(promptFile); } catch { /* ignore cleanup errors */ }
      // ENOENT here means the `claude` binary wasn't found on PATH.
      const enoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
      resolve({ stdout: '', stderr: enoent ? `claude: command not found (${err.message})` : err.message, exitCode: 1, timedOut: false });
    });
  });
}

/** Map a Haiku failure to an actionable user-facing message + a stable reason code. */
export function classifyHaikuFailure(result: HaikuResult): { reason: string; userMessage: string } {
  const stderr = (result.stderr || '').toLowerCase();
  const stdout = (result.stdout || '').toLowerCase();
  const combined = `${stderr} ${stdout}`;

  if (result.timedOut) {
    return { reason: 'timeout', userMessage: 'Claude took too long to respond. Try again, or stage fewer files at once.' };
  }
  if (combined.includes('command not found') || combined.includes('enoent')) {
    return { reason: 'binary_missing', userMessage: 'Claude CLI is not installed or not on PATH. Install it with `npm i -g @anthropic-ai/claude-code` and re-launch mstro.' };
  }
  if (/not\s+(logged|signed)\s*in|not\s+authenticated|please\s+(log|sign)\s*in|api\s*key|unauthor/.test(combined)) {
    return { reason: 'auth', userMessage: 'Claude CLI is not authenticated. Run `claude /login` in a terminal, then try again.' };
  }
  if (/rate\s*limit|usage\s*limit|429|too\s+many\s+requests/.test(combined)) {
    return { reason: 'rate_limit', userMessage: 'Claude rate limit reached. Wait a minute and try again.' };
  }
  if (/overloaded|529|service\s+unavailable|503/.test(combined)) {
    return { reason: 'overloaded', userMessage: "Claude is temporarily overloaded. Try again in a few seconds." };
  }
  if (result.exitCode === 0 && !result.stdout.trim()) {
    return { reason: 'empty_output', userMessage: 'Claude returned an empty response. Try again.' };
  }

  const tail = (result.stderr || result.stdout || '').trim().slice(-200);
  return { reason: 'unknown', userMessage: `Failed to generate commit message${tail ? `: ${tail}` : ''}` };
}

/** Append a structured event to .mstro/logs/commit-message.jsonl for observability. */
export function logCommitMessageEvent(workingDir: string, entry: Record<string, unknown>): void {
  try {
    const logDir = join(workingDir, '.mstro', 'logs');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, 'commit-message.jsonl');
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`;
    appendFileSync(logFile, line, 'utf-8');
  } catch (err) {
    // Logging must never break the user-facing flow.
    console.error('[git] failed to write commit-message log:', err);
  }
}

/**
 * Strip injected coauthor/attribution lines from a commit message.
 */
export function stripCoauthorLines(message: string): string {
  const lines = message.split('\n');
  const markers = ['co-authored', 'authored-by', 'haiku', 'noreply@anthropic.com'];
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (markers.some(m => lower.includes(m))) {
      if (result.length > 0 && result[result.length - 1].trim() === '') {
        result.pop();
      }
      continue;
    }
    result.push(lines[i]);
  }
  if (result.length === 0) return '';
  return result.join('\n').trimEnd();
}
