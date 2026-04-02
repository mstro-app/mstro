// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { executeGitCommand, sendGitError } from './git-utils.js';
import type { HandlerContext } from './handler-context.js';
import type { GitBranchEntry, WebSocketMessage, WSContext } from './types.js';

export async function handleGitListBranches(ctx: HandlerContext, ws: WSContext, tabId: string, workingDir: string): Promise<void> {
  try {
    const result = await executeGitCommand(
      ['branch', '-a', '--format=%(refname:short)|%(objectname:short)|%(upstream:short)|%(HEAD)'],
      workingDir
    );
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to list branches' } });
      return;
    }

    const currentBranchResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
    const currentBranch = currentBranchResult.stdout.trim() || 'HEAD';

    const branches: GitBranchEntry[] = result.stdout.trim().split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [name, shortHash, upstream, head] = line.split('|');
        const isRemote = name.includes('/') && (name.startsWith('origin/') || name.includes('remotes/'));
        return {
          name: name.trim(),
          shortHash: shortHash?.trim() || '',
          isRemote,
          isCurrent: head?.trim() === '*',
          upstream: upstream?.trim() || undefined,
        };
      })
      .filter(b => b.name !== 'origin/HEAD');

    ctx.send(ws, { type: 'gitBranchList', tabId, data: { branches, current: currentBranch } });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

export async function handleGitCheckout(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { branch, create, startPoint } = msg.data || {};
    if (!branch) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Branch name is required' } });
      return;
    }

    const statusResult = await executeGitCommand(['status', '--porcelain'], workingDir);
    if (statusResult.stdout.trim()) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Commit or stash changes before switching branches' } });
      return;
    }

    const prevResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
    const previous = prevResult.stdout.trim();

    const args = create
      ? ['checkout', '-b', branch, ...(startPoint ? [startPoint] : [])]
      : ['checkout', branch];

    const result = await executeGitCommand(args, workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to checkout branch' } });
      return;
    }

    ctx.send(ws, { type: 'gitCheckedOut', tabId, data: { branch, previous } });
    // Re-fetch status after checkout - import handleGitStatus at call site
    const { handleGitStatus } = await import('./git-handlers.js');
    handleGitStatus(ctx, ws, tabId, workingDir);
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

export async function handleGitCreateBranch(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { name, startPoint, checkout } = msg.data || {};
    if (!name) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Branch name is required' } });
      return;
    }

    const args = ['branch', name, ...(startPoint ? [startPoint] : [])];
    const result = await executeGitCommand(args, workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to create branch' } });
      return;
    }

    const hashResult = await executeGitCommand(['rev-parse', '--short', name], workingDir);

    if (checkout) {
      await executeGitCommand(['checkout', name], workingDir);
    }

    ctx.send(ws, { type: 'gitBranchCreated', tabId, data: { name, hash: hashResult.stdout.trim() } });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

export async function handleGitDeleteBranch(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { name, force } = msg.data || {};
    if (!name) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Branch name is required' } });
      return;
    }

    const currentResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
    if (currentResult.stdout.trim() === name) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Cannot delete the currently checked out branch' } });
      return;
    }

    const result = await executeGitCommand(['branch', force ? '-D' : '-d', name], workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to delete branch' } });
      return;
    }

    ctx.send(ws, { type: 'gitBranchDeleted', tabId, data: { name } });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}
