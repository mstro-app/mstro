// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Plan Handlers — WebSocket message handlers for Plan view
 *
 * Routes plan* messages to the PPS parser and file operations.
 * Follows the same pattern as quality-handlers.ts and git-handlers.ts.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { handlePlanPrompt } from '../plan/composer.js';
import { PlanExecutor } from '../plan/executor.js';
import { replaceFrontMatterField } from '../plan/front-matter.js';
import { getNextBoardId, getNextBoardNumber, getNextId, getNextSprintId, parseBoardArtifacts, parseBoardDirectory, parsePlanDirectory, parseSingleIssue, parseSingleMilestone, parseSingleSprint, parseSprintArtifacts, planDirExists, resolvePmDir } from '../plan/parser.js';
import type { Workspace } from '../plan/types.js';
import { PlanWatcher } from '../plan/watcher.js';
import type { HandlerContext } from './handler-context.js';
import type { WebSocketMessage, WSContext } from './types.js';

const watcherCache = new Map<string, PlanWatcher>();
const executorCache = new Map<string, PlanExecutor>();

// ============================================================================
// Helpers
// ============================================================================

/** Validate that a user-supplied path resolves within the .pm/ (or legacy .plan/) directory. */
function resolvePlanPath(workingDir: string, relativePath: string): string | null {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return null;
  const resolved = resolve(pmDir, relativePath);
  if (!resolved.startsWith(`${pmDir}/`) && resolved !== pmDir) return null;
  return resolved;
}

/** Guard for write operations — returns true if denied. */
function denyIfViewOnly(ctx: HandlerContext, ws: WSContext, permission?: 'control' | 'view'): boolean {
  if (permission === 'view') {
    ctx.send(ws, { type: 'planError', data: { error: 'Permission denied' } });
    return true;
  }
  return false;
}

function formatYamlValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map(v => typeof v === 'string' ? v : String(v)).join(', ')}]`;
  }
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildIssueMarkdown(
  id: string, title: string, type: string, priority: string,
  labels: string[], sprint: string | null, description: string,
): string {
  const labelsYaml = labels.length > 0 ? `[${labels.join(', ')}]` : '[]';
  const today = new Date().toISOString().split('T')[0];
  return `---
id: ${id}
title: "${title.replace(/"/g, '\\"')}"
type: ${type}
status: backlog
priority: ${priority}
estimate: null
labels: ${labelsYaml}
epic: null
sprint: ${sprint || 'null'}
milestone: null
assigned: null
created: "${today}"
due: null
blocked_by: []
blocks: []
relates_to: []
---

# ${id}: ${title}

## Description
${description}

## Acceptance Criteria

## Technical Notes

## Files to Modify

## Activity
`;
}

function buildProjectMarkdown(name: string): string {
  const today = new Date().toISOString().split('T')[0];
  const projectId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `---
name: "${name}"
id: ${projectId}
created: "${today}"
status: active
estimation: fibonacci
id_prefixes:
  epic: EP
  issue: IS
  bug: BG
labels: []
---

# ${name}

## Goals

## Teams

## Labels

## Workflows
| Status | Category | Description |
|---|---|---|
| backlog | unstarted | Accepted, not yet scheduled |
| todo | unstarted | Scheduled for current sprint |
| in_progress | started | Actively being worked on |
| in_review | started | PR open, awaiting review |
| done | completed | Merged and verified |
| cancelled | cancelled | Will not be done |
`;
}

function buildStateMarkdown(name: string): string {
  return `---
project: "${name}"
current_sprint: null
active_milestone: null
paused: false
last_session: null
---

# Project State

## Current Focus

## Ready to Work

## In Progress

## Blocked

## Recently Completed

