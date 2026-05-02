// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Retry and recovery logic for improvisation sessions — barrel re-export.
 *
 * Implementation lives in focused modules under ./retry/:
 * - retry-types.ts                — RetryCallbacks, RetrySessionState
 * - retry-resume-strategy.ts      — whether/how to --resume
 * - retry-runner-factory.ts       — HeadlessRunner factory for a single iteration
 * - retry-context-loss.ts         — Path 1 + Path 2 context loss detection
 * - retry-tool-results.ts         — accumulate tool results across retries
 * - retry-recovery-strategies.ts  — context-loss, tool-timeout, signal-crash retries
 * - retry-premature-completion.ts — detect + recover from unfinished end_turn
 * - retry-best-result.ts          — pick the best result across retries
 */

export { selectBestResult } from './retry/retry-best-result.js';
export { detectNativeTimeoutContextLoss, detectResumeContextLoss } from './retry/retry-context-loss.js';
export { shouldRetryPrematureCompletion } from './retry/retry-premature-completion.js';
export {
  applyInterMovementRecovery,
  applyNativeTimeoutRecovery,
  applyToolTimeoutRetry,
  shouldRetryContextLoss,
  shouldRetrySignalCrash,
} from './retry/retry-recovery-strategies.js';
export { determineResumeStrategy } from './retry/retry-resume-strategy.js';
export { createExecutionRunner } from './retry/retry-runner-factory.js';
export { accumulateToolResults } from './retry/retry-tool-results.js';
export type { RetryCallbacks, RetrySessionState } from './retry/retry-types.js';
