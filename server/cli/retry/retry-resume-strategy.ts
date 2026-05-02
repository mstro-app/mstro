// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Picks how the next retry iteration should resume execution:
 * whether to pass `--resume`, and which Claude session ID (if any) to use.
 */

import type { RetryLoopState } from '../improvisation-types.js';
import type { RetrySessionState } from './retry-types.js';

/** Determine whether to use --resume and which session ID */
export function determineResumeStrategy(
  state: RetryLoopState,
  session: RetrySessionState,
): { useResume: boolean; resumeSessionId: string | undefined } {
  if (state.freshRecoveryMode) {
    state.freshRecoveryMode = false;
    return { useResume: false, resumeSessionId: undefined };
  }
  if (state.contextRecoverySessionId) {
    const id = state.contextRecoverySessionId;
    state.contextRecoverySessionId = undefined;
    return { useResume: true, resumeSessionId: id };
  }
  if (state.retryNumber === 0) {
    return { useResume: !session.isFirstPrompt, resumeSessionId: session.claudeSessionId };
  }
  if (state.lastWatchdogCheckpoint?.inProgressTools.length === 0 && state.lastWatchdogCheckpoint.claudeSessionId) {
    return { useResume: true, resumeSessionId: state.lastWatchdogCheckpoint.claudeSessionId };
  }
  return { useResume: false, resumeSessionId: undefined };
}