## Warnings
`;
}

function getWatcher(workingDir: string, ctx: HandlerContext): PlanWatcher {
  let watcher = watcherCache.get(workingDir);
  if (!watcher) {
    watcher = new PlanWatcher(workingDir, ctx);
    watcherCache.set(workingDir, watcher);
  }
  return watcher;
}

function getExecutor(workingDir: string): PlanExecutor {
  let executor = executorCache.get(workingDir);
  if (!executor) {
    executor = new PlanExecutor(workingDir);
    executorCache.set(workingDir, executor);
  }
  return executor;
}

/** Cleanup watchers and executors for a working directory. */
export function cleanupPlanResources(workingDir: string): void {
  const watcher = watcherCache.get(workingDir);
  if (watcher) {
    watcher.stop();
    watcherCache.delete(workingDir);
  }
  const executor = executorCache.get(workingDir);
  if (executor) {
    executor.stop();
    executorCache.delete(workingDir);
  }
}

// ============================================================================
// Main dispatcher
// ============================================================================

export function handlePlanMessage(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  _tabId: string,
  workingDir: string,
  permission?: 'control' | 'view',
): void {
  const handlers: Record<string, () => void> = {
    planInit: () => handlePlanInit(ctx, ws, workingDir),
    planGetState: () => handlePlanInit(ctx, ws, workingDir),
    planListIssues: () => handleListIssues(ctx, ws, workingDir),
    planGetIssue: () => handleGetIssue(ctx, ws, msg, workingDir),
    planGetSprint: () => handleGetSprint(ctx, ws, msg, workingDir),
    planGetMilestone: () => handleGetMilestone(ctx, ws, msg, workingDir),
    planCreateIssue: () => handleCreateIssue(ctx, ws, msg, workingDir, permission),
    planUpdateIssue: () => handleUpdateIssue(ctx, ws, msg, workingDir, permission),
    planDeleteIssue: () => handleDeleteIssue(ctx, ws, msg, workingDir, permission),
    planScaffold: () => handleScaffold(ctx, ws, msg, workingDir, permission),
    planPrompt: () => handlePrompt(ctx, ws, msg, workingDir, permission),
    planExecute: () => handleExecute(ctx, ws, workingDir, permission),
    planExecuteEpic: () => handleExecuteEpic(ctx, ws, msg, workingDir, permission),
    planPause: () => handlePause(ctx, ws, workingDir, permission),
    planStop: () => handleStop(ctx, ws, workingDir, permission),
    planResume: () => handleResume(ctx, ws, workingDir, permission),
    // Board lifecycle
    planCreateBoard: () => handleCreateBoard(ctx, ws, msg, workingDir, permission),
    planUpdateBoard: () => handleUpdateBoard(ctx, ws, msg, workingDir, permission),
    planArchiveBoard: () => handleArchiveBoard(ctx, ws, msg, workingDir, permission),
    planGetBoard: () => handleGetBoard(ctx, ws, msg, workingDir),
    planGetBoardState: () => handleGetBoardState(ctx, ws, msg, workingDir),
    planReorderBoards: () => handleReorderBoards(ctx, ws, msg, workingDir, permission),
    planSetActiveBoard: () => handleSetActiveBoard(ctx, ws, msg, workingDir, permission),
    planGetBoardArtifacts: () => handleGetBoardArtifacts(ctx, ws, msg, workingDir),
    // Sprint lifecycle (legacy)
    planCreateSprint: () => handleCreateSprint(ctx, ws, msg, workingDir, permission),
    planActivateSprint: () => handleActivateSprint(ctx, ws, msg, workingDir, permission),
    planCompleteSprint: () => handleCompleteSprint(ctx, ws, msg, workingDir, permission),
    planGetSprintArtifacts: () => handleGetSprintArtifacts(ctx, ws, msg, workingDir),
  };

  const handler = handlers[msg.type];
  if (!handler) return;

  try {
    handler();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    ctx.send(ws, { type: 'planError', data: { error: errMsg } });
  }
}

// ============================================================================
// Read-only handlers
// ============================================================================

function handlePlanInit(ctx: HandlerContext, ws: WSContext, workingDir: string): void {
  if (!planDirExists(workingDir)) {
    ctx.send(ws, { type: 'planNotFound', data: {} });
    return;
  }

  const fullState = parsePlanDirectory(workingDir);
  if (!fullState) {
    ctx.send(ws, { type: 'planNotFound', data: {} });
    return;
  }

  ctx.send(ws, { type: 'planState', data: fullState });

  const watcher = getWatcher(workingDir, ctx);
  watcher.start();
}

function handleListIssues(ctx: HandlerContext, ws: WSContext, workingDir: string): void {
  const fullState = parsePlanDirectory(workingDir);
  if (!fullState) {
    ctx.send(ws, { type: 'planNotFound', data: {} });
    return;
  }
  ctx.send(ws, { type: 'planIssueList', data: { issues: fullState.issues } });
}

function handleGetIssue(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, workingDir: string): void {
  const path = msg.data?.path;
  if (!path || !resolvePlanPath(workingDir, path)) {
    ctx.send(ws, { type: 'planError', data: { error: 'Invalid issue path' } });
    return;
  }
  const issue = parseSingleIssue(workingDir, path);
  if (!issue) {
    ctx.send(ws, { type: 'planError', data: { error: `Issue not found: ${path}` } });
    return;
  }
  ctx.send(ws, { type: 'planIssue', data: issue });
}

function handleGetSprint(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, workingDir: string): void {
  const path = msg.data?.path;
  if (!path || !resolvePlanPath(workingDir, path)) {
    ctx.send(ws, { type: 'planError', data: { error: 'Invalid sprint path' } });
    return;
  }
  const sprint = parseSingleSprint(workingDir, path);
  if (!sprint) {
    ctx.send(ws, { type: 'planError', data: { error: `Sprint not found: ${path}` } });
    return;
  }
  ctx.send(ws, { type: 'planSprint', data: sprint });
}

function handleGetMilestone(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, workingDir: string): void {
  const path = msg.data?.path;
  if (!path || !resolvePlanPath(workingDir, path)) {
    ctx.send(ws, { type: 'planError', data: { error: 'Invalid milestone path' } });
    return;
  }
  const milestone = parseSingleMilestone(workingDir, path);
  if (!milestone) {
    ctx.send(ws, { type: 'planError', data: { error: `Milestone not found: ${path}` } });
    return;
  }
  ctx.send(ws, { type: 'planMilestone', data: milestone });
}

// ============================================================================
// Mutation handlers
// ============================================================================

function handleCreateIssue(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const { title, type = 'issue', priority = 'P2', labels = [], sprint, description = '', boardId } = msg.data || {};
  if (!title) {
    ctx.send(ws, { type: 'planError', data: { error: 'Title required' } });
    return;
  }

  const pmDir = resolvePmDir(workingDir) ?? join(workingDir, '.pm');
  const fullState = parsePlanDirectory(workingDir);

  // Resolve backlog dir: board-scoped if boardId provided or active board exists
  const effectiveBoardId = boardId || fullState?.workspace?.activeBoardId;
  let backlogDir: string;
  let issuePath: string;
  let issues: typeof fullState extends null ? never : NonNullable<typeof fullState>['issues'] = [];

  if (effectiveBoardId && existsSync(join(pmDir, 'boards', effectiveBoardId))) {
    backlogDir = join(pmDir, 'boards', effectiveBoardId, 'backlog');
    // Get issues from this specific board
    const boardState = parseBoardDirectory(pmDir, effectiveBoardId);
    issues = boardState?.issues ?? [];
  } else {
    // Fallback: legacy flat backlog (shouldn't happen after migration)
    backlogDir = join(pmDir, 'backlog');
    issues = fullState?.issues ?? [];
  }

  if (!existsSync(backlogDir)) {
    mkdirSync(backlogDir, { recursive: true });
  }

  const prefix = type === 'bug' ? 'BG' : type === 'epic' ? 'EP' : 'IS';
  const id = getNextId(issues, prefix);

  const content = buildIssueMarkdown(id, title, type, priority, labels, sprint, description);
  const fileName = `${id}.md`;
  writeFileSync(join(backlogDir, fileName), content, 'utf-8');

  if (effectiveBoardId && existsSync(join(pmDir, 'boards', effectiveBoardId))) {
    issuePath = `boards/${effectiveBoardId}/backlog/${fileName}`;
  } else {
    issuePath = `backlog/${fileName}`;
  }

  const issue = parseSingleIssue(workingDir, issuePath);
  ctx.broadcastToAll({ type: 'planIssueCreated', data: issue });
}

function handleUpdateIssue(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const { path, fields } = msg.data || {};
  if (!path || !fields) {
    ctx.send(ws, { type: 'planError', data: { error: 'Path and fields required' } });
    return;
  }

  const fullPath = resolvePlanPath(workingDir, path);
  if (!fullPath || !existsSync(fullPath)) {
    ctx.send(ws, { type: 'planError', data: { error: `File not found: ${path}` } });
    return;
  }

  let content = readFileSync(fullPath, 'utf-8');
  if (!content.match(/^---\n/)) {
    ctx.send(ws, { type: 'planError', data: { error: 'Invalid file format' } });
    return;
  }

  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    const yamlKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    content = replaceFrontMatterField(content, yamlKey, formatYamlValue(value));
  }

  writeFileSync(fullPath, content, 'utf-8');

  const issue = parseSingleIssue(workingDir, path);
  ctx.broadcastToAll({ type: 'planIssueUpdated', data: issue });
}

function handleDeleteIssue(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const path = msg.data?.path;
  if (!path) {
    ctx.send(ws, { type: 'planError', data: { error: 'Path required' } });
    return;
  }

  const fullPath = resolvePlanPath(workingDir, path);
  if (!fullPath || !existsSync(fullPath)) {
    ctx.send(ws, { type: 'planError', data: { error: `File not found: ${path}` } });
    return;
  }

  unlinkSync(fullPath);
  ctx.broadcastToAll({ type: 'planIssueDeleted', data: { path } });
}

function handleScaffold(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const name = msg.data?.name || 'My Project';
  const planDir = join(workingDir, '.pm');
  const boardId = 'BOARD-001';
  const boardDir = join(planDir, 'boards', boardId);

  // Create board-centric directory structure
  for (const dir of ['milestones', 'templates']) {
    mkdirSync(join(planDir, dir), { recursive: true });
  }
  for (const dir of ['backlog', 'out', 'reviews']) {
    mkdirSync(join(boardDir, dir), { recursive: true });
  }

  // Project-level files
  writeFileSync(join(planDir, 'project.md'), buildProjectMarkdown(name), 'utf-8');

  // Workspace registry
  const workspace: Workspace = { activeBoardId: boardId, boardOrder: [boardId] };
  writeFileSync(join(planDir, 'workspace.json'), JSON.stringify(workspace, null, 2), 'utf-8');

  // Board files
  const today = new Date().toISOString().split('T')[0];
  writeFileSync(join(boardDir, 'board.md'), `---
