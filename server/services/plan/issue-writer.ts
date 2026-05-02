// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Issue file mutations: front-matter status updates, activity note appends,
 * stale-issue recovery, and wave-revert logic used by the plan executor.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { checkAllAcceptanceCriteria, setFrontMatterFieldAsync } from './front-matter.js';
import type { Issue } from './types.js';

/** Emits a warning message — caller typically maps this to executor 'output' events. */
export type WarnFn = (message: string, issueId?: string) => void;

/** Matches the `status: <value>` front-matter line (YAML-style, first occurrence). */
const STATUS_LINE_PATTERN = /^status:\s*(\S+)/m;

/**
 * Extract the `status:` front-matter value from an issue-file body. Returns
 * `null` if the field is missing or malformed. Lives here alongside the other
 * front-matter mutators so all modules parse the status identically.
 */
export function extractIssueStatus(content: string): string | null {
  return content.match(STATUS_LINE_PATTERN)?.[1] ?? null;
}

/**
 * Resolve an issue's relative path against a base directory, ensuring it
 * stays inside the base (guards against `..` and absolute-path escapes).
 */
export function validateIssuePath(issuePath: string, baseDir: string): string {
  const resolvedBase = resolve(baseDir);
  const resolvedFull = resolve(resolvedBase, issuePath);
  const rel = relative(resolvedBase, resolvedFull);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Invalid issue path: path traversal detected in "${issuePath}"`);
  }
  return resolvedFull;
}

/**
 * Update an issue's `status:` front-matter field, and — when transitioning
 * to `done` — check off any remaining acceptance-criteria checkboxes.
 */
export async function updateIssueFrontMatter(
  pmDir: string,
  issuePath: string,
  newStatus: string,
  warn: WarnFn,
): Promise<void> {
  try {
    const fullPath = validateIssuePath(issuePath, pmDir);
    await setFrontMatterFieldAsync(fullPath, 'status', newStatus);

    if (newStatus === 'done') {
      const content = await readFile(fullPath, 'utf-8');
      const updated = checkAllAcceptanceCriteria(content);
      if (updated !== content) await writeFile(fullPath, updated, 'utf-8');
    }
  } catch (err) {
    warn(`Warning: failed to update issue front matter for ${issuePath}: ${errMsg(err)}`);
  }
}

/**
 * After a wave fails, revert any issue still stuck in `in_progress` back to
 * its pre-wave status. Silently skips issues already out of `in_progress`.
 */
export async function revertIncompleteIssues(
  pmDir: string,
  issues: Issue[],
  warn: WarnFn,
): Promise<void> {
  for (const issue of issues) {
    const fullPath = validateIssuePath(issue.path, pmDir);
    try {
      const content = await readFile(fullPath, 'utf-8');
      if (extractIssueStatus(content) === 'in_progress') {
        await updateIssueFrontMatter(pmDir, issue.path, issue.status, warn);
      }
    } catch (err) {
      warn(`Warning: failed to revert issue status: ${errMsg(err)}`, issue.id);
    }
  }
}

/** Append a cancellation note to the issue's `## Activity` section. */
export async function appendCancellationNote(
  pmDir: string,
  issue: Issue,
  reason: string,
  warn: WarnFn,
): Promise<void> {
  const fullPath = validateIssuePath(issue.path, pmDir);
  try {
    let content = await readFile(fullPath, 'utf-8');
    const entry = `- Cancelled (${new Date().toISOString().split('T')[0]}): ${reason}`;
    if (content.includes('## Activity')) {
      content = content.replace(/## Activity/, `## Activity\n${entry}`);
    } else {
      content += `\n\n## Activity\n${entry}`;
    }
    await writeFile(fullPath, content, 'utf-8');
  } catch (err) {
    warn(`Warning: failed to append cancellation note: ${errMsg(err)}`, issue.id);
  }
}

/**
 * Recover from a previous interrupted execution by reverting stale
 * `in_progress` and `in_review` issues back to `todo`. Returns the list of
 * recovered issue descriptors (e.g. "FEAT-012 (in_progress → todo)") so the
 * caller can emit a single summary event.
 */
export async function recoverStaleIssues(
  pmDir: string,
  issues: Issue[],
  warn: WarnFn,
): Promise<string[]> {
  const staleStatuses = new Set(['in_progress', 'in_review']);
  const recovered: string[] = [];

  for (const issue of issues) {
    if (issue.type === 'epic') continue;
    if (staleStatuses.has(issue.status)) {
      await updateIssueFrontMatter(pmDir, issue.path, 'todo', warn);
      recovered.push(`${issue.id} (${issue.status} → todo)`);
    }
  }
  return recovered;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
