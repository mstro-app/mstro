// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** Spawn Claude Haiku with a prompt file and return captured output. */
export function spawnHaikuWithPrompt(
  prompt: string,
  systemPrompt: string,
  workingDir: string,
  timeoutMs = 30000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const tempDir = join(workingDir, '.mstro', 'tmp');
    if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
    const promptFile = join(tempDir, `haiku-${Date.now()}.txt`);
    writeFileSync(promptFile, prompt);

    const args = ['--print', '--model', 'haiku', '--system-prompt', systemPrompt, promptFile];
    const proc = spawn('claude', args, { cwd: workingDir, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => proc.kill(), timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      try { unlinkSync(promptFile); } catch { /* ignore cleanup errors */ }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      try { unlinkSync(promptFile); } catch { /* ignore cleanup errors */ }
      resolve({ stdout: '', stderr: err.message, exitCode: 1 });
    });
  });
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
