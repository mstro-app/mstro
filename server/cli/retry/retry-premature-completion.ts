// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Detects when a claimed-complete run is actually unfinished (hit
 * max_tokens, abandoned mid-task, or Haiku says the end_turn response is
 * a stop short of the goal) and triggers a continuation retry.
 */

import { AnalyticsEvents, trackEvent } from '../../services/analytics.js';
import { hlog } from '../headless/headless-logger.js';
import { extractFinalTextBlock, isResponseAbandoned } from '../headless/retry-strategies.js';
import { assessPrematureCompletion } from '../headless/stall-assessor.js';
import type { HeadlessRunResult, RetryLoopState } from '../improvisation-types.js';
import type { RetryCallbacks, RetrySessionState } from './retry-types.js';

/** Guard checks for premature completion */
function isPrematureCompletionCandidate(
  result: HeadlessRunResult,
  state: RetryLoopState,
  maxRetries: number,
): boolean {
  if (!result.completed || result.signalName || state.retryNumber >= maxRetries) return false;
  if (state.checkpointRef.value || state.contextLost) return false;
  if (!result.claudeSessionId || !result.stopReason) return false;
  return result.stopReason === 'max_tokens' || result.stopReason === 'end_turn';
}

/** Use Haiku to assess whether an end_turn response is genuinely complete */
async function assessEndTurnCompletion(result: HeadlessRunResult, verbose: boolean): Promise<boolean> {
  if (!result.assistantResponse) return false;

  const successfulToolCalls = result.toolUseHistory?.filter(t => t.result !== undefined && !t.isError).length ?? 0;
  const claudeCmd = process.env.CLAUDE_COMMAND || 'claude';
  const verdict = await assessPrematureCompletion({
    responseTail: extractFinalTextBlock(result.assistantResponse, 800),
    successfulToolCalls,
    hasThinking: !!result.thinkingOutput,
    responseLength: result.assistantResponse.length,
  }, claudeCmd, verbose);

  if (verbose) {
    hlog(`[PREMATURE-COMPLETION] Haiku verdict: ${verdict.isIncomplete ? 'INCOMPLETE' : 'COMPLETE'} — ${verdict.reason}`);
  }
  return verdict.isIncomplete;
}

/** Apply premature completion retry */
function applyPrematureCompletionRetry(
  result: HeadlessRunResult,
  state: RetryLoopState,
  session: RetrySessionState,
  maxRetries: number,
  stopReason: string,
  isMaxTokens: boolean,
  callbacks: RetryCallbacks,
): void {
  state.retryNumber++;
  const reason = isMaxTokens ? 'Output limit reached' : 'Task appears unfinished (AI assessment)';

  state.retryLog.push({
    retryNumber: state.retryNumber,
    path: 'PrematureCompletion',
    reason,
    timestamp: Date.now(),
  });

  callbacks.emit('onAutoRetry', {
    retryNumber: state.retryNumber,
    maxRetries,
    toolName: `PrematureCompletion(${stopReason})`,
    completedCount: result.toolUseHistory?.length ?? 0,
  });

  trackEvent(AnalyticsEvents.IMPROVISE_AUTO_RETRY, {
    retry_number: state.retryNumber,
    hung_tool: `premature_completion:${stopReason}`,
    completed_tools: result.toolUseHistory?.length ?? 0,
    resume_attempted: true,
  });

  callbacks.queueOutput(
    `\n\n${reason} — resuming session (retry ${state.retryNumber}/${maxRetries}).\n\n`
  );
  callbacks.flushOutputQueue();

  state.contextRecoverySessionId = result.claudeSessionId;
  session.claudeSessionId = result.claudeSessionId;
  state.currentPrompt = 'continue';
}

/** Detect and retry premature completion. Returns true if loop should continue. */
export async function shouldRetryPrematureCompletion(
  result: HeadlessRunResult,
  state: RetryLoopState,
  session: RetrySessionState,
  maxRetries: number,
  callbacks: RetryCallbacks,
): Promise<boolean> {
  if (!isPrematureCompletionCandidate(result, state, maxRetries)) {
    return false;
  }

  const stopReason = result.stopReason!;
  const isMaxTokens = stopReason === 'max_tokens';
  const abandoned = isResponseAbandoned(result);
  const isIncomplete = isMaxTokens || abandoned || await assessEndTurnCompletion(result, session.options.verbose);

  if (!isIncomplete) return false;

  applyPrematureCompletionRetry(result, state, session, maxRetries, stopReason, isMaxTokens, callbacks);
  return true;
}
