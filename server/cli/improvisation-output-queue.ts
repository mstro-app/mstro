// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Small FIFO output buffer with a fixed-interval flush timer, used by the
 * improvisation session manager to coalesce rapid stdout writes into
 * steady `onOutput` emissions.
 */

const FLUSH_INTERVAL_MS = 50;

export class OutputQueue {
  private queue: Array<{ text: string; timestamp: number }> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly onEmit: (text: string) => void) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.flush(); }, FLUSH_INTERVAL_MS);
  }

  queue_(text: string): void {
    this.queue.push({ text, timestamp: Date.now() });
  }

  /** Drain all buffered entries, emitting each via `onEmit` in order. */
  flush(): void {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) this.onEmit(item.text);
    }
  }

  /** Stop the flush timer. Does NOT drain; call `flush()` first if needed. */
  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
