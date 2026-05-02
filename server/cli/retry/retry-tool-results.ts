// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Running buffer of tool results preserved across retries so recovery
 * prompts can re-inject completed work instead of redoing it.
 */

import type { HeadlessRunResult, RetryLoopState } from '../improvisation-types.js';

export const MAX_ACCUMULATED_RESULTS = 50;

/** Accumulate completed tool results from a run into the retry state */
export function accumulateToolResults(result: HeadlessRunResult, state: RetryLoopState): void {
  if (!result.toolUseHistory) return;
  for (const t of result.toolUseHistory) {
    if (t.result !== undefined) {
      state.accumulatedToolResults.push({
        toolName: t.toolName,
        toolId: t.toolId,
        toolInput: t.toolInput,
        result: t.result,
        isError: t.isError,
        duration: t.duration,
      });
    }
  }
  if (state.accumulatedToolResults.length > MAX_ACCUMULATED_RESULTS) {
    state.accumulatedToolResults = state.accumulatedToolResults.slice(-MAX_ACCUMULATED_RESULTS);
  }
}
