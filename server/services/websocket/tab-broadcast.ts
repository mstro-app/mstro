// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Tab-scoped broadcast helper.
 *
 * Session and plan handlers emit streaming events that (a) fan out to all
 * paired web clients and (b) need to survive transport reconnects. Instead of
 * every call site knowing about both concerns, route through
 * `broadcastTabEvent`: it assigns the next monotonic `seq` via the tab's
 * event buffer and broadcasts the wire message with that seq attached.
 *
 * Receiving webs record the seq and ask for replay starting from their
 * highest-seen seq the next time they `initTab` / `resumeSession`. See
 * `tab-event-buffer.ts` for the buffer itself and
 * `session-initialization.ts` for the replay path.
 */

import type { HandlerContext } from './handler-context.js'
import type { WebSocketResponse } from './types.js'

type TabScopedEventType = WebSocketResponse['type']

/**
 * Record + broadcast a tab-scoped event in one call. Returns the assigned
 * sequence number purely for logging/tests — callers rarely need it.
 */
export function broadcastTabEvent(
  ctx: HandlerContext,
  tabId: string,
  type: TabScopedEventType,
  data: unknown,
): number {
  const buffer = ctx.tabEventBuffers.getOrCreate(tabId)
  const seq = buffer.record(type, data)
  ctx.broadcastToAll({ type, tabId, data, seq })
  return seq
}
