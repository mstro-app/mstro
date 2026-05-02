// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Idempotency tracker for client-sent message IDs.
 *
 * The web client assigns a UUID `msgId` to every `execute` message and
 * stores it in a persistent outbox until an `executeAck` arrives. If the
 * web reconnects before the ack lands it replays the same `msgId`; without
 * dedupe the CLI would run the prompt twice (burning tokens, confusing
 * the user). This tracker gives handlers an atomic
 * "first time we've seen this msgId?" check with a bounded TTL so old
 * ids don't leak forever.
 *
 * Design notes:
 *   - TTL (not LRU) — web promises to stop replaying once it gets an ack
 *     or times out the outbox, so a fixed window covers the realistic
 *     replay horizon. 15 minutes matches `tab-event-buffer.ts`.
 *   - Per-tab partitioning so a tab removal can cheaply clear that tab's
 *     history without scanning the whole map.
 *   - Lazy eviction on every check — no timers, cheap in the hot path.
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_PER_TAB = 512;

interface TabEntry {
  ids: Map<string, number>;
}

export class MsgIdTracker {
  private readonly tabs = new Map<string, TabEntry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly maxPerTab: number = DEFAULT_MAX_PER_TAB,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Returns `true` if `msgId` is being recorded for the first time on
   * `tabId`, `false` if it was already seen inside the TTL window. Callers
   * should skip re-execution when this returns `false` but still re-ack
   * so the client's outbox drains.
   */
  recordIfFirst(tabId: string, msgId: string): boolean {
    const entry = this.tabs.get(tabId) ?? { ids: new Map<string, number>() };
    this.evictExpired(entry);
    if (entry.ids.has(msgId)) {
      // Refresh the timestamp so a long stall still counts as "seen".
      entry.ids.set(msgId, this.now());
      return false;
    }
    entry.ids.set(msgId, this.now());
    this.enforceSizeCap(entry);
    this.tabs.set(tabId, entry);
    return true;
  }

  /** Drop all msgIds for a removed tab. */
  forget(tabId: string): void {
    this.tabs.delete(tabId);
  }

  /** Test helper — visible for unit tests only. */
  size(tabId: string): number {
    return this.tabs.get(tabId)?.ids.size ?? 0;
  }

  private evictExpired(entry: TabEntry): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, ts] of entry.ids) {
      if (ts < cutoff) entry.ids.delete(id);
    }
  }

  private enforceSizeCap(entry: TabEntry): void {
    while (entry.ids.size > this.maxPerTab) {
      const firstKey = entry.ids.keys().next().value;
      if (firstKey === undefined) break;
      entry.ids.delete(firstKey);
    }
  }
}
