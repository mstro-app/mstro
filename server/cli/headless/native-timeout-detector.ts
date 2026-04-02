// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/** Regex matching Claude Code's internal tool timeout messages */
export const NATIVE_TIMEOUT_PATTERN = /^(\w+) timed out — (continuing|retrying) with (\d+) results? preserved$/;

/** Quick prefix check: does incomplete text look like it might be a timeout?
 *  Matches any capitalized tool name followed by " timed" — no hardcoded set
 *  needed because the full NATIVE_TIMEOUT_PATTERN validates on the next chunk. */
export const TIMEOUT_PREFIX_PATTERN = /^[A-Z]\w* timed/;

export interface NativeTimeoutEvent {
  toolName: string;
  action: 'continuing' | 'retrying';
  preservedCount: number;
}

/**
 * Detects Claude Code's internal tool timeout messages in the text stream.
 *
 * Buffers text at newline boundaries to detect complete timeout lines.
 * Non-matching text is forwarded immediately to minimize streaming latency.
 */
export class NativeTimeoutDetector {
  private lineBuffer = '';
  private detectedTimeouts: NativeTimeoutEvent[] = [];
  /** Text buffered after native timeouts — held back from streaming until context is assessed */
  private postTimeoutBuffer = '';

  /**
   * Process a text_delta chunk.
   * Returns passthrough text (for outputCallback) and any detected timeouts.
   *
   * After the first native timeout is detected, subsequent passthrough text
   * is held in postTimeoutBuffer instead of returned as passthrough. This
   * prevents confused "What were you working on?" responses from streaming
   * to the user before context loss can be assessed.
   */
  processChunk(text: string): { passthrough: string; timeouts: NativeTimeoutEvent[] } {
    const timeouts: NativeTimeoutEvent[] = [];
    let passthrough = '';

    this.lineBuffer += text;

    const lines = this.lineBuffer.split('\n');
    const incomplete = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(NATIVE_TIMEOUT_PATTERN);

      if (match) {
        const event: NativeTimeoutEvent = {
          toolName: match[1],
          action: match[2] as 'continuing' | 'retrying',
          preservedCount: parseInt(match[3], 10),
        };
        timeouts.push(event);
        this.detectedTimeouts.push(event);
      } else {
        passthrough += `${line}\n`;
      }
    }

    // Handle incomplete trailing text
    if (incomplete) {
      if (TIMEOUT_PREFIX_PATTERN.test(incomplete)) {
        this.lineBuffer = incomplete;
      } else {
        passthrough += incomplete;
        this.lineBuffer = '';
      }
    } else {
      this.lineBuffer = '';
    }

    // After native timeouts, buffer passthrough text instead of returning it.
    if (this.detectedTimeouts.length > 0 && passthrough) {
      this.postTimeoutBuffer += passthrough;
      passthrough = '';
    }

    return { passthrough, timeouts };
  }

  /** Flush any held buffer (call on stream end).
   *  Also checks remaining buffer for timeout patterns so the last
   *  timeout message (without trailing newline) is always counted.
   */
  flush(): string {
    const remaining = this.lineBuffer;
    this.lineBuffer = '';

    if (remaining) {
      const trimmed = remaining.trim();
      const match = trimmed.match(NATIVE_TIMEOUT_PATTERN);
      if (match) {
        this.detectedTimeouts.push({
          toolName: match[1],
          action: match[2] as 'continuing' | 'retrying',
          preservedCount: parseInt(match[3], 10),
        });
        return '';
      }
    }

    return remaining;
  }

  get timeoutCount(): number {
    return this.detectedTimeouts.length;
  }

  get bufferedPostTimeoutOutput(): string {
    return this.postTimeoutBuffer;
  }
}
