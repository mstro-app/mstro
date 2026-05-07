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
  /**
   * Approximate serialized byte size of `data`. Computed once at record
   * time so eviction can enforce a memory cap without re-stringifying on
   * every check. Type and seq overhead is small; we only bill `data` here.
   */
  byteSize: number
}

/**
 * Bounded replay log for a single tab.
 *
 * Size/age/byte limits are parameterised for testability but defaulted to
 * values that comfortably cover real-world reconnect windows for long-running
 * coding-agent tasks (multi-tool, multi-minute).
 *
 * ## Replay-gap detection
 *
 * The buffer tracks `evictedThroughSeq` — the highest seq that has ever been
 * evicted (0 if nothing has been evicted). A web client whose `lastSeenSeq`
 * is below this value has missed events the buffer can no longer supply, and
 * an incremental replay would produce a silent gap. Callers should consult
 * `hasGapSince` before relying on `getSince` for incremental replay; on a
 * gap they should fall back to a full snapshot path (e.g. `outputHistory`).
 *
 * ## Eviction is FIFO with three caps
 *
 * Events are evicted from the front when ANY of these limits is exceeded:
 *  - count: `maxEvents` (default 10k)
 *  - age:   `maxAgeMs` (default 60 min)
 *  - bytes: `maxTotalBytes` (default 32 MB)
 *
 * The byte cap is the safety belt against pathological events (e.g. a 50 MB
 * grep result streamed as one event). Without it, count- and age-based caps
 * still allow a single tab to hoard arbitrary memory.
 */
export class TabEventBuffer {
  private readonly events: BufferedEvent[] = []
  private nextSeq = 1
  /**
   * Highest seq that has been evicted from the buffer. 0 means nothing has
   * been evicted yet (buffer is operating within its window). Monotonically
   * non-decreasing — eviction always happens from the front of the FIFO, in
   * seq order, so the most recently evicted seq is always the highest.
   */
  private evictedThroughSeq = 0
  /** Approximate sum of `byteSize` over still-resident events. */
  private totalBytes = 0

  constructor(
    private readonly maxEvents: number = DEFAULT_MAX_EVENTS,
    private readonly maxAgeMs: number = DEFAULT_MAX_AGE_MS,
    private readonly now: () => number = Date.now,
    private readonly maxTotalBytes: number = DEFAULT_MAX_TOTAL_BYTES,
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
    const byteSize = estimateByteSize(data)
    this.events.push({ seq, type, data, timestamp: this.now(), byteSize })
    this.totalBytes += byteSize
    this.evict()
    return seq
  }

  /**
   * Return all still-buffered events with `seq > afterSeq`, in original
   * order. Returns an empty array if nothing newer is buffered (either the
   * web is caught up or the window has rolled past).
   *
   * NOTE: This does not detect or signal replay gaps. Pair with
   * `hasGapSince(afterSeq)` to know whether a returned array is a complete
   * incremental replay or a partial one (events between `afterSeq` and the
   * oldest surviving seq have been evicted and are no longer available).
   */
  getSince(afterSeq: number): BufferedEvent[] {
    this.evict()
    const out: BufferedEvent[] = []
    for (const event of this.events) {
      if (event.seq > afterSeq) out.push(event)
    }
    return out
  }

  /**
   * True when an incremental replay starting from `afterSeq` would silently
   * skip events that the buffer has already evicted. Used by the replay
   * orchestrator to decide whether to fall back to a full snapshot rather
   * than emit a partial event stream the web can't reconstruct.
   *
   * `afterSeq < evictedThroughSeq` means the next event the caller expects
   * (`afterSeq + 1`) is at or below the eviction frontier — that event has
   * already been dropped from memory.
   */
  hasGapSince(afterSeq: number): boolean {
    this.evict()
    return afterSeq < this.evictedThroughSeq
  }

  /**
   * Highest seq that has been evicted from this buffer; 0 if nothing has been
   * evicted yet. Exposed for telemetry and gap-recovery decisions.
   */
  getEvictedThroughSeq(): number {
    return this.evictedThroughSeq
  }

  /** Current highest assigned seq (monotonic; not reset by eviction). */
  currentSeq(): number {
    return this.nextSeq - 1
  }

  /** Events currently held in memory. For tests. */
  size(): number {
    return this.events.length
  }

  /** Approximate bytes held by `data` payloads currently in memory. For tests/telemetry. */
  byteSize(): number {
    return this.totalBytes
  }

  /**
   * Drop events older than `maxAgeMs` from the front, then enforce
   * `maxEvents` and `maxTotalBytes` by trimming the front further if needed.
   * Eviction keeps the newest events — they're the ones the web is most
   * likely to still need.
   *
   * Each evicted seq advances `evictedThroughSeq` so callers can detect
   * replay gaps. The FIFO ensures we always evict in seq order, so the last
   * evicted seq is always the highest seen so far.
   *
   * The byte cap is enforced LAST so that count- and age-based eviction get
   * a chance first; a chatty-but-small session evicts on age before it ever
   * touches the byte cap, which keeps the usual case predictable.
   */
  private evict(): void {
    const cutoff = this.now() - this.maxAgeMs
    while (this.events.length > 0 && this.events[0].timestamp < cutoff) {
      this.popOldest()
    }
    while (this.events.length > this.maxEvents) {
      this.popOldest()
    }
    while (this.events.length > 0 && this.totalBytes > this.maxTotalBytes) {
      this.popOldest()
    }
  }

  private popOldest(): void {
    const evicted = this.events.shift()
    if (!evicted) return
    this.evictedThroughSeq = evicted.seq
    this.totalBytes -= evicted.byteSize
    if (this.totalBytes < 0) this.totalBytes = 0
  }
}

/**
 * Estimate `data`'s serialized byte size for the eviction byte cap. Uses
 * `JSON.stringify` because that's what hits the wire; falls back to a small
 * default on circular structures so we don't crash the broadcast path.
 *
 * `Buffer.byteLength` would give us UTF-8 bytes vs UTF-16 code units, but on
 * Node `JSON.stringify(...).length` is close enough (within a small constant
 * factor for ASCII-heavy payloads) and avoids an extra allocation.
 */
function estimateByteSize(data: unknown): number {
  if (data === undefined || data === null) return 0
  try {
    return JSON.stringify(data).length
  } catch {
    // Circular reference, BigInt, etc. — bill a small fixed cost so the
    // byte cap still has SOME signal. We won't be able to wire-serialize
    // this either, but that's a separate problem.
    return 256
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

/**
 * 10,000 events per tab.
 *
 * Sized for long-running coding-agent tasks (multi-tool, multi-minute) plus
 * laptop sleep/wake reconnect windows. Worst-case observed: a 14-minute
 * session with ~120 tool calls produces ~1.5–3k tab-scoped events; 10× that
 * gives headroom for parallel agents and chatty improvisation. Memory
 * footprint at ~500B/event = ~5MB per tab; the local-only single-tenant
 * deployment makes this a non-issue.
 */
export const DEFAULT_MAX_EVENTS = 10_000
/**
 * 60 minutes of history. Covers laptop sleep/wake, long meetings between
 * sessions, and the largest plausible reconnect window that a tab might
 * legitimately want to recover incrementally instead of starting fresh.
 */
export const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000
/**
 * 32 MB safety belt against pathological events (large grep results, full
 * file reads streamed inline). Eviction by bytes guarantees a single tab
 * can't hoard arbitrary memory regardless of count/age limits.
 */
export const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024