id: ${boardId}
title: "Board 1"
status: draft
created: "${today}"
completed_at: null
goal: ""
---

# Board 1

## Goal

## Notes
`, 'utf-8');

  writeFileSync(join(boardDir, 'STATE.md'), buildStateMarkdown(name), 'utf-8');
  writeFileSync(join(boardDir, 'progress.md'), '# Board Progress\n', 'utf-8');

  const fullState = parsePlanDirectory(workingDir);
  ctx.broadcastToAll({ type: 'planScaffolded', data: fullState });
}

// ============================================================================
// Composer + Execution handlers
// ============================================================================

function handlePrompt(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const prompt = msg.data?.prompt;
  if (!prompt) {
    ctx.send(ws, { type: 'planError', data: { error: 'Prompt required' } });
    return;
  }
  handlePlanPrompt(ctx, ws, prompt, workingDir).catch(error => {
    ctx.send(ws, {
      type: 'planError',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  });
}

function wireExecutorEvents(executor: PlanExecutor, ctx: HandlerContext, workingDir: string): void {
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
    ctx.broadcastToAll({ type: 'planExecutionOutput', data });
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
    ctx.broadcastToAll({ type: 'planExecutionComplete', data: { reason, metrics: executor.getMetrics() } });
  });

  executor.on('error', (error: string) => {
    ctx.broadcastToAll({ type: 'planExecutionError', data: { error } });
  });
}

function handleExecute(
  ctx: HandlerContext, ws: WSContext,
  workingDir: string, permission?: 'control' | 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const executor = getExecutor(workingDir);

  if (executor.getStatus() === 'executing' || executor.getStatus() === 'starting') {
    ctx.send(ws, { type: 'planError', data: { error: 'Execution already in progress' } });
    return;
  }

  wireExecutorEvents(executor, ctx, workingDir);

  ctx.send(ws, { type: 'planExecutionStarted', data: { status: 'executing' } });
  executor.start().catch(error => {
    ctx.send(ws, {
      type: 'planExecutionError',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  });
}

function handleExecuteEpic(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
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

  ctx.send(ws, { type: 'planExecutionStarted', data: { status: 'executing', epicPath } });
  executor.startEpic(epicPath).catch(error => {
    ctx.send(ws, {
      type: 'planExecutionError',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  });
}

function handlePause(
  ctx: HandlerContext, ws: WSContext,
  workingDir: string, permission?: 'control' | 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;
  const executor = executorCache.get(workingDir);
  if (executor) executor.pause();
}

function handleStop(
  ctx: HandlerContext, ws: WSContext,
  workingDir: string, permission?: 'control' | 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;
  const executor = executorCache.get(workingDir);
  if (executor) executor.stop();
}

function handleResume(
  ctx: HandlerContext, ws: WSContext,
  workingDir: string, permission?: 'control' | 'view',
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

// ============================================================================
// Board lifecycle handlers
// ============================================================================

function handleCreateBoard(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) {
    ctx.send(ws, { type: 'planError', data: { error: 'No .pm/ directory found' } });
    return;
  }

  const fullState = parsePlanDirectory(workingDir);
  if (!fullState) return;

  const boardId = getNextBoardId(fullState.boards);
  const boardNum = getNextBoardNumber(fullState.boards);
  const title = msg.data?.title || `Board ${boardNum}`;
  const goal = msg.data?.goal || '';
  const boardDir = join(pmDir, 'boards', boardId);

  // Create directory structure
  for (const dir of ['backlog', 'out', 'reviews']) {
    mkdirSync(join(boardDir, dir), { recursive: true });
  }

  // Create board.md
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

  // Create STATE.md
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

  // Create progress.md
  writeFileSync(join(boardDir, 'progress.md'), '# Board Progress\n', 'utf-8');

  // Update workspace.json
  const workspaceContent = readFileSync(join(pmDir, 'workspace.json'), 'utf-8');
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

function handleUpdateBoard(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
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

function handleArchiveBoard(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
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

  // Set status to archived
  let content = readFileSync(boardMdPath, 'utf-8');
  content = replaceFrontMatterField(content, 'status', 'archived');
  writeFileSync(boardMdPath, content, 'utf-8');

  // Remove from workspace.json boardOrder and update activeBoardId if needed
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

function handleGetBoard(
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

function handleGetBoardState(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string,
): void {
  handleGetBoard(ctx, ws, msg, workingDir);
}

function handleReorderBoards(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
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

function handleSetActiveBoard(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
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

  // Also send the active board's full state
  const boardState = parseBoardDirectory(pmDir, boardId);
  if (boardState) {
    ctx.send(ws, { type: 'planBoardState', data: boardState });
  }
}

function handleGetBoardArtifacts(
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
    ctx.send(ws, { type: 'planBoardArtifacts', data: { boardId, progressLog: '', outputFiles: [], reviewResults: [] } });
    return;
  }

  ctx.send(ws, { type: 'planBoardArtifacts', data: artifacts });
}

// ============================================================================
// Sprint lifecycle handlers (legacy — kept for backward compatibility)
// ============================================================================

function buildSprintMarkdown(
  id: string, title: string, goal: string, start: string, end: string,
  issueRefs: string[],
): string {
  const issuesYaml = issueRefs.length > 0
    ? `\n${issueRefs.map(p => `  - ${p}`).join('\n')}`
    : ' []';
  return `---
