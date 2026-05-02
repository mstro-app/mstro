// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Pure helpers for wave readiness: human-readable completion reasons
 * and detection of "dead" issues stuck in non-terminal states.
 */

import type { Issue } from './types.js';

const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

/** Build the user-facing completion message shown when no issues remain. */
export function buildCompletionReason(issues: Issue[], epicScope: string | null): string {
  const nonEpic = issues.filter(i => i.type !== 'epic');
  const done = nonEpic.filter(i => TERMINAL_STATUSES.has(i.status)).length;
  const blocked = nonEpic.filter(i => i.status === 'todo').length;
  if (done === nonEpic.length) return epicScope ? 'All epic issues are done' : 'All issues are done';
  if (blocked > 0) return `${done}/${nonEpic.length} issues done, ${blocked} blocked by incomplete dependencies`;
  return epicScope ? 'All epic issues are done or blocked' : 'All work is done or blocked';
}

/**
 * Detect issues stuck in non-terminal states with no path to completion.
 * Returns a human-readable reason, or null when the board is healthy.
 */
export function detectDeadState(issues: Issue[]): string | null {
  const nonEpic = issues.filter(i => i.type !== 'epic');
  const stuck = nonEpic.filter(i => !TERMINAL_STATUSES.has(i.status) && i.status !== 'todo');
  if (stuck.length === 0) return null;

  const stuckIds = stuck.map(i => `${i.id} (${i.status})`).join(', ');

  const issueByPath = new Map(issues.map(i => [i.path, i]));
  const blockedByStuck = nonEpic.filter(i => {
    if (i.status !== 'todo') return false;
    return i.blockedBy.some(bp => {
      const blocker = issueByPath.get(bp);
      return blocker && !TERMINAL_STATUSES.has(blocker.status);
    });
  });
  const blockedIds = blockedByStuck.map(i => i.id).join(', ');

  return `Board stuck: ${stuckIds} cannot progress${blockedIds ? `. Blocking: ${blockedIds}` : ''}`;
}

/** True iff any non-epic issue is stuck in a non-terminal, non-todo state. */
export function hasBlockedIssues(issues: Issue[]): boolean {
  return issues.some(i => i.type !== 'epic' && !TERMINAL_STATUSES.has(i.status) && i.status !== 'todo');
}
