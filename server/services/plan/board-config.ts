// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Board configuration helpers: read board.md + workspace.json settings
 * used by the plan executor (max parallel agents, review criteria,
 * active board resolution, board activation/completion).
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replaceFrontMatterField } from './front-matter.js';

/** Emits a warning message — caller typically maps this to executor 'output' events. */
export type WarnFn = (message: string) => void;

export const DEFAULT_MAX_PARALLEL_AGENTS = 3;

/** Read the board's maxParallelAgents setting, falling back to default. */
export async function getBoardMaxParallelAgents(
  pmDir: string | null,
  boardId: string | null,
  warn: WarnFn,
): Promise<number> {
  if (!pmDir || !boardId) return DEFAULT_MAX_PARALLEL_AGENTS;
  const boardMdPath = join(pmDir, 'boards', boardId, 'board.md');
  if (!existsSync(boardMdPath)) return DEFAULT_MAX_PARALLEL_AGENTS;
  try {
    const content = await readFile(boardMdPath, 'utf-8');
    const match = content.match(/^max_parallel_agents:\s*(\d+)/m);
    return match ? Math.max(1, Math.min(Number(match[1]), 10)) : DEFAULT_MAX_PARALLEL_AGENTS;
  } catch (err) {
    warn(`Warning: failed to read board max_parallel_agents: ${errMsg(err)}`);
    return DEFAULT_MAX_PARALLEL_AGENTS;
  }
}

/** Read the board's custom review criteria, if set. */
export async function getBoardReviewCriteria(
  pmDir: string | null,
  boardId: string | null,
  warn: WarnFn,
): Promise<string | undefined> {
  if (!pmDir || !boardId) return undefined;
  const boardMdPath = join(pmDir, 'boards', boardId, 'board.md');
  if (!existsSync(boardMdPath)) return undefined;
  try {
    const content = await readFile(boardMdPath, 'utf-8');
    const match = content.match(/^review_criteria:\s*"(.+)"/m);
    if (!match) return undefined;
    const raw = match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
    return raw || undefined;
  } catch (err) {
    warn(`Warning: failed to read board review criteria: ${errMsg(err)}`);
    return undefined;
  }
}

/** Read workspace.json to find the currently active board. */
export function resolveActiveBoardId(pmDir: string | null): string | null {
  if (!pmDir) return null;
  try {
    const workspacePath = join(pmDir, 'workspace.json');
    if (!existsSync(workspacePath)) return null;
    const workspace = JSON.parse(readFileSync(workspacePath, 'utf-8'));
    return workspace.activeBoardId ?? null;
  } catch {
    return null;
  }
}

/** Resolve the active board's directory path. */
export function resolveBoardDir(pmDir: string | null, boardId: string | null): string | null {
  if (!pmDir) return null;
  const effective = boardId ?? resolveActiveBoardId(pmDir);
  if (!effective) return null;
  const boardDir = join(pmDir, 'boards', effective);
  return existsSync(boardDir) ? boardDir : null;
}

/** Activate a draft board by updating its status in board.md. */
export async function activateBoard(pmDir: string, boardId: string, warn: WarnFn): Promise<void> {
  const boardMdPath = join(pmDir, 'boards', boardId, 'board.md');
  if (!existsSync(boardMdPath)) return;
  try {
    const content = await readFile(boardMdPath, 'utf-8');
    await writeFile(boardMdPath, replaceFrontMatterField(content, 'status', 'active'), 'utf-8');
  } catch (err) {
    warn(`Warning: failed to activate board ${boardId}: ${errMsg(err)}`);
  }
}

/**
 * Mark a board as completed iff all its issues are `done` or `cancelled`.
 * No-op when the board is not fully complete.
 */
export async function tryCompleteBoardIfDone(
  pmDir: string,
  boardId: string,
  issues: { status: string }[],
  warn: WarnFn,
): Promise<void> {
  const allDone = issues.length > 0 && issues.every(i => i.status === 'done' || i.status === 'cancelled');
  if (!allDone) return;

  const boardMdPath = join(pmDir, 'boards', boardId, 'board.md');
  if (!existsSync(boardMdPath)) return;

  try {
    let content = await readFile(boardMdPath, 'utf-8');
    content = replaceFrontMatterField(content, 'status', 'completed');
    content = replaceFrontMatterField(content, 'completed_at', `"${new Date().toISOString()}"`);
    await writeFile(boardMdPath, content, 'utf-8');
  } catch (err) {
    warn(`Warning: failed to mark board ${boardId} as completed: ${errMsg(err)}`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
