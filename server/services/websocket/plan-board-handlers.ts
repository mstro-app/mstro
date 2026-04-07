// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFrontMatterField } from '../plan/front-matter.js';
import { getNextBoardId, getNextBoardNumber, parseBoardArtifacts, parseBoardDirectory, parsePlanDirectory, resolvePmDir } from '../plan/parser.js';
import type { Workspace } from '../plan/types.js';
import type { HandlerContext } from './handler-context.js';
import { denyIfViewOnly, formatYamlValue } from './plan-helpers.js';
import type { WebSocketMessage, WSContext } from './types.js';

// ============================================================================
// Board lifecycle handlers
// ============================================================================

export function handleCreateBoard(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) {
    ctx.send(ws, { type: 'planError', data: { error: 'No PM directory found' } });
    return;
  }

  const fullState = parsePlanDirectory(workingDir);
  if (!fullState) return;

  const boardId = getNextBoardId(fullState.boards);
  const boardNum = getNextBoardNumber(fullState.boards);
  const title = msg.data?.title || `Board ${boardNum}`;
  const goal = msg.data?.goal || '';
  const boardDir = join(pmDir, 'boards', boardId);

  for (const dir of ['backlog', 'out', 'reviews', 'logs']) {
    mkdirSync(join(boardDir, dir), { recursive: true });
  }

  const today = new Date().toISOString().split('T')[0];
  writeFileSync(join(boardDir, 'board.md'), `---
id: ${boardId}
title: "${title.replace(/"/g, '\\"')}"
status: draft
created: "${today}"
completed_at: null
goal: "${goal.replace(/"/g, '\\"')}"
---

# ${title}

## Goal
${goal}

## Notes
`, 'utf-8');

  writeFileSync(join(boardDir, 'STATE.md'), `---
project: ../../project.md
board: board.md
paused: false
---

# Board State

## Ready to Work

## In Progress

## Blocked

## Recently Completed

## Warnings
`, 'utf-8');

  writeFileSync(join(boardDir, 'progress.md'), '# Board Progress\n', 'utf-8');

  const wsPath = join(pmDir, 'workspace.json');
  if (!existsSync(wsPath)) {
    writeFileSync(wsPath, JSON.stringify({ activeBoardId: null, boardOrder: [] }, null, 2), 'utf-8');
  }
  const workspaceContent = readFileSync(wsPath, 'utf-8');
  const workspace: Workspace = JSON.parse(workspaceContent);
  workspace.boardOrder.push(boardId);
  if (!workspace.activeBoardId) {
    workspace.activeBoardId = boardId;
  }
  writeFileSync(join(pmDir, 'workspace.json'), JSON.stringify(workspace, null, 2), 'utf-8');

  const boardState = parseBoardDirectory(pmDir, boardId);
  if (boardState) {
    ctx.broadcastToAll({ type: 'planBoardCreated', data: boardState.board });
    ctx.broadcastToAll({ type: 'planWorkspaceUpdated', data: workspace });
  }
}

export function handleUpdateBoard(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const { boardId, fields } = msg.data || {};
  if (!boardId || !fields) {
    ctx.send(ws, { type: 'planError', data: { error: 'Board ID and fields required' } });
    return;
  }

  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return;

  const boardMdPath = join(pmDir, 'boards', boardId, 'board.md');
  if (!existsSync(boardMdPath)) {
    ctx.send(ws, { type: 'planError', data: { error: `Board not found: ${boardId}` } });
    return;
  }

  let content = readFileSync(boardMdPath, 'utf-8');
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    const yamlKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    content = replaceFrontMatterField(content, yamlKey, formatYamlValue(value));
  }
  writeFileSync(boardMdPath, content, 'utf-8');

  const boardState = parseBoardDirectory(pmDir, boardId);
  if (boardState) {
    ctx.broadcastToAll({ type: 'planBoardUpdated', data: boardState.board });
  }
}

