// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * State Reconciler — Recomputes STATE.md from individual issue files.
 *
 * When individual issues change (detected by watcher), this module
 * scans all backlog files and rebuilds the STATE.md sections.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveReadyToWork } from './dependency-resolver.js';
import { replaceFrontMatterField, replaceYamlField } from './front-matter.js';
import { isBoardCentricFormat, parseBoardDirectory, parsePlanDirectory, resolvePmDir } from './parser.js';
import type { Issue, Sprint } from './types.js';

interface CategorizedIssues {
  inProgress: Issue[];
  blocked: Issue[];
  recentlyCompleted: Issue[];
  readyToWork: Issue[];
}

function categorizeIssues(issues: Issue[], issueByPath: Map<string, Issue>): CategorizedIssues {
  const inProgress: Issue[] = [];
  const blocked: Issue[] = [];
  const recentlyCompleted: Issue[] = [];
  const readyToWork = resolveReadyToWork(issues);

  for (const issue of issues) {
    if (issue.type === 'epic') continue;

    if (issue.status === 'in_progress' || issue.status === 'in_review') {
      inProgress.push(issue);
    } else if (issue.blockedBy.length > 0 && issue.status !== 'done' && issue.status !== 'cancelled') {
      const allBlockersDone = issue.blockedBy.every(bp => {
        const blocker = issueByPath.get(bp);
        return blocker && (blocker.status === 'done' || blocker.status === 'cancelled');
      });
      if (!allBlockersDone) {
        blocked.push(issue);
      }
    }

    if (issue.status === 'done') {
      recentlyCompleted.push(issue);
    }
  }

  return { inProgress, blocked, recentlyCompleted, readyToWork };
}

function computeWarnings(issues: Issue[]): string[] {
  const warnings: string[] = [];
  const today = new Date().toISOString().split('T')[0];

  for (const issue of issues) {
    if (issue.due && issue.due <= today && issue.status !== 'done' && issue.status !== 'cancelled') {
      const daysOverdue = Math.ceil((Date.now() - new Date(issue.due).getTime()) / (1000 * 60 * 60 * 24));
      warnings.push(`${issue.id} due date was ${issue.due} (${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} overdue)`);
    }
  }

  return warnings;
}

function buildStateMarkdown(
  frontMatter: string,
  categories: CategorizedIssues,
  warnings: string[],
  issueByPath: Map<string, Issue>,
  header = '# Project State',
): string {
  const formatSummary = (issue: Issue, index: number): string => {
    return `${index + 1}. [${issue.id}](${issue.path}) — ${issue.title} (${issue.priority})`;
  };

  const formatBlocked = (issue: Issue): string => {
    const blockerIds = issue.blockedBy.map(bp => {
      const blocker = issueByPath.get(bp);
      return blocker ? `[${blocker.id}](${blocker.path})` : bp;
    }).join(', ');
    return `- [${issue.id}](${issue.path}) — ${issue.title} → blocked by ${blockerIds}`;
  };

  const sections = [
    header,
    '',
    '## Current Focus',
    '',
    '## Ready to Work',
    ...categories.readyToWork.map(formatSummary),
    '',
    '## In Progress',
    ...categories.inProgress.map(issue => `- [${issue.id}](${issue.path}) — ${issue.title}`),
    '',
    '## Blocked',
    ...categories.blocked.map(formatBlocked),
    '',
    '## Recently Completed',
    ...categories.recentlyCompleted.slice(0, 10).map(issue => `- [${issue.id}](${issue.path}) — ${issue.title} ✓`),
    '',
    '## Warnings',
    ...warnings.map(w => `- ${w}`),
    '',
  ];

  return `---\n${frontMatter}\n---\n\n${sections.join('\n')}`;
}

/**
 * Derive epic status from its children's actual statuses.
 * - All children done/cancelled → done
 * - Any child in_progress/in_review → in_progress
 * - Otherwise → null (no change)
 */
function deriveEpicStatus(epic: Issue, issueByPath: Map<string, Issue>): string | null {
  if (epic.children.length === 0) return null;
  if (epic.status === 'done' || epic.status === 'cancelled') return null;

  const childStatuses = epic.children.map(cp => issueByPath.get(cp)?.status).filter(Boolean) as string[];
  if (childStatuses.length === 0) return null;

  const allFinished = childStatuses.every(s => s === 'done' || s === 'cancelled');
  if (allFinished) return 'done';

  const anyStarted = childStatuses.some(s => s === 'in_progress' || s === 'in_review');
  if (anyStarted && epic.status !== 'in_progress') return 'in_progress';

  return null;
}

function reconcileEpicStatuses(pmDir: string, issues: Issue[], issueByPath: Map<string, Issue>): void {
  const epics = issues.filter(i => i.type === 'epic');
  for (const epic of epics) {
    const derived = deriveEpicStatus(epic, issueByPath);
    if (!derived) continue;

    const epicPath = join(pmDir, epic.path);
    try {
      let content = readFileSync(epicPath, 'utf-8');
      content = replaceFrontMatterField(content, 'status', derived);
      writeFileSync(epicPath, content, 'utf-8');
    } catch {
      // Epic file may be missing or unwritable
    }
  }
}

/**
 * Derive sprint status from its issues' actual statuses.
 * - All issues done/cancelled → completed
 * - Any issue in_progress/in_review → active
 * - Otherwise → planned (unchanged)
 */
