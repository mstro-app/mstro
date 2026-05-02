// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Shared types used across the retry modules. Defined separately so each
 * strategy file can import them without creating circular dependencies.
 */

import type { HeadlessRunner } from '../headless/index.js';
import type { ImprovisationOptions, SessionHistory } from '../improvisation-types.js';

/** Callbacks the retry logic needs from the session manager */
export interface RetryCallbacks {
  isCancelled: () => boolean;
  queueOutput: (text: string) => void;
  flushOutputQueue: () => void;
  emit: (event: string, ...args: unknown[]) => void;
  addEventLog: (entry: { type: string; data: unknown; timestamp: number }) => void;
  setRunner: (runner: HeadlessRunner | null) => void;
}

/** Session state the retry logic reads/writes */
export interface RetrySessionState {
  options: ImprovisationOptions;
  claudeSessionId: string | undefined;
  isFirstPrompt: boolean;
  isResumedSession: boolean;
  history: SessionHistory;
  executionStartTimestamp: number | undefined;
}

export const MAX_RETRIES = 3;
