// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { beforeEach, describe, expect, it } from 'vitest';
import { TabEventBuffer, TabEventBufferRegistry } from './tab-event-buffer.js';

describe('TabEventBuffer', () => {
  it('assigns strictly monotonic sequence numbers starting at 1', () => {
    const buf = new TabEventBuffer();
    expect(buf.record('output', { text: 'a' })).toBe(1);
    expect(buf.record('output', { text: 'b' })).toBe(2);
    expect(buf.record('thinking', { text: 'c' })).toBe(3);
    expect(buf.currentSeq()).toBe(3);
  });

  it('returns only events newer than `afterSeq`, in order', () => {
    const buf = new TabEventBuffer();
    buf.record('output', { text: 'a' }); // seq 1
    buf.record('output', { text: 'b' }); // seq 2
    buf.record('output', { text: 'c' }); // seq 3

    const since1 = buf.getSince(1);
    expect(since1).toHaveLength(2);
    expect(since1[0].seq).toBe(2);
    expect(since1[1].seq).toBe(3);

    expect(buf.getSince(3)).toEqual([]);
    expect(buf.getSince(99)).toEqual([]);
  });

  it('replays all events when `afterSeq` is 0', () => {
    const buf = new TabEventBuffer();
    buf.record('output', { text: 'a' });
    buf.record('output', { text: 'b' });
    expect(buf.getSince(0)).toHaveLength(2);
  });

  it('evicts the oldest events when size limit is exceeded but keeps seq monotonic', () => {
    const buf = new TabEventBuffer(/* maxEvents */ 3);
    buf.record('output', { text: 'a' }); // 1
    buf.record('output', { text: 'b' }); // 2
    buf.record('output', { text: 'c' }); // 3
    buf.record('output', { text: 'd' }); // 4 — evicts seq 1
    buf.record('output', { text: 'e' }); // 5 — evicts seq 2

    expect(buf.size()).toBe(3);
    expect(buf.currentSeq()).toBe(5);

    const since0 = buf.getSince(0);
    expect(since0.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('evicts events older than the max age window', () => {
    let now = 1_000_000;
    const buf = new TabEventBuffer(100, /* maxAgeMs */ 1000, () => now);

    buf.record('output', { text: 'stale' }); // seq 1 at t=1_000_000
    now += 500;
    buf.record('output', { text: 'recent' }); // seq 2 at t=1_000_500

    now += 600; // push past the 1s window for seq 1 only
    const events = buf.getSince(0);
    expect(events.map((e) => e.seq)).toEqual([2]);
  });

  it('never returns events that were evicted, even when lastSeenSeq < oldest surviving seq', () => {
    // Exercises the "web asks for replay of an event that's been evicted" case:
    // the client is told "nothing newer for you" and falls back to full snapshot.
    const buf = new TabEventBuffer(2);
    buf.record('output', { text: 'a' });
    buf.record('output', { text: 'b' });
    buf.record('output', { text: 'c' }); // evicts seq 1

    const since0 = buf.getSince(0);
    expect(since0.map((e) => e.seq)).toEqual([2, 3]);
    // Asking for "newer than 1" still only returns 2 and 3, which is correct —
    // the caller treats any seq <= minSurviving as "nothing to replay here".
    expect(buf.getSince(1).map((e) => e.seq)).toEqual([2, 3]);
  });
});

describe('TabEventBufferRegistry', () => {
  let registry: TabEventBufferRegistry;

  beforeEach(() => {
    registry = new TabEventBufferRegistry();
  });

  it('creates one buffer per tab on first touch and reuses it thereafter', () => {
    const a1 = registry.getOrCreate('tab-a');
    const a2 = registry.getOrCreate('tab-a');
    const b = registry.getOrCreate('tab-b');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it('returns undefined for unknown tabs via `get`', () => {
    expect(registry.get('nope')).toBeUndefined();
    registry.getOrCreate('tab-a');
    expect(registry.get('tab-a')).toBeDefined();
  });

  it('delete removes the per-tab buffer', () => {
    registry.getOrCreate('tab-a');
    registry.delete('tab-a');
    expect(registry.get('tab-a')).toBeUndefined();
  });
});