export function handleArchiveBoard(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const boardId = msg.data?.boardId;
  if (!boardId) {
    ctx.send(ws, { type: 'planError', data: { error: 'Board ID required' } });
    return;
  }

  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return;

  const boardMdPath = join(pmDir, 'boards', boardId, 'board.md');
  if (!existsSync(boardMdPath)) {
    ctx.send(ws, { type: 'planError', data: { error: `Board not found: ${boardId}` } });
    return;
  }

  let content = readFileSync(boardMdPath, 'utf-8');
  content = replaceFrontMatterField(content, 'status', 'archived');
  writeFileSync(boardMdPath, content, 'utf-8');

  const workspacePath = join(pmDir, 'workspace.json');
  if (existsSync(workspacePath)) {
    const workspace: Workspace = JSON.parse(readFileSync(workspacePath, 'utf-8'));
    workspace.boardOrder = workspace.boardOrder.filter(id => id !== boardId);
    if (workspace.activeBoardId === boardId) {
      workspace.activeBoardId = workspace.boardOrder[0] || null;
    }
    writeFileSync(workspacePath, JSON.stringify(workspace, null, 2), 'utf-8');
    ctx.broadcastToAll({ type: 'planWorkspaceUpdated', data: workspace });
  }

  const boardState = parseBoardDirectory(pmDir, boardId);
  if (boardState) {
    ctx.broadcastToAll({ type: 'planBoardArchived', data: boardState.board });
  }
}

export function handleGetBoard(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string,
): void {
  const boardId = msg.data?.boardId;
  if (!boardId) {
    ctx.send(ws, { type: 'planError', data: { error: 'Board ID required' } });
    return;
  }

  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return;

  const boardState = parseBoardDirectory(pmDir, boardId);
  if (!boardState) {
    ctx.send(ws, { type: 'planError', data: { error: `Board not found: ${boardId}` } });
    return;
  }

  ctx.send(ws, { type: 'planBoardState', data: boardState });
}

export function handleGetBoardState(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string,
): void {
  handleGetBoard(ctx, ws, msg, workingDir);
}

export function handleReorderBoards(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const boardOrder = msg.data?.boardOrder;
  if (!Array.isArray(boardOrder)) {
    ctx.send(ws, { type: 'planError', data: { error: 'boardOrder array required' } });
    return;
  }

  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return;

  const workspacePath = join(pmDir, 'workspace.json');
  if (!existsSync(workspacePath)) return;

  const workspace: Workspace = JSON.parse(readFileSync(workspacePath, 'utf-8'));
  workspace.boardOrder = boardOrder;
  writeFileSync(workspacePath, JSON.stringify(workspace, null, 2), 'utf-8');

  ctx.broadcastToAll({ type: 'planWorkspaceUpdated', data: workspace });
}

export function handleSetActiveBoard(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const boardId = msg.data?.boardId;
  if (!boardId) {
    ctx.send(ws, { type: 'planError', data: { error: 'Board ID required' } });
    return;
  }

  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return;

  const workspacePath = join(pmDir, 'workspace.json');
  if (!existsSync(workspacePath)) return;

  const workspace: Workspace = JSON.parse(readFileSync(workspacePath, 'utf-8'));
  workspace.activeBoardId = boardId;
  writeFileSync(workspacePath, JSON.stringify(workspace, null, 2), 'utf-8');

  ctx.broadcastToAll({ type: 'planWorkspaceUpdated', data: workspace });

  const boardState = parseBoardDirectory(pmDir, boardId);
  if (boardState) {
    ctx.send(ws, { type: 'planBoardState', data: boardState });
  }
}

export function handleGetBoardArtifacts(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string,
): void {
  const boardId = msg.data?.boardId;
  if (!boardId) {
    ctx.send(ws, { type: 'planError', data: { error: 'Board ID required' } });
    return;
  }

  const artifacts = parseBoardArtifacts(workingDir, boardId);
  if (!artifacts) {
    ctx.send(ws, { type: 'planBoardArtifacts', data: { boardId, progressLog: '', outputFiles: [], reviewResults: [], executionLogs: [] } });
    return;
  }

  ctx.send(ws, { type: 'planBoardArtifacts', data: artifacts });
}
