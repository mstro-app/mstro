// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { executeGitCommand, sendGitError, stripCoauthorLines } from './git-utils.js';
import type { HandlerContext } from './handler-context.js';
import type { GitDirectorySetResponse, GitLogEntry, GitRepoInfo, GitReposDiscoveredResponse, WebSocketMessage, WSContext } from './types.js';

export async function handleGitLog(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  const limit = msg.data?.limit ?? 10;
  const skip = msg.data?.skip ?? 0;

  try {
    // Request one extra to detect if there are more commits
    const fetchCount = limit + 1;
    const args = [
      'log',
      `-${fetchCount}`,
      `--skip=${skip}`,
      '--format=%H%x00%h%x00%s%x00%an%x00%aI'
    ];
    const result = await executeGitCommand(args, workingDir);

    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || result.stdout || 'Failed to get log' } });
      return;
    }

    const allEntries: GitLogEntry[] = result.stdout.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('\x00');
      const cleanSubject = stripCoauthorLines(parts[2] || '') || parts[2] || '';
      return { hash: parts[0], shortHash: parts[1], subject: cleanSubject, author: parts[3], date: parts[4] };
    });

    const hasMore = allEntries.length > limit;
    const entries = hasMore ? allEntries.slice(0, limit) : allEntries;

    ctx.send(ws, { type: 'gitLog', tabId, data: { entries, hasMore, skip } });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

const SKIP_DIRS = ['node_modules', 'vendor', '.git'];

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.includes(name);
}

async function getRepoBranch(repoPath: string): Promise<string | undefined> {
  const result = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

async function scanForGitRepos(dir: string, depth: number, maxDepth: number, repos: GitRepoInfo[]): Promise<void> {
  if (depth > maxDepth) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (shouldSkipDir(name)) continue;

    const fullPath = join(dir, name);
    const gitPath = join(fullPath, '.git');

    if (existsSync(gitPath)) {
      repos.push({ path: fullPath, name, branch: await getRepoBranch(fullPath) });
    } else {
      await scanForGitRepos(fullPath, depth + 1, maxDepth, repos);
    }
  }
}

export async function handleGitDiscoverRepos(ctx: HandlerContext, ws: WSContext, tabId: string, workingDir: string): Promise<void> {
  try {
    const repos: GitRepoInfo[] = [];
    const rootIsGitRepo = existsSync(join(workingDir, '.git'));

    if (rootIsGitRepo) {
      repos.push({
        path: workingDir,
        name: workingDir.split('/').pop() || workingDir,
        branch: await getRepoBranch(workingDir),
      });
    } else {
      await scanForGitRepos(workingDir, 1, 3, repos);
    }

    const response: GitReposDiscoveredResponse = {
      repos,
      rootIsGitRepo,
      selectedDirectory: ctx.gitDirectories.get(tabId) || null,
    };

    ctx.send(ws, { type: 'gitReposDiscovered', tabId, data: response });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

export async function handleGitSetDirectory(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  const directory = msg.data?.directory as string | undefined;

  if (!directory) {
    ctx.gitDirectories.delete(tabId);
    const response: GitDirectorySetResponse = {
      directory: workingDir,
      isValid: existsSync(join(workingDir, '.git')),
    };
    ctx.send(ws, { type: 'gitDirectorySet', tabId, data: response });
    const { handleGitStatus } = await import('./git-handlers.js');
    handleGitStatus(ctx, ws, tabId, workingDir);
    return;
  }

  // Security: validate path is within working directory OR is a valid worktree of the repo
  const resolvedDir = resolve(directory);
  const resolvedWorkingDir = resolve(workingDir);
  const isWithinWorkingDir = resolvedDir.startsWith(`${resolvedWorkingDir}/`) || resolvedDir === resolvedWorkingDir;

  if (!isWithinWorkingDir) {
    // Check if the directory is a known worktree of this repo
    const isWorktree = await isValidWorktreePath(resolvedDir, workingDir);
    if (!isWorktree) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Access denied: path outside project directory' } });
      return;
    }
  }

  const gitPath = join(resolvedDir, '.git');
  const isValid = existsSync(gitPath);

  if (isValid) {
    ctx.gitDirectories.set(tabId, resolvedDir);
  }

  const response: GitDirectorySetResponse = {
    directory: resolvedDir,
    isValid,
  };

  ctx.send(ws, { type: 'gitDirectorySet', tabId, data: response });

  if (isValid) {
    const { handleGitStatus } = await import('./git-handlers.js');
    handleGitStatus(ctx, ws, tabId, resolvedDir);
    handleGitLog(ctx, ws, { type: 'gitLog', data: { limit: 5 } }, tabId, resolvedDir);
  }
}

/** Check if a path is a registered worktree of the repo at workingDir */
async function isValidWorktreePath(targetPath: string, workingDir: string): Promise<boolean> {
  const result = await executeGitCommand(['worktree', 'list', '--porcelain'], workingDir);
  if (result.exitCode !== 0) return false;

  const resolvedTarget = resolve(targetPath);
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      const wtPath = resolve(line.slice(9).trim());
      if (wtPath === resolvedTarget) return true;
    }
  }
  return false;
}
