// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Tests for the tab-event replay path with replay-gap detection.
 *
 * The gap-detection branch is the load-bearing telemetry for the
 * "long-running task output disappears mid-stream" failure mode — it must
 * fire whenever a web's `lastSeenSeq` falls below the buffer's eviction
 * frontier, so production logs and Sentry can quantify the failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandlerContext } from './handler-context.js';
import { TabEventBuffer, TabEventBufferRegistry } from './tab-event-buffer.js';
import { replayTabEventsSince } from './tab-event-replay.js';
import type { WebSocketResponse, WSContext } from './types.js';

interface MockSend {
  send: ReturnType<typeof vi.fn>;
}

function makeWs(): WSContext & MockSend {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  } as unknown as WSContext & MockSend;
}

function makeCtx(buffers: TabEventBufferRegistry): Pick<HandlerContext, 'tabEventBuffers' | 'send'> {
  return {
    tabEventBuffers: buffers,
    send: vi.fn((ws: WSContext, response: WebSocketResponse) => {
      ws.send(JSON.stringify(response));
    }),
  };
}

describe('replayTabEventsSince', () => {
  let buffers: TabEventBufferRegistry;

  beforeEach(() => {
    buffers = new TabEventBufferRegistry();
  });

  it('no-ops when lastSeenSeq is undefined (full init, not a resume)', () => {
    const ws = makeWs();
    const ctx = makeCtx(buffers);
    const result = replayTabEventsSince(ctx as unknown as HandlerContext, ws, 'tab-1', undefined);
    expect(result).toEqual({ sentCount: 0, hadGap: false });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('no-ops when the tab has no buffer (never recorded any events)', () => {
    const ws = makeWs();
    const ctx = makeCtx(buffers);
    const result = replayTabEventsSince(ctx as unknown as HandlerContext, ws, 'tab-unknown', 5);
    expect(result).toEqual({ sentCount: 0, hadGap: false });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('replays only events newer than lastSeenSeq when no eviction has occurred', () => {
    const ws = makeWs();
    const ctx = makeCtx(buffers);
    const buf = buffers.getOrCreate('tab-1');
    buf.record('output', { text: 'a' }); // 1
    buf.record('output', { text: 'b' }); // 2
    buf.record('output', { text: 'c' }); // 3

    const result = replayTabEventsSince(ctx as unknown as HandlerContext, ws, 'tab-1', 1);
    expect(result.sentCount).toBe(2);
    expect(result.hadGap).toBe(false);
    expect(ws.send).toHaveBeenCalledTimes(2);
  });

  it('reports sentCount=0 + hadGap=false when web is already caught up', () => {
    const ws = makeWs();
    const ctx = makeCtx(buffers);
    const buf = buffers.getOrCreate('tab-1');
    buf.record('output', { text: 'a' }); // 1

    const result = replayTabEventsSince(ctx as unknown as HandlerContext, ws, 'tab-1', 1);
    expect(result).toEqual({ sentCount: 0, hadGap: false, evictedThroughSeq: undefined, lastSeenSeq: 1 });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('flags hadGap=true and SKIPS the partial replay on eviction-induced gap', () => {
    const ws = makeWs();
    const ctx = makeCtx(buffers);
    // Custom buffer with maxEvents=2 so we can force eviction in 3 records.
    const buf = new TabEventBuffer(2);
    buffers.getOrCreate('tab-1'); // create the slot
    // Replace with our small buffer.
    (buffers as unknown as { buffers: Map<string, TabEventBuffer> }).buffers.set('tab-1', buf);

    buf.record('output', { text: 'a' }); // 1
    buf.record('output', { text: 'b' }); // 2
    buf.record('output', { text: 'c' }); // 3 — evicts 1
    buf.record('output', { text: 'd' }); // 4 — evicts 2

    // Web's lastSeen = 1. Next event it expects is seq 2, but 2 has been
    // evicted. The replay must NOT deliver 3 and 4 — that would advance the
    // web's tabSeqs past the gap and the snapshot fallback would land in a
    // tab that thinks it's caught up. Instead we report `hadGap` so the
    // caller (`session-initialization.ts`) sends a full snapshot.
    const result = replayTabEventsSince(ctx as unknown as HandlerContext, ws, 'tab-1', 1);
    expect(result.hadGap).toBe(true);
    expect(result.evictedThroughSeq).toBe(2);
    expect(result.lastSeenSeq).toBe(1);
    expect(result.sentCount).toBe(0);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('does NOT flag a gap when lastSeenSeq is exactly on the eviction frontier', () => {
    const ws = makeWs();
    const ctx = makeCtx(buffers);
    const buf = new TabEventBuffer(2);
    (buffers as unknown as { buffers: Map<string, TabEventBuffer> }).buffers.set('tab-1', buf);

    buf.record('output', { text: 'a' }); // 1
    buf.record('output', { text: 'b' }); // 2
    buf.record('output', { text: 'c' }); // 3 — evicts 1

    // Web's lastSeen = 1. evictedThroughSeq = 1. Next event the web expects
    // (seq 2) is still in the buffer → no gap.
    const result = replayTabEventsSince(ctx as unknown as HandlerContext, ws, 'tab-1', 1);
    expect(result.hadGap).toBe(false);
    expect(result.sentCount).toBe(2); // 2 and 3
  });

  it('reports the gap with the correct evictedThroughSeq across multiple evictions', () => {
    const ws = makeWs();
    const ctx = makeCtx(buffers);
    const buf = new TabEventBuffer(3);
    (buffers as unknown as { buffers: Map<string, TabEventBuffer> }).buffers.set('tab-1', buf);

    buf.record('output', { text: 'a' });
    buf.record('output', { text: 'b' });
    buf.record('output', { text: 'c' });
    buf.record('output', { text: 'd' }); // evicts 1
    buf.record('output', { text: 'e' }); // evicts 2

    // Web saw nothing (lastSeen = 0). evictedThroughSeq = 2. The post-gap
    // events (3, 4, 5) are NOT emitted — the caller routes to the snapshot
    // path so the web replaces tab state instead of merging onto stale state.
    const result = replayTabEventsSince(ctx as unknown as HandlerContext, ws, 'tab-1', 0);
    expect(result.hadGap).toBe(true);
    expect(result.evictedThroughSeq).toBe(2);
    expect(result.sentCount).toBe(0);
    expect(ctx.send).not.toHaveBeenCalled();
  });
});
