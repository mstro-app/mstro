// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileAttachment } from '../../cli/improvisation-types.js';
import { handlePlanPrompt } from '../plan/composer.js';
import { replaceFrontMatterField } from '../plan/front-matter.js';
import { getNextBoardId, getNextBoardNumber, parseBoardArtifacts, parseBoardDirectory, parsePlanDirectory, resolvePmDir } from '../plan/parser.js';
import type { Workspace } from '../plan/types.js';
import type { HandlerContext } from './handler-context.js';
import { denyIfViewOnly, formatYamlValue } from './plan-helpers.js';
import { mergePreUploadedAttachments } from './session-handlers.js';
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

/** Update front-matter fields in the board.md file. */
function applyBoardFieldUpdates(
  boardMdPath: string,
  fields: Record<string, unknown>,
): void {
  let content = readFileSync(boardMdPath, 'utf-8');
  for (const [key, value] of Object.entries(fields)) {
    const yamlKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    content = replaceFrontMatterField(content, yamlKey, formatYamlValue(value));
  }
  writeFileSync(boardMdPath, content, 'utf-8');
}

/** Sync the review-custom agent file when review criteria change. */
function syncReviewCriteriaAgent(
  fields: Record<string, unknown>,
  pmDir: string,
  boardId: string,
): void {
  if (!('reviewCriteria' in fields)) return;

  const boardDir = join(pmDir, 'boards', boardId);
  const agentsDir = join(boardDir, 'agents');
  const agentPath = join(agentsDir, 'review-custom.md');
  const criteriaValue = String(fields.reviewCriteria ?? '').trim();

  if (criteriaValue) {
    if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });
    writeFileSync(agentPath, buildBoardReviewAgent(criteriaValue), 'utf-8');
  } else if (existsSync(agentPath)) {
    try { unlinkSync(agentPath); } catch { /* non-fatal */ }
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

  applyBoardFieldUpdates(boardMdPath, fields as Record<string, unknown>);

  // When review criteria are set, also write a board-level review agent file
  // so users can discover and edit the full prompt as markdown.
  syncReviewCriteriaAgent(fields as Record<string, unknown>, pmDir, boardId);

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

export function handleRestoreBoard(
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
  content = replaceFrontMatterField(content, 'status', 'active');
  writeFileSync(boardMdPath, content, 'utf-8');

  const workspacePath = join(pmDir, 'workspace.json');
  if (existsSync(workspacePath)) {
    const workspace: Workspace = JSON.parse(readFileSync(workspacePath, 'utf-8'));
    if (!workspace.boardOrder.includes(boardId)) {
      workspace.boardOrder.push(boardId);
    }
    workspace.activeBoardId = boardId;
    writeFileSync(workspacePath, JSON.stringify(workspace, null, 2), 'utf-8');
    ctx.broadcastToAll({ type: 'planWorkspaceUpdated', data: workspace });
  }

  const boardState = parseBoardDirectory(pmDir, boardId);
  if (boardState) {
    ctx.broadcastToAll({ type: 'planBoardUpdated', data: boardState.board });
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

// ============================================================================
// Chat-to-board: create board from conversation and run prompt
// ============================================================================

export function handleChatToBoard(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const { conversation, autoImplement, focusHint, attachments: inlineAttachments } = (msg.data || {}) as {
    conversation?: string;
    autoImplement?: boolean;
    focusHint?: string;
    attachments?: FileAttachment[];
  };

  if (!conversation) {
    ctx.send(ws, { type: 'planError', data: { error: 'Conversation text is required' } });
    return;
  }

  // Merge any chunked pre-uploads (routed by tabId) with inline browser attachments
  // so large plan docs and images all flow into the plan prompt.
  const attachments = msg.tabId
    ? mergePreUploadedAttachments(ctx, msg.tabId, inlineAttachments)
    : inlineAttachments;

  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) {
    ctx.send(ws, { type: 'planError', data: { error: 'No PM directory found. Run planScaffold first.' } });
    return;
  }

  const fullState = parsePlanDirectory(workingDir);
  if (!fullState) {
    ctx.send(ws, { type: 'planError', data: { error: 'Failed to parse PM directory' } });
    return;
  }

  const boardId = getNextBoardId(fullState.boards);
  const boardNum = getNextBoardNumber(fullState.boards);
  const title = `Board ${boardNum}`;
  const boardDir = join(pmDir, 'boards', boardId);

  for (const dir of ['backlog', 'out', 'reviews', 'logs']) {
    mkdirSync(join(boardDir, dir), { recursive: true });
  }

  const today = new Date().toISOString().split('T')[0];
  const goalLine = focusHint || 'Generated from chat conversation';

  writeFileSync(join(boardDir, 'board.md'), `---
id: ${boardId}
title: "${title}"
status: draft
created: "${today}"
completed_at: null
goal: "${goalLine.replace(/"/g, '\\"')}"
---

# ${title}

## Goal
${goalLine}

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
  const workspace: Workspace = JSON.parse(readFileSync(wsPath, 'utf-8'));
  workspace.boardOrder.push(boardId);
  workspace.activeBoardId = boardId;
  writeFileSync(wsPath, JSON.stringify(workspace, null, 2), 'utf-8');

  const boardState = parseBoardDirectory(pmDir, boardId);
  if (boardState) {
    ctx.broadcastToAll({ type: 'planBoardCreated', data: boardState.board });
    ctx.broadcastToAll({ type: 'planWorkspaceUpdated', data: workspace });
  }

  ctx.send(ws, {
    type: 'chatToBoardCreated',
    data: { boardId, autoImplement: !!autoImplement },
  });

  let prompt = conversation;
  if (focusHint) {
    prompt = `Focus on: ${focusHint}\n\n${conversation}`;
  }
  handlePlanPrompt(ctx, ws, prompt, workingDir, boardId, undefined, attachments).catch(error => {
    ctx.send(ws, {
      type: 'planError',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  });
}

// ── Private helpers ──────────────────────────────────────────────────

/** Build a board-level review-custom agent file from user-provided criteria. */
function buildBoardReviewAgent(criteria: string): string {
  return `---
name: review-custom
description: Board-specific review agent with custom criteria
type: review
variables: [issue_id, issue_title, context_section, acceptance_criteria, review_criteria, read_instruction]
checks: [criteria_met, review_criteria]
---

You are a reviewer. Review the work done for issue {{issue_id}}: {{issue_title}}.
{{context_section}}

## Acceptance Criteria
{{acceptance_criteria}}

## Review Criteria
${criteria}

## Instructions
1. {{read_instruction}}
2. Check if all acceptance criteria are met — evaluate each criterion individually
3. Evaluate thoroughly against the review criteria above
4. Consider the overall quality of the work: does it fully address the issue's intent, is it well-structured, and is it ready to ship?

Output EXACTLY one JSON object on its own line (no markdown fencing):
{"passed": true, "checks": [{"name": "criteria_met", "passed": true, "details": "..."}]}

Include checks for: criteria_met, review_criteria.
`;
}
