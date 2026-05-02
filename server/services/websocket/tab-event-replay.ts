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

import type { HandlerContext } from './handler-context.js'
import type { WebSocketResponse, WSContext } from './types.js'

/**
 * Replay tab events with `seq > lastSeenSeq` to `ws`. Silently no-ops when
 * the buffer is empty or `lastSeenSeq` is unset (full init, not a resume).
 */
export function replayTabEventsSince(
  ctx: HandlerContext,
  ws: WSContext,
  tabId: string,
  lastSeenSeq: number | undefined,
): void {
  if (lastSeenSeq === undefined) return

  const buffer = ctx.tabEventBuffers.get(tabId)
  if (!buffer) return

  const events = buffer.getSince(lastSeenSeq)
  for (const event of events) {
    // Types are checked at record time via `broadcastTabEvent`; the buffer
    // stores them as strings but by construction they're always
    // `WebSocketResponse['type']`. Narrow here without an extra runtime check.
    ctx.send(ws, { type: event.type as WebSocketResponse['type'], tabId, data: event.data, seq: event.seq })
  }
}
