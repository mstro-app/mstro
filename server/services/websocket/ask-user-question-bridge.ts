// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * AskUserQuestion Bridge
 *
 * Bridges the MCP bouncer subprocess (which receives Claude's AskUserQuestion
 * tool calls) and the web client (which collects the user's answers).
 *
 * Flow:
 *   Claude → MCP bouncer (subprocess)
 *          → POST /internal/ask-user-question (this CLI server)
 *          → registerPendingQuestion() stores a resolver
 *          → broadcastTabEvent('askUserQuestion', …) pushes the question to web
 *          → web user answers → WS `askUserQuestionResponse`
 *          → resolvePendingQuestion() resolves the awaited promise
 *          → HTTP response to bouncer with answers
 *          → bouncer returns { behavior: "allow", updatedInput: { questions, answers } }
 *
 * Ownership of state: pending questions live only here, in-process. The
 * registry is keyed by `toolUseId` (Claude's per-call id) which guarantees
 * uniqueness across tabs and sessions.
 *
 * Timeouts: questions auto-reject after `DEFAULT_TIMEOUT_MS`. The bouncer's
 * HTTP call gets a 504 and returns a deny to Claude rather than blocking the
 * Claude turn forever.
 */

import { randomUUID } from 'node:crypto';

/** Default per-question timeout (15 minutes). */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

interface PendingQuestion {
  toolUseId: string;
  tabId: string;
  resolve: (answers: Record<string, string>) => void;
  reject: (reason: 'timeout' | 'cancelled' | 'session-ended') => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

const pending = new Map<string, PendingQuestion>();

/** Per-process secret the MCP bouncer must echo to authenticate.
 *  Generated once at server start, passed to bouncers via env var. */
const bouncerSharedSecret = randomUUID();

/** Get the per-process bouncer secret (passed via env var to bouncer subprocesses). */
export function getBouncerSecret(): string {
  return bouncerSharedSecret;
}

/** Validate a secret claimed by an inbound /internal request. */
export function isValidBouncerSecret(secret: string | undefined | null): boolean {
  if (!secret) return false;
  return secret === bouncerSharedSecret;
}

export interface RegisterPendingQuestionOptions {
  toolUseId: string;
  tabId: string;
  timeoutMs?: number;
}

/**
 * Register a pending question. The returned promise resolves when
 * `resolvePendingQuestion` is called for the same toolUseId, or rejects on
 * timeout / cancellation.
 */
export function registerPendingQuestion(
  opts: RegisterPendingQuestionOptions,
): Promise<Record<string, string>> {
  const { toolUseId, tabId, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  // Defensive: reject any prior pending entry for this id (shouldn't happen
  // but a process restart or duplicate POST shouldn't leak handlers).
  const existing = pending.get(toolUseId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.reject('cancelled');
    pending.delete(toolUseId);
  }

  return new Promise<Record<string, string>>((resolve, reject) => {
    const timer = setTimeout(() => {
      const entry = pending.get(toolUseId);
      if (!entry) return;
      pending.delete(toolUseId);
      entry.reject('timeout');
    }, timeoutMs);

    pending.set(toolUseId, {
      toolUseId,
      tabId,
      resolve,
      reject: (reason) => reject(new Error(reason)),
      timer,
      createdAt: Date.now(),
    });
  });
}

/**
 * Resolve a pending question with the user's answers. Returns true if a
 * pending entry was found and resolved; false if there was no matching
 * pending question (already answered, timed out, or unknown id).
 */
export function resolvePendingQuestion(
  toolUseId: string,
  answers: Record<string, string>,
): boolean {
  const entry = pending.get(toolUseId);
  if (!entry) return false;
  pending.delete(toolUseId);
  clearTimeout(entry.timer);
  entry.resolve(answers);
  return true;
}

/**
 * Cancel all pending questions for a given tab. Used when a tab is removed,
 * a session is reset, or an orchestra disconnects. Returns the toolUseIds
 * that were cancelled so callers can broadcast `askUserQuestionDismissed`.
 */
export function cancelPendingQuestionsForTab(
  tabId: string,
  reason: 'cancelled' | 'session-ended' = 'cancelled',
): string[] {
  const cancelled: string[] = [];
  for (const [id, entry] of pending) {
    if (entry.tabId !== tabId) continue;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(reason);
    cancelled.push(id);
  }
  return cancelled;
}

/** Look up the tab that owns a pending question, or undefined. */
export function getPendingQuestionTab(toolUseId: string): string | undefined {
  return pending.get(toolUseId)?.tabId;
}

/** Diagnostic: how many questions are currently waiting on user input. */
export function pendingQuestionCount(): number {
  return pending.size;
}
