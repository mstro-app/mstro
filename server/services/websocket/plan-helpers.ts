// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PlanExecutor } from '../plan/executor.js';
import { defaultPmDir, resolvePmDir } from '../plan/parser.js';
import type { Workspace } from '../plan/types.js';
import { PlanWatcher } from '../plan/watcher.js';
import type { HandlerContext } from './handler-context.js';
import type { WSContext } from './types.js';

export const watcherCache = new Map<string, PlanWatcher>();
export const executorCache = new Map<string, PlanExecutor>();

/** Validate that a user-supplied path resolves within the .pm/ (or legacy .plan/) directory. */
export function resolvePlanPath(workingDir: string, relativePath: string): string | null {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return null;
  const resolved = resolve(pmDir, relativePath);
  if (!resolved.startsWith(`${pmDir}/`) && resolved !== pmDir) return null;
  return resolved;
}

/** Guard for write operations — returns true if denied. */
export function denyIfViewOnly(ctx: HandlerContext, ws: WSContext, permission?: 'control' | 'view'): boolean {
  if (permission === 'view') {
    ctx.send(ws, { type: 'planError', data: { error: 'Permission denied' } });
    return true;
  }
  return false;
}

export function formatYamlValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map(v => typeof v === 'string' ? v : String(v)).join(', ')}]`;
  }
  return `"${String(value).replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export function buildIssueMarkdown(
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

export function getWatcher(workingDir: string, ctx: HandlerContext): PlanWatcher {
  let watcher = watcherCache.get(workingDir);
  if (!watcher) {
    watcher = new PlanWatcher(workingDir, ctx);
    watcherCache.set(workingDir, watcher);
  }
  return watcher;
}

export function getExecutor(workingDir: string): PlanExecutor {
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

/** Create the .mstro/pm/ directory structure with a default board. */
export function scaffoldPmDirectory(workingDir: string, name: string): void {
  const planDir = defaultPmDir(workingDir);
  const boardId = 'BOARD-001';
  const boardDir = join(planDir, 'boards', boardId);

  for (const dir of ['milestones', 'templates']) {
    mkdirSync(join(planDir, dir), { recursive: true });
  }
  for (const dir of ['backlog', 'out', 'reviews', 'logs']) {
    mkdirSync(join(boardDir, dir), { recursive: true });
  }

  writeFileSync(join(planDir, 'project.md'), buildProjectMarkdown(name), 'utf-8');

  const workspace: Workspace = { activeBoardId: boardId, boardOrder: [boardId] };
  writeFileSync(join(planDir, 'workspace.json'), JSON.stringify(workspace, null, 2), 'utf-8');

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
}
