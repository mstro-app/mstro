// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Issue loader: wraps parser.ts to load either board-scoped or
 * project-level issues, emitting error/activation signals via callbacks
 * so it stays decoupled from the EventEmitter in PlanExecutor.
 */

import { activateBoard } from './board-config.js';
import type { WarnFn } from './issue-writer.js';
import { parseBoardDirectory, parsePlanDirectory } from './parser.js';
import type { Issue } from './types.js';

export interface IssueLoaderHandlers {
  /** Invoked when the board/project is in an unloadable state (not found, paused, etc.). */
  onError: (message: string) => void;
  /** Invoked to forward warnings from `activateBoard` side-effects. */
  warn: WarnFn;
}

/**
 * Load issues from a specific board, auto-activating draft boards.
 * Returns null on error (and invokes `handlers.onError`).
 */
export async function loadBoardIssues(
  pmDir: string,
  boardId: string,
  handlers: IssueLoaderHandlers,
): Promise<Issue[] | null> {
  const boardState = parseBoardDirectory(pmDir, boardId);
  if (!boardState) {
    handlers.onError(`Board not found: ${boardId}`);
    return null;
  }
  if (boardState.state.paused) {
    handlers.onError('Board is paused');
    return null;
  }
  if (boardState.board.status === 'draft') {
    await activateBoard(pmDir, boardId, handlers.warn);
  } else if (boardState.board.status !== 'active') {
    handlers.onError(`Board ${boardId} is not active (status: ${boardState.board.status})`);
    return null;
  }
  return boardState.issues;
}

/** Load project-level issues (legacy or no boards). Returns null on error. */
export function loadProjectIssues(
  workingDir: string,
  handlers: Pick<IssueLoaderHandlers, 'onError'>,
): Issue[] | null {
  const fullState = parsePlanDirectory(workingDir);
  if (!fullState) {
    handlers.onError('No PM directory found');
    return null;
  }
  if (fullState.state.paused) {
    handlers.onError('Project is paused');
    return null;
  }
  return fullState.issues;
}
