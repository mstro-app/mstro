// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Tests for the OutputQueue's flush behavior, especially the coalescing pass
 * that turns N queued chunks into one onEmit. The coalescing is the
 * load-bearing optimization that keeps long-running tasks under the per-tab
 * replay buffer cap (`tab-event-buffer.ts`).
 */

import { describe, expect, it, vi } from 'vitest';
import { OutputQueue } from './improvisation-output-queue.js';

describe('OutputQueue', () => {
  it('flush() emits a single concatenated string for all queued chunks', () => {
    const onEmit = vi.fn();
    const queue = new OutputQueue(onEmit);
    queue.queue_('hello ');
    queue.queue_('world');
    queue.queue_('!');

    queue.flush();

    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit).toHaveBeenCalledWith('hello world!');
  });

  it('flush() preserves FIFO order in the concatenated output', () => {
    const onEmit = vi.fn();
    const queue = new OutputQueue(onEmit);
    queue.queue_('1');
    queue.queue_('2');
    queue.queue_('3');
    queue.queue_('4');
    queue.queue_('5');

    queue.flush();

    expect(onEmit).toHaveBeenCalledWith('12345');
  });

  it('flush() does NOT emit when the queue is empty', () => {
    const onEmit = vi.fn();
    const queue = new OutputQueue(onEmit);

    queue.flush();
    queue.flush();
    queue.flush();

    expect(onEmit).not.toHaveBeenCalled();
  });

  it('queue_() ignores empty strings (avoids spurious empty-string emits)', () => {
    const onEmit = vi.fn();
    const queue = new OutputQueue(onEmit);
    queue.queue_('');
    queue.queue_('a');
    queue.queue_('');
    queue.queue_('b');

    queue.flush();

    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit).toHaveBeenCalledWith('ab');
  });

  it('flush() empties the queue so the next flush is a no-op', () => {
    const onEmit = vi.fn();
    const queue = new OutputQueue(onEmit);
    queue.queue_('first');
    queue.flush();

    queue.flush(); // queue is now empty

    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit).toHaveBeenCalledWith('first');
  });

  it('many small chunks coalesce into one emit (the load-bearing optimization)', () => {
    const onEmit = vi.fn();
    const queue = new OutputQueue(onEmit);
    // Simulate 100 small chunks arriving within one flush window — each one
    // would have been a separate broadcast/buffer entry in the old behavior.
    for (let i = 0; i < 100; i++) queue.queue_(`chunk-${i};`);
    queue.flush();

    expect(onEmit).toHaveBeenCalledTimes(1);
    const merged = onEmit.mock.calls[0][0] as string;
    expect(merged.startsWith('chunk-0;')).toBe(true);
    expect(merged.endsWith('chunk-99;')).toBe(true);
    expect(merged.split(';').filter(Boolean).length).toBe(100);
  });

  it('start() then queue_() then time advances → flushes via timer', () => {
    vi.useFakeTimers();
    try {
      const onEmit = vi.fn();
      const queue = new OutputQueue(onEmit);
      queue.start();
      queue.queue_('hello');
      // 50ms flush interval — advance just past it.
      vi.advanceTimersByTime(60);
      expect(onEmit).toHaveBeenCalledTimes(1);
      expect(onEmit).toHaveBeenCalledWith('hello');

      // Subsequent ticks with no queued data should NOT fire onEmit.
      vi.advanceTimersByTime(200);
      expect(onEmit).toHaveBeenCalledTimes(1);

      queue.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
