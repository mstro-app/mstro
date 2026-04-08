// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Dependency Resolver — Validates and computes the dependency DAG.
 *
 * Builds adjacency list from blocked_by/blocks fields, detects cycles,
 * and computes the "ready to work" set.
 */

import type { Issue } from './types.js';

/**
 * Detect cycles in the dependency graph.
 * Returns the first cycle found as an array of issue IDs, or null if acyclic.
 */
export function detectCycles(issues: Issue[]): string[] | null {
  const issueByPath = new Map<string, Issue>();
  for (const issue of issues) {
    issueByPath.set(issue.path, issue);
  }

  // DFS with coloring: 0=white, 1=gray, 2=black
  const color = new Map<string, number>();
  const parent = new Map<string, string>();

  for (const issue of issues) {
    color.set(issue.path, 0);
  }

  for (const issue of issues) {
    if (color.get(issue.path) === 0) {
      const cycle = dfs(issue.path, issueByPath, color, parent);
      if (cycle) return cycle;
    }
  }

  return null;
}

function dfs(
  path: string,
  issueByPath: Map<string, Issue>,
  color: Map<string, number>,
  parent: Map<string, string>,
): string[] | null {
  color.set(path, 1); // Gray
  const issue = issueByPath.get(path);
  if (!issue) {
    color.set(path, 2);
    return null;
  }

  for (const dep of issue.blocks) {
    if (!issueByPath.has(dep)) continue;
    const depColor = color.get(dep);
    if (depColor === 1) {
      // Found cycle — reconstruct
      const cycle = [dep, path];
      let cur = path;
      while (parent.has(cur) && parent.get(cur) !== dep) {
        cur = parent.get(cur)!;
        cycle.push(cur);
      }
      return cycle.map(p => issueByPath.get(p)?.id || p);
    }
    if (depColor === 0) {
      parent.set(dep, path);
      const cycle = dfs(dep, issueByPath, color, parent);
      if (cycle) return cycle;
    }
  }

  color.set(path, 2); // Black
  return null;
}

/**
 * Compute the set of issues that are ready to work on.
 * An issue is ready if:
 * - It's not an epic
 * - Its status is todo (refined and ready for execution)
 * - All its blocked_by items are done or cancelled
 *
 * If epicScope is provided, only returns issues belonging to that epic.
 */
export function resolveReadyToWork(issues: Issue[], epicScope?: string, sprintScope?: string): Issue[] {
  const issueByPath = new Map<string, Issue>();
  for (const issue of issues) {
    issueByPath.set(issue.path, issue);
  }

  const readyStatuses = new Set(['todo']);
  const doneStatuses = new Set(['done', 'cancelled']);

  const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

  // Build set of child paths for epic scoping
  let epicChildPaths: Set<string> | null = null;
  if (epicScope) {
    const epic = issueByPath.get(epicScope);
    if (epic) {
      epicChildPaths = new Set(epic.children);
      // Also include issues that reference this epic via their epic field
      for (const issue of issues) {
        if (issue.epic === epicScope) epicChildPaths.add(issue.path);
      }
    }
  }

  return issues
    .filter(issue => {
      if (issue.type === 'epic') return false;
      if (!readyStatuses.has(issue.status)) return false;

      // If scoped to an epic, only include that epic's children
      if (epicChildPaths && !epicChildPaths.has(issue.path)) return false;

      // If scoped to a sprint, only include issues assigned to that sprint
      if (sprintScope && issue.sprint !== sprintScope) return false;

      // Check all blockers are resolved
      if (issue.blockedBy.length > 0) {
        const allResolved = issue.blockedBy.every(bp => {
          const blocker = issueByPath.get(bp);
          return blocker && doneStatuses.has(blocker.status);
        });
        if (!allResolved) return false;
      }

      return true;
    })
    .sort((a, b) => {
      // Sort by priority (P0 first)
      return (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9);
    });
}

/**
 * Compute the critical path through incomplete issues.
 * Returns the longest chain of dependent issues.
 */
export function computeCriticalPath(issues: Issue[]): Issue[] {
  const issueByPath = new Map<string, Issue>();
  for (const issue of issues) {
    issueByPath.set(issue.path, issue);
  }

  const doneStatuses = new Set(['done', 'cancelled']);
  const incompleteIssues = issues.filter(i => !doneStatuses.has(i.status) && i.type !== 'epic');

  // Compute longest path using DFS with memoization
  const longestFrom = new Map<string, Issue[]>();

  function getLongest(path: string): Issue[] {
    if (longestFrom.has(path)) return longestFrom.get(path)!;

    const issue = issueByPath.get(path);
    if (!issue || doneStatuses.has(issue.status)) {
      longestFrom.set(path, []);
      return [];
    }

    // Set sentinel before recursing to break cycles
    longestFrom.set(path, [issue]);

    let best: Issue[] = [];
    for (const dep of issue.blocks) {
      const sub = getLongest(dep);
      if (sub.length > best.length) best = sub;
    }

    const result = [issue, ...best];
    longestFrom.set(path, result);
    return result;
  }

  let criticalPath: Issue[] = [];
  for (const issue of incompleteIssues) {
    const path = getLongest(issue.path);
    if (path.length > criticalPath.length) criticalPath = path;
  }

  return criticalPath;
}