id: ${id}
title: "${title.replace(/"/g, '\\"')}"
status: planned
start: "${start}"
end: "${end}"
goal: "${goal.replace(/"/g, '\\"')}"
capacity: null
committed: null
completed: null
completed_at: null
issues:${issuesYaml}
---

# ${id}: ${title}

## Sprint Goal
${goal}

## Issues
| Issue | Title | Points | Status |
|---|---|---|---|
`;
}

function handleCreateSprint(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const { title, goal = '', start = '', end = '', issueIds = [] } = msg.data || {};
  if (!title) {
    ctx.send(ws, { type: 'planError', data: { error: 'Sprint title required' } });
    return;
  }

  const pmDir = resolvePmDir(workingDir) ?? join(workingDir, '.pm');
  const sprintsDir = join(pmDir, 'sprints');
  if (!existsSync(sprintsDir)) {
    mkdirSync(sprintsDir, { recursive: true });
  }

  const fullState = parsePlanDirectory(workingDir);
  const id = fullState ? getNextSprintId(fullState.sprints) : 'SPRINT-001';

  // Resolve issue paths from IDs
  const issueRefs = (issueIds as string[]).map((issueId: string) => {
    const issue = fullState?.issues.find(i => i.id === issueId);
    return issue ? issue.path : `backlog/${issueId}.md`;
  });

  const content = buildSprintMarkdown(id, title, goal, start, end, issueRefs);
  writeFileSync(join(sprintsDir, `${id}.md`), content, 'utf-8');

  // Create sandbox directory for sprint artifacts
  const sandboxDir = join(sprintsDir, id);
  mkdirSync(join(sandboxDir, 'out'), { recursive: true });
  mkdirSync(join(sandboxDir, 'reviews'), { recursive: true });
  writeFileSync(join(sandboxDir, 'progress.md'), `# ${id}: ${title} — Progress Log\n`, 'utf-8');

  // Assign issues to the sprint if provided
  if (issueRefs.length > 0 && fullState) {
    for (const issueId of issueIds as string[]) {
      const issue = fullState.issues.find(i => i.id === issueId);
      if (issue) {
        const issuePath = resolvePlanPath(workingDir, issue.path);
        if (issuePath && existsSync(issuePath)) {
          let issueContent = readFileSync(issuePath, 'utf-8');
          issueContent = replaceFrontMatterField(issueContent, 'sprint', `sprints/${id}.md`);
          writeFileSync(issuePath, issueContent, 'utf-8');
        }
      }
    }
  }

  const sprint = parseSingleSprint(workingDir, `sprints/${id}.md`);
  ctx.broadcastToAll({ type: 'planSprintCreated', data: sprint });
}

