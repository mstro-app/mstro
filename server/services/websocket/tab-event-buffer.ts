// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Tab event buffer — monotonic, bounded replay log for tab-scoped broadcasts.
 *
 * ## Why it exists
 *
 * The platform relay only fans out broadcasts to webs currently paired to the
 * CLI's connection key. During a CLI-side platform reconnect the CLI's key
 * rotates (new `connectionId`) and any web whose transport was pointing at
 * the old key sees no events until it completes its own reconnect handshake.
 * The `executionEventLog` on the session manager covers in-flight execution,
 * but smaller lifecycle events — `movementStart`, `movementComplete`,
 * `tabStateChanged`, `sessionUpdate`, approve/reject acknowledgements — can
 * land in that dark window and be lost.
 *
 * This buffer records every tab-scoped broadcast with a monotonic per-tab
 * `seq`. When the web sends `initTab` / `resumeSession` with its
 * `lastSeenSeq`, we replay anything newer before emitting `tabInitialized`.
 *
 * ## Design choices
 *
 * - **Bounded by both count and age** so a long-idle tab doesn't keep ancient
 *   events forever, and a chatty session doesn't balloon memory. The limits
 *   are intentionally generous: 1000 events + 15 minutes covers a typical
 *   reconnect window by orders of magnitude, and events are small objects.
 * - **Per-tab registry, not per-session** because the web identifies replay
 *   targets by `tabId`, which is stable across `new` (sessionId rotates, tab
 *   doesn't).
 * - **No sequencing gaps**: `nextSeq` strictly increments, even when the
 *   buffer drops old events. The web compares `seq > lastSeenSeq`, so stale
 *   numbering below the window is fine — everything the web hasn't seen yet
 *   has a larger seq.
 */

export interface BufferedEvent {
  /** Monotonic per-tab sequence (1-based). */
  seq: number
  /** Wire message type, e.g. `output`, `thinking`, `movementComplete`. */
  type: string
  /** Opaque payload for the wire message. */
  data: unknown
  /** `Date.now()` at record time. Used for age-based eviction. */
  timestamp: number
}

/**
 * Bounded replay log for a single tab.
 *
 * Size/age limits are parameterised for testability but defaulted to values
 * that comfortably cover real-world reconnect windows.
 */
export class TabEventBuffer {
  private readonly events: BufferedEvent[] = []
  private nextSeq = 1

  constructor(
    private readonly maxEvents: number = DEFAULT_MAX_EVENTS,
    private readonly maxAgeMs: number = DEFAULT_MAX_AGE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Append an event and return its assigned sequence number.
   *
   * Callers include the returned `seq` on the outgoing wire message so the
   * web can record it and ask for replay starting after that seq on a
   * subsequent reconnect.
   */
  record(type: string, data: unknown): number {
    const seq = this.nextSeq++
    this.events.push({ seq, type, data, timestamp: this.now() })
    this.evict()
    return seq
  }

  /**
   * Return all still-buffered events with `seq > afterSeq`, in original
   * order. Returns an empty array if nothing newer is buffered (either the
   * web is caught up or the window has rolled past).
   */
  getSince(afterSeq: number): BufferedEvent[] {
    this.evict()
    const out: BufferedEvent[] = []
    for (const event of this.events) {
      if (event.seq > afterSeq) out.push(event)
    }
    return out
  }

  /** Current highest assigned seq (monotonic; not reset by eviction). */
  currentSeq(): number {
    return this.nextSeq - 1
  }

  /** Events currently held in memory. For tests. */
  size(): number {
    return this.events.length
  }

  /**
   * Drop events older than `maxAgeMs` from the front, then enforce
   * `maxEvents` by trimming the front further if needed. Eviction keeps the
   * newest events — they're the ones the web is most likely to still need.
   */
  private evict(): void {
    const cutoff = this.now() - this.maxAgeMs
    while (this.events.length > 0 && this.events[0].timestamp < cutoff) {
      this.events.shift()
    }
    while (this.events.length > this.maxEvents) {
      this.events.shift()
    }
  }
}

/**
 * Registry of per-tab buffers. Kept as a thin collection so `HandlerContext`
 * can expose one instance and every broadcast site looks up (or lazily
 * creates) the tab's buffer with a single call.
 */
export class TabEventBufferRegistry {
  private readonly buffers = new Map<string, TabEventBuffer>()

  constructor(
    private readonly bufferFactory: () => TabEventBuffer = () => new TabEventBuffer(),
  ) {}

  /** Get the buffer for `tabId`, creating it on first touch. */
  getOrCreate(tabId: string): TabEventBuffer {
    let buffer = this.buffers.get(tabId)
    if (!buffer) {
      buffer = this.bufferFactory()
      this.buffers.set(tabId, buffer)
    }
    return buffer
  }

  /** Get the buffer for `tabId` without creating it. */
  get(tabId: string): TabEventBuffer | undefined {
    return this.buffers.get(tabId)
  }

  /** Forget `tabId` entirely — called on `tabRemoved`. */
  delete(tabId: string): void {
    this.buffers.delete(tabId)
  }

  /** Drop all bookkeeping. Used for tests; no production caller expected. */
  clear(): void {
    this.buffers.clear()
  }
}

/** 1000 events per tab covers typical reconnect windows comfortably. */
export const DEFAULT_MAX_EVENTS = 1000
/** 15 minutes of history is more than enough for the longest plausible web reconnect. */
export const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000
