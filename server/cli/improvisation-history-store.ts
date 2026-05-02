// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Persistence helpers for improvisation session history.
 *
 * Resolves the `.mstro/history/<timestamp>.json` location for a session
 * and reads/writes its JSON payload. No in-memory state — callers pass
 * the current `SessionHistory` object.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { herror } from './headless/headless-logger.js';
import type { SessionHistory } from './improvisation-types.js';

export interface HistoryPaths {
  improviseDir: string;
  historyPath: string;
}

export function resolveHistoryPaths(workingDir: string, sessionId: string): HistoryPaths {
  const improviseDir = join(workingDir, '.mstro', 'history');
  const historyPath = join(improviseDir, `${sessionId.replace('improv-', '')}.json`);
  return { improviseDir, historyPath };
}

/** Create the `.mstro/history/` directory if missing. */
export function ensureHistoryDir(improviseDir: string): void {
  if (!existsSync(improviseDir)) {
    mkdirSync(improviseDir, { recursive: true });
  }
}

/**
 * Load a session's history JSON. Returns a fresh empty history if the file
 * doesn't exist or is unreadable (errors are logged but not thrown).
 */
export function loadHistory(historyPath: string, sessionId: string): SessionHistory {
  if (existsSync(historyPath)) {
    try {
      const data = readFileSync(historyPath, 'utf-8');
      return JSON.parse(data) as SessionHistory;
    } catch (error) {
      herror('Failed to load history:', error);
    }
  }
  const now = new Date().toISOString();
  return {
    sessionId,
    startedAt: now,
    lastActivityAt: now,
    totalTokens: 0,
    movements: [],
  };
}

/** Write history to disk after bumping `lastActivityAt`. */
export function saveHistory(historyPath: string, history: SessionHistory): void {
  history.lastActivityAt = new Date().toISOString();
  writeFileSync(historyPath, JSON.stringify(history, null, 2));
}
