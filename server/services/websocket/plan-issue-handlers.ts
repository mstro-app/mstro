// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { replaceFrontMatterField } from '../plan/front-matter.js';
import { defaultPmDir, getNextId, parseBoardDirectory, parsePlanDirectory, parseSingleIssue, parseSingleMilestone, parseSingleSprint, planDirExists, resolvePmDir } from '../plan/parser.js';
import type { HandlerContext } from './handler-context.js';
import { buildIssueMarkdown, denyIfViewOnly, formatYamlValue, getWatcher, resolvePlanPath, scaffoldPmDirectory } from './plan-helpers.js';
import type { WebSocketMessage, WSContext } from './types.js';

// ============================================================================
// Read-only handlers
// ============================================================================

export function handlePlanInit(ctx: HandlerContext, ws: WSContext, workingDir: string): void {
  if (!planDirExists(workingDir)) {
    const projectName = basename(workingDir) || 'My Project';
    scaffoldPmDirectory(workingDir, projectName);
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

export function handleListIssues(ctx: HandlerContext, ws: WSContext, workingDir: string): void {
  const fullState = parsePlanDirectory(workingDir);
  if (!fullState) {
    ctx.send(ws, { type: 'planNotFound', data: {} });
    return;
  }
  ctx.send(ws, { type: 'planIssueList', data: { issues: fullState.issues } });
}

export function handleGetIssue(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, workingDir: string): void {
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

export function handleGetSprint(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, workingDir: string): void {
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

export function handleGetMilestone(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, workingDir: string): void {
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

/** Resolve backlog directory and existing issues for a board or legacy layout. */
function resolveBacklogContext(pmDir: string, workingDir: string, boardId?: string) {
  const fullState = parsePlanDirectory(workingDir);
  const effectiveBoardId = boardId || fullState?.workspace?.activeBoardId;

  if (effectiveBoardId && existsSync(join(pmDir, 'boards', effectiveBoardId))) {
    const boardState = parseBoardDirectory(pmDir, effectiveBoardId);
    return {
      backlogDir: join(pmDir, 'boards', effectiveBoardId, 'backlog'),
      issues: boardState?.issues ?? [],
      pathPrefix: `boards/${effectiveBoardId}/backlog`,
    };
  }
  return {
    backlogDir: join(pmDir, 'backlog'),
    issues: fullState?.issues ?? [],
    pathPrefix: 'backlog',
  };
}

export function handleCreateIssue(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const { title, type = 'issue', priority = 'P2', labels = [], sprint, description = '', boardId } = msg.data || {};
  if (!title) {
    ctx.send(ws, { type: 'planError', data: { error: 'Title required' } });
    return;
  }

  const pmDir = resolvePmDir(workingDir) ?? defaultPmDir(workingDir);
  const { backlogDir, issues, pathPrefix } = resolveBacklogContext(pmDir, workingDir, boardId);

  if (!existsSync(backlogDir)) mkdirSync(backlogDir, { recursive: true });

  const prefix = type === 'bug' ? 'BG' : type === 'epic' ? 'EP' : 'IS';
  const id = getNextId(issues, prefix);
  const fileName = `${id}.md`;

  writeFileSync(join(backlogDir, fileName), buildIssueMarkdown(id, title, type, priority, labels, sprint, description), 'utf-8');

  const issue = parseSingleIssue(workingDir, `${pathPrefix}/${fileName}`);
  ctx.broadcastToAll({ type: 'planIssueCreated', data: issue });
}

export function handleUpdateIssue(
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

export function handleDeleteIssue(
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

export function handleScaffold(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'control' | 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const name = msg.data?.name || 'My Project';
  scaffoldPmDirectory(workingDir, name);

  const fullState = parsePlanDirectory(workingDir);
  ctx.broadcastToAll({ type: 'planScaffolded', data: fullState });
}
