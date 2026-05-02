// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { describe, expect, it } from 'vitest';
import { MsgIdTracker } from './msg-id-tracker.js';

describe('MsgIdTracker', () => {
  it('records each msgId as first-time on initial send', () => {
    const tracker = new MsgIdTracker();
    expect(tracker.recordIfFirst('tab-a', 'm1')).toBe(true);
    expect(tracker.recordIfFirst('tab-a', 'm2')).toBe(true);
  });

  it('returns false on replay of the same msgId within the TTL window', () => {
    const tracker = new MsgIdTracker();
    tracker.recordIfFirst('tab-a', 'm1');
    expect(tracker.recordIfFirst('tab-a', 'm1')).toBe(false);
  });

  it('partitions by tabId — same msgId on different tabs both count as new', () => {
    const tracker = new MsgIdTracker();
    expect(tracker.recordIfFirst('tab-a', 'm1')).toBe(true);
    expect(tracker.recordIfFirst('tab-b', 'm1')).toBe(true);
  });

  it('forgets all msgIds for a tab on forget()', () => {
    const tracker = new MsgIdTracker();
    tracker.recordIfFirst('tab-a', 'm1');
    tracker.forget('tab-a');
    // Counts as first-time again after forget — this is correct because a
    // removed tab can't legitimately have in-flight msgIds to dedupe.
    expect(tracker.recordIfFirst('tab-a', 'm1')).toBe(true);
  });

  it('expires entries past the TTL', () => {
    let now = 1_000_000;
    const tracker = new MsgIdTracker(1000, 100, () => now);
    tracker.recordIfFirst('tab-a', 'm1');
    expect(tracker.recordIfFirst('tab-a', 'm1')).toBe(false);

    now += 2000; // past TTL
    expect(tracker.recordIfFirst('tab-a', 'm1')).toBe(true);
  });

  it('enforces the per-tab size cap by evicting oldest', () => {
    const tracker = new MsgIdTracker(60_000, /* maxPerTab */ 2);
    tracker.recordIfFirst('tab-a', 'm1');
    tracker.recordIfFirst('tab-a', 'm2');
    tracker.recordIfFirst('tab-a', 'm3'); // evicts m1
    expect(tracker.size('tab-a')).toBe(2);
    expect(tracker.recordIfFirst('tab-a', 'm1')).toBe(true); // m1 was evicted, seen as new
    expect(tracker.recordIfFirst('tab-a', 'm3')).toBe(false); // m3 still in window
  });
});
