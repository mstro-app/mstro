// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeGitCommand, sendGitError, stripCoauthorLines } from './git-utils.js';
import type { HandlerContext } from './handler-context.js';
import type { GitCommitFile, WebSocketMessage, WSContext } from './types.js';

export async function handleGitDiff(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { path, staged } = msg.data || {};
    if (!path) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'File path is required' } });
      return;
    }

    const originalResult = await executeGitCommand(['show', `HEAD:${path}`], workingDir);
    const original = originalResult.exitCode === 0 ? originalResult.stdout : '';

    let modified: string;
    if (staged) {
      const indexResult = await executeGitCommand(['show', `:${path}`], workingDir);
      modified = indexResult.exitCode === 0 ? indexResult.stdout : '';
    } else {
      const fullPath = join(workingDir, path);
      try {
        modified = readFileSync(fullPath, 'utf-8');
      } catch {
        modified = '';
      }
    }

    ctx.send(ws, {
      type: 'gitDiffResult',
      tabId,
      data: { path, original, modified, staged: !!staged },
    });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

/** Parse a single name-status line into {status, oldPath?} */
function parseStatusLine(line: string | undefined): { status: string; oldPath?: string } {
  if (!line) return { status: 'M' };
  const parts = line.split('\t');
  const status = (parts[0] || 'M').charAt(0); // R100 -> R, C100 -> C
  const oldPath = (status === 'R' || status === 'C') && parts.length >= 3 ? parts[1] : undefined;
  return { status, oldPath };
}

/** Parse numstat + name-status output into GitCommitFile[] */
function parseCommitFiles(numstatOutput: string, statusOutput: string): GitCommitFile[] {
  const numstatLines = numstatOutput.trim().split('\n').filter(Boolean);
  const statusLines = statusOutput.trim().split('\n').filter(Boolean);

  return numstatLines.map((line, i) => {
    const numParts = line.split('\t');
    const additions = numParts[0] === '-' ? 0 : parseInt(numParts[0], 10) || 0;
    const deletions = numParts[1] === '-' ? 0 : parseInt(numParts[1], 10) || 0;
    const { status, oldPath } = parseStatusLine(statusLines[i]);
    return { path: numParts[2] || '', status, additions, deletions, ...(oldPath ? { oldPath } : {}) };
  });
}

/** Get the changed files for a commit via diff-tree */
async function getCommitFiles(hash: string, workingDir: string): Promise<GitCommitFile[]> {
  const isRoot = (await executeGitCommand(['rev-parse', `${hash}^`], workingDir)).exitCode !== 0;
  const extra = isRoot ? ['--root'] : [];
  const numstatResult = await executeGitCommand(
    ['diff-tree', '-r', '--numstat', '--no-commit-id', ...extra, hash], workingDir
  );
  const statusResult = await executeGitCommand(
    ['diff-tree', '-r', '--name-status', '--no-commit-id', ...extra, hash], workingDir
  );
  return parseCommitFiles(numstatResult.stdout, statusResult.stdout);
}

export async function handleGitShowCommit(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const hash = msg.data?.hash as string | undefined;
    if (!hash) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Commit hash is required' } });
      return;
    }

    const metaResult = await executeGitCommand([
      'show', '-s', '--format=%H%x00%h%x00%s%x00%b%x00%an%x00%aI', hash
    ], workingDir);

    if (metaResult.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: metaResult.stderr || 'Failed to get commit details' } });
      return;
    }

    const parts = metaResult.stdout.trim().split('\x00');
    const subject = stripCoauthorLines(parts[2] || '') || parts[2] || '';
    const files = await getCommitFiles(hash, workingDir);

    ctx.send(ws, {
      type: 'gitCommitDetail',
      tabId,
      data: {
        hash: parts[0], shortHash: parts[1], subject,
        body: stripCoauthorLines(parts[3] || '').trim(),
        author: parts[4], date: parts[5], files,
      },
    });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

export async function handleGitCommitDiff(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const hash = msg.data?.hash as string | undefined;
    const path = msg.data?.path as string | undefined;
    if (!hash || !path) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Commit hash and file path are required' } });
      return;
    }

    // Get the file content at this commit
    const modifiedResult = await executeGitCommand(['show', `${hash}:${path}`], workingDir);
    const modified = modifiedResult.exitCode === 0 ? modifiedResult.stdout : '';

    // Get the file content at the parent commit
    const originalResult = await executeGitCommand(['show', `${hash}^:${path}`], workingDir);
    const original = originalResult.exitCode === 0 ? originalResult.stdout : '';

    ctx.send(ws, {
      type: 'gitCommitDiffResult',
      tabId,
      data: { hash, path, original, modified },
    });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}
