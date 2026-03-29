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
import { parsePlanDirectory, resolvePmDir } from './parser.js';
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
    '# Project State',
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
      content = content.replace(/^(status:\s*).+$/m, `$1${derived}`);
      writeFileSync(sprintPath, content, 'utf-8');
    } catch {
      // Sprint file may be missing or unwritable
    }
  }
}

export function reconcileState(workingDir: string): void {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return;
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

  const newContent = buildStateMarkdown(frontMatter, categories, warnings, issueByPath);
  writeFileSync(statePath, newContent, 'utf-8');

  // Reconcile sprint statuses from actual issue statuses
  reconcileSprintStatuses(pmDir, sprints, issueByPath);
}