function deriveSprintStatus(sprint: Sprint, issueByPath: Map<string, Issue>): Sprint['status'] | null {
  // Sprint references issues by path (e.g., "backlog/IS-001.md")
  const issuePaths = sprint.issues.map(si => si.path);
  if (issuePaths.length === 0) return null;

  const statuses = issuePaths.map(p => issueByPath.get(p)?.status).filter(Boolean) as string[];
  if (statuses.length === 0) return null;

  const allFinished = statuses.every(s => s === 'done' || s === 'cancelled');
  if (allFinished) return 'completed';

  const anyStarted = statuses.some(s => s === 'in_progress' || s === 'in_review');
  if (anyStarted) return 'active';

  return null;
}

function reconcileSprintStatuses(pmDir: string, sprints: Sprint[], issueByPath: Map<string, Issue>): void {
  for (const sprint of sprints) {
    const derived = deriveSprintStatus(sprint, issueByPath);
    if (!derived || derived === sprint.status) continue;

    const sprintPath = join(pmDir, sprint.path);
    try {
      let content = readFileSync(sprintPath, 'utf-8');
      content = replaceFrontMatterField(content, 'status', derived);

      // Write completed_at when transitioning to completed
      if (derived === 'completed' && !content.match(/^completed_at:/m)) {
        const timestamp = new Date().toISOString().split('T')[0];
        content = replaceFrontMatterField(content, 'completed_at', timestamp);
      }

      writeFileSync(sprintPath, content, 'utf-8');
    } catch {
      // Sprint file may be missing or unwritable
    }
  }
}

/**
 * After an issue is updated, check if its parent epic should be auto-completed.
 * Returns the epic's relative path if it was marked done, null otherwise.
 */
export function tryCompleteParentEpic(workingDir: string, updatedIssue: Issue): string | null {
  if (!updatedIssue.epic) return null;

  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return null;

  // Determine which board the issue belongs to from its path
  const boardMatch = updatedIssue.path.match(/^boards\/([^/]+)\//);
  const issues = boardMatch
    ? parseBoardDirectory(pmDir, boardMatch[1])?.issues
    : parsePlanDirectory(workingDir)?.issues;
  if (!issues) return null;

  const epic = issues.find(i => i.path === updatedIssue.epic);
  if (!epic) return null;

  const issueByPath = new Map(issues.map(i => [i.path, i]));
  const derived = deriveEpicStatus(epic, issueByPath);
  if (derived !== 'done') return null;

  const epicFullPath = join(pmDir, epic.path);
  try {
    let content = readFileSync(epicFullPath, 'utf-8');
    content = replaceFrontMatterField(content, 'status', 'done');
    writeFileSync(epicFullPath, content, 'utf-8');
    return epic.path;
  } catch {
    return null;
  }
}

export function reconcileState(workingDir: string, boardId?: string): void {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return;

  // Board-centric: reconcile a specific board's STATE.md
  if (isBoardCentricFormat(pmDir)) {
    reconcileBoardState(pmDir, workingDir, boardId);
    return;
  }

  // Legacy sprint-based reconciliation
  const statePath = join(pmDir, 'STATE.md');
  if (!existsSync(statePath)) return;

  const fullState = parsePlanDirectory(workingDir);
  if (!fullState) return;

  const { issues, sprints, project } = fullState;

  const issueByPath = new Map(issues.map(i => [i.path, i]));
  const categories = categorizeIssues(issues, issueByPath);
  const warnings = computeWarnings(issues);

  // Read existing front matter
  const content = readFileSync(statePath, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontMatter = fmMatch ? fmMatch[1] : `project: "${project.name}"\ncurrent_sprint: null\nactive_milestone: null\npaused: false\nlast_session: null`;

  // Reconcile epic and sprint statuses from actual issue statuses
  reconcileEpicStatuses(pmDir, issues, issueByPath);
  reconcileSprintStatuses(pmDir, sprints, issueByPath);

  // Update current_sprint in front matter based on actual sprint statuses
  const recomputedActive = sprints.find(s => {
    const derived = deriveSprintStatus(s, issueByPath);
    return (derived ?? s.status) === 'active';
  });
  const updatedFM = replaceYamlField(frontMatter, 'current_sprint', recomputedActive ? recomputedActive.id : 'null');

  const newContent = buildStateMarkdown(updatedFM, categories, warnings, issueByPath);
  writeFileSync(statePath, newContent, 'utf-8');
}

function reconcileBoardState(pmDir: string, _workingDir: string, boardId?: string): void {
  // Determine which board to reconcile
  const effectiveBoardId = boardId ?? resolveActiveBoardId(pmDir);
  if (!effectiveBoardId) return;

  const boardState = parseBoardDirectory(pmDir, effectiveBoardId);
  if (!boardState) return;

  const statePath = join(pmDir, 'boards', effectiveBoardId, 'STATE.md');
  if (!existsSync(statePath)) return;

  const { board, issues } = boardState;

  const issueByPath = new Map(issues.map(i => [i.path, i]));

  // Reconcile epic statuses before categorizing
  reconcileEpicStatuses(pmDir, issues, issueByPath);

  const categories = categorizeIssues(issues, issueByPath);
  const warnings = computeWarnings(issues);

  // Read existing front matter from the board's STATE.md
  const content = readFileSync(statePath, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontMatter = fmMatch ? fmMatch[1] : `board: "${board.id}"\npaused: false\nlast_session: null`;

  const newContent = buildStateMarkdown(frontMatter, categories, warnings, issueByPath, '# Board State');
  writeFileSync(statePath, newContent, 'utf-8');
}

function resolveActiveBoardId(pmDir: string): string | null {
  const wsPath = join(pmDir, 'workspace.json');
  if (!existsSync(wsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(wsPath, 'utf-8'));
    return typeof parsed.activeBoardId === 'string' ? parsed.activeBoardId : null;
  } catch {
    return null;
  }
}
