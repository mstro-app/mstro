// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { executeGitCommand, sendGitError } from './git-utils.js';
import type { HandlerContext } from './handler-context.js';
import type { GitTagEntry, WebSocketMessage, WSContext } from './types.js';

export async function handleGitListTags(ctx: HandlerContext, ws: WSContext, tabId: string, workingDir: string): Promise<void> {
  try {
    const result = await executeGitCommand(
      ['tag', '-l', '--sort=-creatordate', '--format=%(refname:short)|%(objectname:short)|%(creatordate:iso-strict)|%(subject)'],
      workingDir
    );
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to list tags' } });
      return;
    }

    const tags: GitTagEntry[] = result.stdout.trim().split('\n')
      .filter(line => line.trim())
      .slice(0, 50)
      .map(line => {
        const parts = line.split('|');
        return {
          name: parts[0]?.trim() || '',
          shortHash: parts[1]?.trim() || '',
          date: parts[2]?.trim() || '',
          message: parts[3]?.trim() || '',
        };
      });

    ctx.send(ws, { type: 'gitTagList', tabId, data: { tags } });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

export async function handleGitCreateTag(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { name, message, commit } = msg.data || {};
    if (!name) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Tag name is required' } });
      return;
    }

    if (/\s/.test(name) || name.includes('..')) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Invalid tag name: no spaces or ".." allowed' } });
      return;
    }

    const args = message
      ? ['tag', '-a', name, '-m', message, ...(commit ? [commit] : [])]
      : ['tag', name, ...(commit ? [commit] : [])];

    const result = await executeGitCommand(args, workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to create tag' } });
      return;
    }

    const hashResult = await executeGitCommand(['rev-parse', '--short', name], workingDir);
    ctx.send(ws, { type: 'gitTagCreated', tabId, data: { name, hash: hashResult.stdout.trim() } });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

export async function handleGitPushTag(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { name, all } = msg.data || {};

    const args = all
      ? ['push', 'origin', '--tags']
      : ['push', 'origin', name];

    if (!all && !name) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Tag name is required' } });
      return;
    }

    const result = await executeGitCommand(args, workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to push tag' } });
      return;
    }

    ctx.send(ws, { type: 'gitTagPushed', tabId, data: { name: name || 'all', output: result.stderr || result.stdout } });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}
