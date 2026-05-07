// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Replay tab-scoped events missed during a transport gap.
 *
 * `session-initialization.ts` calls this right before sending `tabInitialized`
 * so the web sees any events with `seq > lastSeenSeq` in-order before the
 * usual initialization payload. Ordering matters: e.g. a `movementComplete`
 * before `outputHistory` would render duplicate content.
 *
 * Delivery is targeted (`ctx.send`) rather than broadcast because only the
 * rejoining web needs the replay; other connected webs already saw these
 * events live.
 */

import { captureException } from '../sentry.js'
import type { HandlerContext } from './handler-context.js'
import type { WebSocketResponse, WSContext } from './types.js'

/** Result of a replay attempt — used by callers (and tests) for telemetry. */
export interface ReplayResult {
  /** Number of events sent to the web during this replay. */
  sentCount: number
  /**
   * True when the buffer had already evicted events that fell between the
   * web's `lastSeenSeq` and the oldest surviving seq. The replay is partial;
   * the web's incremental state is now provably stale and the caller should
   * fall back to a full snapshot path (e.g. `outputHistory`).
   */
  hadGap: boolean
  /**
   * If `hadGap`, the highest seq that was evicted (so the gap range is
   * `(lastSeenSeq + 1) .. evictedThroughSeq`). Undefined when no gap.
   */
  evictedThroughSeq?: number
  /**
   * If `hadGap`, the seq the web requested replay from. Echoed into
   * telemetry so log entries are self-contained.
   */
  lastSeenSeq?: number
}

/**
 * Replay tab events with `seq > lastSeenSeq` to `ws`. Silently no-ops when
 * the buffer is empty or `lastSeenSeq` is unset (full init, not a resume).
 *
 * Returns a `ReplayResult` so the caller can detect a partial replay (the
 * buffer evicted events the web is asking about) and decide whether to send
 * a recovery snapshot. This is the load-bearing telemetry surface for the
 * "long-running task output disappears mid-stream" failure mode — a `hadGap`
 * here is the smoking gun.
 */
export function replayTabEventsSince(
  ctx: HandlerContext,
  ws: WSContext,
  tabId: string,
  lastSeenSeq: number | undefined,
): ReplayResult {
  if (lastSeenSeq === undefined) return { sentCount: 0, hadGap: false }

  const buffer = ctx.tabEventBuffers.get(tabId)
  if (!buffer) return { sentCount: 0, hadGap: false }

  const hadGap = buffer.hasGapSince(lastSeenSeq)
  const evictedThroughSeq = hadGap ? buffer.getEvictedThroughSeq() : undefined

  if (hadGap) {
    // Replay is structurally incomplete. Surface a single, structured warning
    // so we can grep/Sentry-search for the failure mode without spamming logs
    // on every event.
    const message =
      `[tab-replay] gap detected for tab=${tabId}: web requested replay from seq=${lastSeenSeq}, ` +
      `but buffer has evicted through seq=${evictedThroughSeq}. ` +
      `Events (${lastSeenSeq + 1}..${evictedThroughSeq}) are unavailable; the web's ` +
      `incremental state is stale and a full snapshot will be sent instead.`
    console.warn(message)
    try {
      captureException(new Error('TabEventBuffer replay gap'), {
        context: 'tab-event-replay',
        tabId,
        lastSeenSeq,
        evictedThroughSeq,
        bufferCurrentSeq: buffer.currentSeq(),
        gapSize: (evictedThroughSeq ?? 0) - lastSeenSeq,
      })
    } catch {
      // Sentry transport errors must not break the replay path.
    }
    // CRITICAL: do NOT emit partial events. If we did, the web would advance
    // its `tabSeqs` past the (lastSeenSeq+1 .. evictedThroughSeq) range and
    // the subsequent snapshot would land in a tab that thinks it's caught up
    // — silently rendering only the post-gap tail. Returning early without
    // events forces the caller (`session-initialization.ts`) into the
    // snapshot-fallback branch, which sends a fresh `outputHistory` payload
    // with `replayGap: true` so the web can replace its tab state cleanly.
    return { sentCount: 0, hadGap: true, evictedThroughSeq, lastSeenSeq }
  }

  const events = buffer.getSince(lastSeenSeq)
  for (const event of events) {
    // Types are checked at record time via `broadcastTabEvent`; the buffer
    // stores them as strings but by construction they're always
    // `WebSocketResponse['type']`. Narrow here without an extra runtime check.
    ctx.send(ws, { type: event.type as WebSocketResponse['type'], tabId, data: event.data, seq: event.seq })
  }

  return { sentCount: events.length, hadGap: false, lastSeenSeq }
}
