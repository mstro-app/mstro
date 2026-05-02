// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { handlePlanPrompt } from '../plan/composer.js';
import type { PlanExecutor } from '../plan/executor.js';
import { parsePlanDirectory } from '../plan/parser.js';
import type { HandlerContext } from './handler-context.js';
import { denyIfViewOnly, executorCache, getExecutor } from './plan-helpers.js';
import { mergePreUploadedAttachments } from './session-handlers.js';
import type { WebSocketMessage, WSContext } from './types.js';

// ============================================================================
// Composer + Execution handlers
// ============================================================================

export function handlePrompt(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const prompt = msg.data?.prompt;
  const boardId = msg.data?.boardId as string | undefined;
  if (!prompt) {
    ctx.send(ws, { type: 'planError', data: { error: 'Prompt required' } });
    return;
  }
  const executionDir = boardId ? ctx.gitDirectories.get(boardId) : undefined;
  // Pull in any chunked uploads stashed under this board's tabId by the
  // composer paperclip / drag-drop path, so they flow into the plan prompt
  // exactly like chat-tab attachments do.
  const attachments = boardId ? mergePreUploadedAttachments(ctx, boardId, undefined) : undefined;
  handlePlanPrompt(ctx, ws, prompt, workingDir, boardId, executionDir, attachments).catch(error => {
    ctx.send(ws, {
      type: 'planError',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  });
}

function wireExecutorEvents(executor: PlanExecutor, ctx: HandlerContext, workingDir: string, boardId?: string): void {
  executor.removeAllListeners();

  executor.on('statusChanged', (status: string) => {
    ctx.broadcastToAll({ type: 'planExecutionProgress', data: { status } });
  });

  executor.on('issueStarted', (issue: { id: string; title: string }) => {
    ctx.broadcastToAll({
      type: 'planExecutionProgress',
      data: { issueId: issue.id, status: 'executing', title: issue.title },
    });
  });

  executor.on('output', (data: { issueId: string; text: string }) => {
    ctx.broadcastToAll({ type: 'planExecutionOutput', data: { ...data, boardId: boardId ?? null } });
  });

  executor.on('issueCompleted', () => {
    ctx.broadcastToAll({ type: 'planExecutionMetrics', data: executor.getMetrics() });
    const fullState = parsePlanDirectory(workingDir);
    if (fullState) {
      ctx.broadcastToAll({ type: 'planStateUpdated', data: fullState });
    }
  });

  executor.on('issueError', (data: { issueId: string; error: string }) => {
    ctx.broadcastToAll({ type: 'planExecutionError', data });
  });

  executor.on('waveStarted', (data: { issueIds: string[] }) => {
    ctx.broadcastToAll({
      type: 'planExecutionProgress',
      data: { status: 'wave', issueIds: data.issueIds },
    });
  });

  executor.on('waveError', (data: { issueIds: string[]; error: string }) => {
    ctx.broadcastToAll({ type: 'planExecutionError', data });
  });

  executor.on('stateUpdated', () => {
    const fullState = parsePlanDirectory(workingDir);
    if (fullState) {
      ctx.broadcastToAll({ type: 'planStateUpdated', data: fullState });
    }
  });

  executor.on('reviewProgress', (data: { issueId: string; status: string }) => {
    ctx.broadcastToAll({ type: 'planReviewProgress', data });
  });

  executor.on('complete', (reason: string) => {
    ctx.broadcastToAll({ type: 'planExecutionComplete', data: { reason, boardId: boardId ?? null, metrics: executor.getMetrics() } });
  });

  executor.on('error', (error: string) => {
    ctx.broadcastToAll({ type: 'planExecutionError', data: { error } });
  });
}

export function handleExecute(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const executor = getExecutor(workingDir);

  if (executor.getStatus() === 'executing' || executor.getStatus() === 'starting') {
    ctx.send(ws, { type: 'planError', data: { error: 'Execution already in progress' } });
    return;
  }

  const boardId = msg.data?.boardId as string | undefined;
  wireExecutorEvents(executor, ctx, workingDir, boardId);

  const executionDir = boardId ? ctx.gitDirectories.get(boardId) : undefined;
  ctx.broadcastToAll({ type: 'planExecutionStarted', data: { status: 'executing', boardId } });
  const startPromise = boardId ? executor.startBoard(boardId, executionDir) : executor.start();
  startPromise.catch(error => {
    ctx.send(ws, {
      type: 'planExecutionError',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  });
}

export function handleExecuteEpic(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const epicPath = msg.data?.epicPath;
  if (!epicPath) {
    ctx.send(ws, { type: 'planError', data: { error: 'Epic path required' } });
    return;
  }

  const executor = getExecutor(workingDir);

  if (executor.getStatus() === 'executing' || executor.getStatus() === 'starting') {
    ctx.send(ws, { type: 'planError', data: { error: 'Execution already in progress' } });
    return;
  }

  wireExecutorEvents(executor, ctx, workingDir);

  ctx.broadcastToAll({ type: 'planExecutionStarted', data: { status: 'executing', epicPath } });
  executor.startEpic(epicPath).catch(error => {
    ctx.send(ws, {
      type: 'planExecutionError',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  });
}

export function handlePause(
  ctx: HandlerContext, ws: WSContext,
  workingDir: string, permission?: 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;
  const executor = executorCache.get(workingDir);
  if (executor) executor.pause();
}

export function handleStop(
  ctx: HandlerContext, ws: WSContext,
  workingDir: string, permission?: 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;
  const executor = executorCache.get(workingDir);
  if (executor) executor.stop();
}

export function handleResume(
  ctx: HandlerContext, ws: WSContext,
  workingDir: string, permission?: 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;
  const executor = executorCache.get(workingDir);
  if (executor) {
    executor.resume().catch(error => {
      ctx.send(ws, {
        type: 'planExecutionError',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    });
  }
}
