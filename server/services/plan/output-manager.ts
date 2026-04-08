// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Output Manager — Resolves output paths, lists existing docs, and publishes outputs.
 *
 * Handles sprint-sandboxed and global output directories with fallback.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultPmDir, resolvePmDir } from './parser.js';
import type { Issue } from './types.js';

/** Convert a title to a URL-friendly slug (max 60 chars). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Resolve the canonical output path for an issue.
 * Uses sprint sandbox when available, otherwise global .mstro/pm/out/.
 */
export function resolveOutputPath(issue: Issue, workingDir: string, sprintSandboxDir: string | null): string {
  if (sprintSandboxDir) {
    return join(sprintSandboxDir, 'out', `${issue.id}-${slugify(issue.title)}.md`);
  }
  const pmDir = resolvePmDir(workingDir);
  const outDir = pmDir ? join(pmDir, 'out') : join(defaultPmDir(workingDir), 'out');
  return join(outDir, `${issue.id}-${slugify(issue.title)}.md`);
}

/**
 * List existing execution output docs.
 * Searches sprint sandbox first (higher priority), then global out/.
 */
export function listExistingDocs(workingDir: string, sprintSandboxDir: string | null): string[] {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return [];

  const dirs: string[] = [];
  if (sprintSandboxDir) dirs.push(join(sprintSandboxDir, 'out'));
  dirs.push(join(pmDir, 'out'));

  const docs: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      docs.push(...readdirSync(dir).filter(f => f.endsWith('.md')).map(f => join(dir, f)));
    } catch { /* skip */ }
  }
  return docs;
}

export interface PublishOutputsCallbacks {
  onWarning?: (issueId: string, text: string) => void;
}

/**
 * Copy confirmed-done outputs from .mstro/pm/out/ to user-specified output_file paths.
 * Only copies for issues that completed successfully and have output_file set.
 */
export function publishOutputs(
  issues: Issue[],
  workingDir: string,
  sprintSandboxDir: string | null,
  callbacks?: PublishOutputsCallbacks,
): void {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return;

  for (const issue of issues) {
    publishSingleOutput(issue, pmDir, workingDir, sprintSandboxDir, callbacks);
  }
}

function publishSingleOutput(
  issue: Issue,
  pmDir: string,
  workingDir: string,
  sprintSandboxDir: string | null,
  callbacks?: PublishOutputsCallbacks,
): void {
  if (!issue.outputFile) return;

  // Only publish for confirmed-done issues
  try {
    const content = readFileSync(join(pmDir, issue.path), 'utf-8');
    if (!content.match(/^status:\s*done$/m)) return;
  } catch { return; }

  const srcPath = resolveOutputPath(issue, workingDir, sprintSandboxDir);
  if (!existsSync(srcPath)) return;

  // Guard against path traversal — output_file must resolve within workingDir
  const destPath = resolve(workingDir, issue.outputFile);
  if (!destPath.startsWith(`${workingDir}/`) && destPath !== workingDir) {
    callbacks?.onWarning?.(issue.id, `output_file "${issue.outputFile}" escapes project directory — skipping`);
    return;
  }

  try {
    const destDir = join(destPath, '..');
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    copyFileSync(srcPath, destPath);
  } catch {
    callbacks?.onWarning?.(issue.id, `could not copy output to ${issue.outputFile}`);
  }
}
