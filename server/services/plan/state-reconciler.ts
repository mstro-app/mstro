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
import type { Issue } from './types.js';

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

export function reconcileState(workingDir: string): void {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return;
  const statePath = join(pmDir, 'STATE.md');
  if (!existsSync(statePath)) return;

  const fullState = parsePlanDirectory(workingDir);
  if (!fullState) return;

  const { issues, project } = fullState;

  const issueByPath = new Map(issues.map(i => [i.path, i]));
  const categories = categorizeIssues(issues, issueByPath);
  const warnings = computeWarnings(issues);

  // Read existing front matter
  const content = readFileSync(statePath, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontMatter = fmMatch ? fmMatch[1] : `project: "${project.name}"\ncurrent_sprint: null\nactive_milestone: null\npaused: false\nlast_session: null`;

  const newContent = buildStateMarkdown(frontMatter, categories, warnings, issueByPath);
  writeFileSync(statePath, newContent, 'utf-8');
}
