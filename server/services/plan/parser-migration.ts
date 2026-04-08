// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Legacy → Board-centric migration for .mstro/pm/ directories.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontMatter } from './parser-core.js';

/** Check whether a .mstro/pm/ directory uses the legacy flat format (has backlog/ at root, no boards/). */
export function isLegacyFormat(pmDir: string): boolean {
  return existsSync(join(pmDir, 'backlog')) && !existsSync(join(pmDir, 'boards'));
}

function readFileIfExists(path: string): string | null {
  try {
    if (existsSync(path)) return readFileSync(path, 'utf-8');
  } catch { /* skip */ }
  return null;
}

/** Move all files from a legacy directory into a board subdirectory and remove the source. */
function moveLegacyDir(srcDir: string, destDir: string): void {
  if (!existsSync(srcDir)) return;
  for (const file of readdirSync(srcDir)) {
    renameSync(join(srcDir, file), join(destDir, file));
  }
  rmSync(srcDir, { recursive: true });
}

/** Move a single file if it exists. */
function moveLegacyFile(src: string, dest: string): void {
  if (existsSync(src)) renameSync(src, dest);
}

/** Copy review files from sprint sandbox directories into the board reviews dir. */
function copySprintReviews(sprintsDir: string, boardReviewsDir: string): void {
  for (const entry of readdirSync(sprintsDir)) {
    if (entry.endsWith('.md')) continue;
    const reviewsDir = join(sprintsDir, entry, 'reviews');
    if (!existsSync(reviewsDir)) continue;
    for (const reviewFile of readdirSync(reviewsDir)) {
      cpSync(join(reviewsDir, reviewFile), join(boardReviewsDir, reviewFile));
    }
  }
}

/** Find and return the goal from the active sprint .md file. */
function extractActiveSprintGoal(sprintsDir: string): string {
  for (const entry of readdirSync(sprintsDir).filter(e => e.endsWith('.md'))) {
    const content = readFileIfExists(join(sprintsDir, entry));
    if (!content) continue;
    const fm = parseFrontMatter(content).frontMatter;
    if (fm.status === 'active') return String(fm.goal || '');
  }
  return '';
}

/** Migrate active sprint data into the board and archive sprints dir. */
function migrateLegacySprints(sprintsDir: string, boardReviewsDir: string): string {
  if (!existsSync(sprintsDir)) return '';
  const goal = extractActiveSprintGoal(sprintsDir);
  copySprintReviews(sprintsDir, boardReviewsDir);
  return goal;
}

/** Remove issues from the board backlog that are already tracked via paths in STATE.md */
function cleanupMigratedIssues(boardBacklogDir: string): boolean {
  let hasActive = false;
  for (const f of readdirSync(boardBacklogDir).filter(f => f.endsWith('.md'))) {
    const content = readFileIfExists(join(boardBacklogDir, f));
    if (!content) continue;
    const fm = parseFrontMatter(content).frontMatter;
    const status = String(fm.status || 'todo');
    if (status === 'done' || status === 'closed' || status === 'cancelled') {
      rmSync(join(boardBacklogDir, f));
    } else if (status !== 'todo') {
      hasActive = true;
    }
  }
  return hasActive;
}

/** Write the board.md metadata file and optionally a STATE.md for active boards. */
function writeBoardMetadata(pmDir: string, boardDir: string, boardId: string, sprintGoal: string, hasActive: boolean): void {
  const today = new Date().toISOString().split('T')[0];
  const goal = sprintGoal || 'Migrated board';
  writeFileSync(join(boardDir, 'board.md'), [
    '---', `id: ${boardId}`, `title: Board 1`, `status: ${hasActive ? 'active' : 'draft'}`,
    `created: ${today}`, `goal: ${goal}`, '---', '', `# Board 1`, '', `## Goal`, '', goal, '',
  ].join('\n'));

  // Copy existing STATE.md into the board directory
  const legacyState = readFileIfExists(join(pmDir, 'STATE.md'));
  if (legacyState) {
    writeFileSync(join(boardDir, 'STATE.md'), legacyState);
  }

  // Write workspace.json pointing at the new board
  writeFileSync(join(pmDir, 'workspace.json'), JSON.stringify({
    activeBoardId: boardId, boardOrder: [boardId],
  }, null, 2));
}

/** Migrate a legacy flat .mstro/pm/ directory to the board-centric format. */
export function migrateToBoards(pmDir: string): void {
  const boardId = 'BOARD-001';
  const boardDir = join(pmDir, 'boards', boardId);
  mkdirSync(join(boardDir, 'backlog'), { recursive: true });
  mkdirSync(join(boardDir, 'reviews'), { recursive: true });
  mkdirSync(join(boardDir, 'out'), { recursive: true });

  moveLegacyDir(join(pmDir, 'backlog'), join(boardDir, 'backlog'));
  moveLegacyFile(join(pmDir, 'progress.md'), join(boardDir, 'progress.md'));

  const boardReviewsDir = join(boardDir, 'reviews');
  const sprintGoal = migrateLegacySprints(join(pmDir, 'sprints'), boardReviewsDir);
  const hasActive = cleanupMigratedIssues(join(boardDir, 'backlog'));
  writeBoardMetadata(pmDir, boardDir, boardId, sprintGoal, hasActive);

  // Remove migrated top-level items (STATE.md is now inside the board)
  for (const f of ['STATE.md']) {
    const p = join(pmDir, f);
    if (existsSync(p)) rmSync(p);
  }
}