function handleActivateSprint(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const sprintId = msg.data?.sprintId;
  if (!sprintId) {
    ctx.send(ws, { type: 'planError', data: { error: 'Sprint ID required' } });
    return;
  }

  const fullState = parsePlanDirectory(workingDir);
  if (!fullState) {
    ctx.send(ws, { type: 'planError', data: { error: 'No project found' } });
    return;
  }

  // Check no other sprint is active
  const currentActive = fullState.sprints.find(s => s.status === 'active');
  if (currentActive && currentActive.id !== sprintId) {
    ctx.send(ws, { type: 'planError', data: { error: `Sprint ${currentActive.id} is already active. Complete it first.` } });
    return;
  }

  const sprint = fullState.sprints.find(s => s.id === sprintId);
  if (!sprint) {
    ctx.send(ws, { type: 'planError', data: { error: `Sprint not found: ${sprintId}` } });
    return;
  }

  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return;

  // Update sprint status to active
  const sprintPath = join(pmDir, sprint.path);
  if (existsSync(sprintPath)) {
    let content = readFileSync(sprintPath, 'utf-8');
    content = replaceFrontMatterField(content, 'status', 'active');
    writeFileSync(sprintPath, content, 'utf-8');
  }

  // Update STATE.md current_sprint
  const statePath = join(pmDir, 'STATE.md');
  if (existsSync(statePath)) {
    let stateContent = readFileSync(statePath, 'utf-8');
    stateContent = replaceFrontMatterField(stateContent, 'current_sprint', `"${sprint.path}"`);
    writeFileSync(statePath, stateContent, 'utf-8');
  }

  // Move sprint's assigned issues from backlog to todo
  for (const issueSummary of sprint.issues) {
    const issue = fullState.issues.find(i => i.id === issueSummary.id || i.path === issueSummary.path);
    if (issue && (issue.status === 'backlog')) {
      const issuePath = join(pmDir, issue.path);
      if (existsSync(issuePath)) {
        let issueContent = readFileSync(issuePath, 'utf-8');
        issueContent = replaceFrontMatterField(issueContent, 'status', 'todo');
        writeFileSync(issuePath, issueContent, 'utf-8');
      }
    }
  }

  const updatedSprint = parseSingleSprint(workingDir, sprint.path);
  ctx.broadcastToAll({ type: 'planSprintUpdated', data: updatedSprint });

  // Refresh full state for all clients
  const updatedState = parsePlanDirectory(workingDir);
  if (updatedState) {
    ctx.broadcastToAll({ type: 'planStateUpdated', data: updatedState });
  }
}

