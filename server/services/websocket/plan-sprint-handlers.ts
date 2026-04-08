// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFrontMatterField } from '../plan/front-matter.js';
import { defaultPmDir, getNextSprintId, parsePlanDirectory, parseSingleSprint, parseSprintArtifacts, resolvePmDir } from '../plan/parser.js';
import type { Issue } from '../plan/types.js';
import type { HandlerContext } from './handler-context.js';
import { denyIfViewOnly, resolvePlanPath } from './plan-helpers.js';
import type { WebSocketMessage, WSContext } from './types.js';

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

/** Assign issues to a sprint by updating their front matter sprint field. */
function assignIssuesToSprint(workingDir: string, issues: Issue[], issueIds: string[], sprintPath: string): void {
  for (const issueId of issueIds) {
    const issue = issues.find(i => i.id === issueId);
    if (!issue) continue;
    const fullPath = resolvePlanPath(workingDir, issue.path);
    if (!fullPath || !existsSync(fullPath)) continue;
    const content = replaceFrontMatterField(readFileSync(fullPath, 'utf-8'), 'sprint', sprintPath);
    writeFileSync(fullPath, content, 'utf-8');
  }
}

export function handleCreateSprint(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'view',
): void {
  if (denyIfViewOnly(ctx, ws, permission)) return;

  const { title, goal = '', start = '', end = '', issueIds = [] } = msg.data || {};
  if (!title) {
    ctx.send(ws, { type: 'planError', data: { error: 'Sprint title required' } });
    return;
  }

  const pmDir = resolvePmDir(workingDir) ?? defaultPmDir(workingDir);
  const sprintsDir = join(pmDir, 'sprints');
  if (!existsSync(sprintsDir)) mkdirSync(sprintsDir, { recursive: true });

  const fullState = parsePlanDirectory(workingDir);
  const id = fullState ? getNextSprintId(fullState.sprints) : 'SPRINT-001';

  const issueRefs = (issueIds as string[]).map((issueId: string) => {
    const issue = fullState?.issues.find(i => i.id === issueId);
    return issue ? issue.path : `backlog/${issueId}.md`;
  });

  writeFileSync(join(sprintsDir, `${id}.md`), buildSprintMarkdown(id, title, goal, start, end, issueRefs), 'utf-8');

  const sandboxDir = join(sprintsDir, id);
  mkdirSync(join(sandboxDir, 'out'), { recursive: true });
  mkdirSync(join(sandboxDir, 'reviews'), { recursive: true });
  writeFileSync(join(sandboxDir, 'progress.md'), `# ${id}: ${title} — Progress Log\n`, 'utf-8');

  if (issueRefs.length > 0 && fullState) {
    assignIssuesToSprint(workingDir, fullState.issues, issueIds as string[], `sprints/${id}.md`);
  }

  const sprint = parseSingleSprint(workingDir, `sprints/${id}.md`);
  ctx.broadcastToAll({ type: 'planSprintCreated', data: sprint });
}

/** @deprecated Legacy sprint promotion — backlog status removed in v2 board-centric model. */
function promoteSprintIssues(_pmDir: string, _sprint: { issues: Array<{ id: string; path: string }> }, _allIssues: Issue[]): void {
  // No-op: all issues are created with status 'todo' in v2. Legacy sprint promotion is no longer needed.
}

/** Update a file's front matter field if the file exists. */
function updateFileField(filePath: string, field: string, value: string): void {
  if (!existsSync(filePath)) return;
  writeFileSync(filePath, replaceFrontMatterField(readFileSync(filePath, 'utf-8'), field, value), 'utf-8');
}

export function handleActivateSprint(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'view',
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

  updateFileField(join(pmDir, sprint.path), 'status', 'active');
  updateFileField(join(pmDir, 'STATE.md'), 'current_sprint', `"${sprint.path}"`);
  promoteSprintIssues(pmDir, sprint, fullState.issues);

  const updatedSprint = parseSingleSprint(workingDir, sprint.path);
  ctx.broadcastToAll({ type: 'planSprintUpdated', data: updatedSprint });

  const updatedState = parsePlanDirectory(workingDir);
  if (updatedState) {
    ctx.broadcastToAll({ type: 'planStateUpdated', data: updatedState });
  }
}

export function handleCompleteSprint(
  ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage,
  workingDir: string, permission?: 'view',
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

  const sprintIssues = fullState.issues.filter(i => i.sprint === sprint.path);
  const completedIssues = sprintIssues.filter(i => i.status === 'done').length;
  const failedIssues = sprintIssues.filter(i => i.status !== 'done' && i.status !== 'cancelled').length;

  const sprintPath = join(pmDir, sprint.path);
  if (existsSync(sprintPath)) {
    let content = readFileSync(sprintPath, 'utf-8');
    content = replaceFrontMatterField(content, 'status', 'completed');
    content = replaceFrontMatterField(content, 'completed_at', `"${now}"`);
    content = replaceFrontMatterField(content, 'completed', String(completedIssues));

    if (!content.includes('execution_summary:')) {
      const summaryYaml = [
        'execution_summary:',
        `  total_issues: ${sprintIssues.length}`,
        `  completed_issues: ${completedIssues}`,
        `  failed_issues: ${failedIssues}`,
      ].join('\n');
      const fmClose = content.indexOf('\n---', content.indexOf('---') + 3);
      if (fmClose !== -1) {
        content = `${content.slice(0, fmClose)}\n${summaryYaml}${content.slice(fmClose)}`;
      }
    }

    writeFileSync(sprintPath, content, 'utf-8');
  }

  const statePath = join(pmDir, 'STATE.md');
  if (existsSync(statePath)) {
    let stateContent = readFileSync(statePath, 'utf-8');
    stateContent = replaceFrontMatterField(stateContent, 'current_sprint', 'null');
    writeFileSync(statePath, stateContent, 'utf-8');
  }

  const updatedSprint = parseSingleSprint(workingDir, sprint.path);
  ctx.broadcastToAll({ type: 'planSprintCompleted', data: updatedSprint });

  const updatedState = parsePlanDirectory(workingDir);
  if (updatedState) {
    ctx.broadcastToAll({ type: 'planStateUpdated', data: updatedState });
  }
}

export function handleGetSprintArtifacts(
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
    ctx.send(ws, { type: 'planSprintArtifacts', data: { sprintId, progressLog: '', outputFiles: [], reviewResults: [] } });
    return;
  }

  ctx.send(ws, { type: 'planSprintArtifacts', data: artifacts });
}
