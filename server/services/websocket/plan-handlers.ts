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
import { getNextId, parsePlanDirectory, parseSingleIssue, parseSingleMilestone, parseSingleSprint, planDirExists, resolvePmDir } from '../plan/parser.js';
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

  const { title, type = 'issue', priority = 'P2', labels = [], sprint, description = '' } = msg.data || {};
  if (!title) {
    ctx.send(ws, { type: 'planError', data: { error: 'Title required' } });
    return;
  }

  const pmDir = resolvePmDir(workingDir) ?? join(workingDir, '.pm');
  const backlogDir = join(pmDir, 'backlog');
  if (!existsSync(backlogDir)) {
    mkdirSync(backlogDir, { recursive: true });
  }

  const fullState = parsePlanDirectory(workingDir);
  const prefix = type === 'bug' ? 'BG' : type === 'epic' ? 'EP' : 'IS';
  const id = fullState ? getNextId(fullState.issues, prefix) : `${prefix}-001`;

  const content = buildIssueMarkdown(id, title, type, priority, labels, sprint, description);
  const fileName = `${id}.md`;
  writeFileSync(join(backlogDir, fileName), content, 'utf-8');

  const issue = parseSingleIssue(workingDir, `backlog/${fileName}`);
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

  const content = readFileSync(fullPath, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    ctx.send(ws, { type: 'planError', data: { error: 'Invalid file format' } });
    return;
  }

  let yamlStr = match[1];
  const body = match[2];

  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    const yamlKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    const yamlValue = formatYamlValue(value);
    const regex = new RegExp(`^${yamlKey}:.*$`, 'm');
    if (regex.test(yamlStr)) {
      yamlStr = yamlStr.replace(regex, `${yamlKey}: ${yamlValue}`);
    } else {
      yamlStr += `\n${yamlKey}: ${yamlValue}`;
    }
  }

  writeFileSync(fullPath, `---\n${yamlStr}\n---\n${body}`, 'utf-8');

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

  for (const dir of ['backlog', 'sprints', 'milestones', 'docs', 'docs/decisions']) {
    mkdirSync(join(planDir, dir), { recursive: true });
  }

  writeFileSync(join(planDir, 'project.md'), buildProjectMarkdown(name), 'utf-8');
  writeFileSync(join(planDir, 'STATE.md'), buildStateMarkdown(name), 'utf-8');
  writeFileSync(join(planDir, 'progress.md'), '# Progress Log\n', 'utf-8');

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
