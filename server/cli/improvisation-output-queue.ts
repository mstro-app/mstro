// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Small FIFO output buffer with a fixed-interval flush timer, used by the
 * improvisation session manager to coalesce rapid stdout writes into
 * steady `onOutput` emissions.
 *
 * ## Why coalesce inside `flush()`
 *
 * Claude's stdout arrives as many small chunks during streaming. Each chunk
 * lands here via `queue_`. When `flush()` ran one `onEmit` per queued chunk,
 * a streaming-heavy run produced thousands of `onOutput` events per minute,
 * each becoming a tab-scoped broadcast that consumes a slot in the per-tab
 * replay buffer (`tab-event-buffer.ts`). For 14-min runs with ~120 tool
 * calls, that easily exceeded the buffer's 1000-event cap and triggered
 * silent replay gaps on web reconnect.
 *
 * The flush window (50ms) is below the human-perceptible paint threshold and
 * below WebSocket roundtrip latency, so concatenating all queued text into a
 * single `onEmit` per tick is invisible to the user but cuts buffer pressure
 * by 3-10× during streaming. No call site downstream depends on chunk
 * boundaries — `onOutput` consumers (terminal renderer, history persistence)
 * already treat the text as an opaque append.
 */

const FLUSH_INTERVAL_MS = 50;

export class OutputQueue {
  private queue: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly onEmit: (text: string) => void) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.flush(); }, FLUSH_INTERVAL_MS);
  }

  queue_(text: string): void {
    if (text.length === 0) return;
    this.queue.push(text);
  }

  /**
   * Drain all buffered entries, emitting them as a single concatenated
   * string via `onEmit`. Order is preserved (FIFO). No-op when the queue is
   * empty so the periodic timer doesn't fire spurious empty-string emits.
   */
  flush(): void {
    if (this.queue.length === 0) return;
    const merged = this.queue.join('');
    this.queue.length = 0;
    this.onEmit(merged);
  }

  /** Stop the flush timer. Does NOT drain; call `flush()` first if needed. */
  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