function handleCompleteSprint(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const sprintId = msg.data?.sprintId;
  if (!sprintId) {
    ctx.send(ws, { type: 'planError', data: { error: 'Sprint ID required' } });
    return;
  }

  const fullState = parsePlanDirectory(workingDir);
  if (!fullState) {
    ctx.send(ws, { type: 'planError', data: { error: 'No project found' } });
    return;
  }

  const sprint = fullState.sprints.find(s => s.id === sprintId);
  if (!sprint) {
    ctx.send(ws, { type: 'planError', data: { error: `Sprint not found: ${sprintId}` } });
    return;
  }

  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return;

  const now = new Date().toISOString();

  // Compute execution summary from sprint issues
  const sprintIssues = fullState.issues.filter(i => i.sprint === sprint.path);
  const completedIssues = sprintIssues.filter(i => i.status === 'done').length;
  const failedIssues = sprintIssues.filter(i => i.status !== 'done' && i.status !== 'cancelled').length;

  // Update sprint file with completion data
  const sprintPath = join(pmDir, sprint.path);
  if (existsSync(sprintPath)) {
    let content = readFileSync(sprintPath, 'utf-8');
    content = replaceFrontMatterField(content, 'status', 'completed');
    content = replaceFrontMatterField(content, 'completed_at', `"${now}"`);
    content = replaceFrontMatterField(content, 'completed', String(completedIssues));

    // Write execution summary if not already present
    if (!content.includes('execution_summary:')) {
      const summaryYaml = [
        'execution_summary:',
        `  total_issues: ${sprintIssues.length}`,
        `  completed_issues: ${completedIssues}`,
        `  failed_issues: ${failedIssues}`,
      ].join('\n');
      // Insert before the closing --- of front matter
      content = content.replace(/^---\s*$/m, `${summaryYaml}\n---`);
    }

    writeFileSync(sprintPath, content, 'utf-8');
  }

  // Clear STATE.md current_sprint
  const statePath = join(pmDir, 'STATE.md');
  if (existsSync(statePath)) {
    let stateContent = readFileSync(statePath, 'utf-8');
    stateContent = replaceFrontMatterField(stateContent, 'current_sprint', 'null');
    writeFileSync(statePath, stateContent, 'utf-8');
  }

  const updatedSprint = parseSingleSprint(workingDir, sprint.path);
  ctx.broadcastToAll({ type: 'planSprintCompleted', data: updatedSprint });

  // Refresh full state
  const updatedState = parsePlanDirectory(workingDir);
  if (updatedState) {
    ctx.broadcastToAll({ type: 'planStateUpdated', data: updatedState });
  }
}

function handleGetSprintArtifacts(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string,
): void {
  const sprintId = msg.data?.sprintId;
  if (!sprintId) {
    ctx.send(ws, { type: 'planError', data: { error: 'Sprint ID required' } });
    return;
  }

  const artifacts = parseSprintArtifacts(workingDir, sprintId);
  if (!artifacts) {
    // Fall back to empty artifacts if sandbox dir doesn't exist yet
    ctx.send(ws, { type: 'planSprintArtifacts', data: { sprintId, progressLog: '', outputFiles: [], reviewResults: [] } });
    return;
  }

  ctx.send(ws, { type: 'planSprintArtifacts', data: artifacts });
}
