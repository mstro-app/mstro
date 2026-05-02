// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Recovery strategies: context-loss (inter-movement / native-timeout),
 * tool-timeout checkpoint retry, and signal-crash retry. Each `shouldRetry*`
 * or `apply*Retry` function returns true when the retry loop should loop.
 */

import { AnalyticsEvents, trackEvent } from '../../services/analytics.js';
import type { ExecutionCheckpoint } from '../headless/types.js';
import type { HeadlessRunResult, MovementRecord, RetryLoopState } from '../improvisation-types.js';
import {
  buildContextRecoveryPrompt,
  buildFreshRecoveryPrompt,
  buildInterMovementRecoveryPrompt,
  buildResumeRetryPrompt,
  buildRetryPrompt,
  buildSignalCrashRecoveryPrompt,
  extractHistoricalToolResults,
} from '../prompt-builders.js';
import { accumulateToolResults } from './retry-tool-results.js';
import type { RetryCallbacks, RetrySessionState } from './retry-types.js';

// ── Context-loss recovery ────────────────────────────────────

/** Handle inter-movement context loss recovery (resume session expired) */
export function applyInterMovementRecovery(
  state: RetryLoopState,
  promptWithAttachments: string,
  history: MovementRecord[],
  callbacks: RetryCallbacks,
): void {
  const historicalResults = extractHistoricalToolResults(history);
  const allResults = [...historicalResults, ...state.accumulatedToolResults];

  callbacks.emit('onAutoRetry', {
    retryNumber: state.retryNumber,
    maxRetries: 3,
    toolName: 'InterMovementRecovery',
    completedCount: allResults.length,
  });
  callbacks.queueOutput(
    `\n[[MSTRO_CONTEXT_RECOVERY]] Session context expired — continuing with ${allResults.length} preserved results from prior work (retry ${state.retryNumber}/3).\n`
  );
  callbacks.flushOutputQueue();

  state.freshRecoveryMode = true;
  state.currentPrompt = buildInterMovementRecoveryPrompt(promptWithAttachments, allResults, history);
}

/** Handle native-timeout context loss recovery (tool timeouts caused confusion) */
export function applyNativeTimeoutRecovery(
  result: HeadlessRunResult,
  state: RetryLoopState,
  promptWithAttachments: string,
  session: RetrySessionState,
  callbacks: RetryCallbacks,
): void {
  const completedCount = state.accumulatedToolResults.length;

  callbacks.emit('onAutoRetry', {
    retryNumber: state.retryNumber,
    maxRetries: 3,
    toolName: 'ContextRecovery',
    completedCount,
  });

  if (result.claudeSessionId && state.retryNumber === 1) {
    callbacks.queueOutput(
      `\n[[MSTRO_CONTEXT_RECOVERY]] Context loss detected — resuming session with ${completedCount} preserved results (retry ${state.retryNumber}/3).\n`
    );
    callbacks.flushOutputQueue();
    state.contextRecoverySessionId = result.claudeSessionId;
    session.claudeSessionId = result.claudeSessionId;
    state.currentPrompt = buildContextRecoveryPrompt(promptWithAttachments);
  } else {
    callbacks.queueOutput(
      `\n[[MSTRO_CONTEXT_RECOVERY]] Continuing with fresh context — ${completedCount} preserved results injected (retry ${state.retryNumber}/3).\n`
    );
    callbacks.flushOutputQueue();
    state.freshRecoveryMode = true;
    state.currentPrompt = buildFreshRecoveryPrompt(promptWithAttachments, state.accumulatedToolResults, state.timedOutTools);
  }
}

/** Check if context loss recovery should trigger. Returns true if loop should continue. */
export function shouldRetryContextLoss(
  result: HeadlessRunResult,
  state: RetryLoopState,
  session: RetrySessionState,
  useResume: boolean,
  nativeTimeouts: number,
  maxRetries: number,
  promptWithAttachments: string,
  callbacks: RetryCallbacks,
): boolean {
  if (state.checkpointRef.value || state.retryNumber >= maxRetries || !state.contextLost) {
    return false;
  }
  accumulateToolResults(result, state);
  state.retryNumber++;
  const path = (useResume && nativeTimeouts === 0) ? 'InterMovementRecovery' : 'NativeTimeoutRecovery';
  state.retryLog.push({
    retryNumber: state.retryNumber,
    path,
    reason: `Context lost (${nativeTimeouts} timeouts, ${state.accumulatedToolResults.length} tools preserved)`,
    timestamp: Date.now(),
  });
  if (useResume && nativeTimeouts === 0) {
    applyInterMovementRecovery(state, promptWithAttachments, session.history.movements, callbacks);
  } else {
    applyNativeTimeoutRecovery(result, state, promptWithAttachments, session, callbacks);
  }
  return true;
}

// ── Tool-timeout retry ───────────────────────────────────────

/** Handle tool timeout checkpoint. Returns true if loop should continue. */
export function applyToolTimeoutRetry(
  state: RetryLoopState,
  maxRetries: number,
  promptWithAttachments: string,
  callbacks: RetryCallbacks,
  model: string | undefined,
  effortLevel: string | undefined,
): boolean {
  if (!state.checkpointRef.value || state.retryNumber >= maxRetries) {
    return false;
  }

  const cp: ExecutionCheckpoint = state.checkpointRef.value;
  state.retryNumber++;

  state.timedOutTools.push({
    toolName: cp.hungTool.toolName,
    input: cp.hungTool.input ?? {},
    timeoutMs: cp.hungTool.timeoutMs,
  });

  const canResumeSession = cp.inProgressTools.length === 0 && !!cp.claudeSessionId;
  state.retryLog.push({
    retryNumber: state.retryNumber,
    path: 'ToolTimeout',
    reason: `${cp.hungTool.toolName} timed out after ${cp.hungTool.timeoutMs}ms, ${cp.completedTools.length} tools completed, ${canResumeSession ? 'resuming' : 'fresh start'}`,
    timestamp: Date.now(),
  });
  callbacks.emit('onAutoRetry', {
    retryNumber: state.retryNumber,
    maxRetries,
    toolName: cp.hungTool.toolName,
    url: cp.hungTool.url,
    completedCount: cp.completedTools.length,
  });

  trackEvent(AnalyticsEvents.IMPROVISE_AUTO_RETRY, {
    retry_number: state.retryNumber,
    hung_tool: cp.hungTool.toolName,
    hung_url: cp.hungTool.url?.slice(0, 200),
    completed_tools: cp.completedTools.length,
    elapsed_ms: cp.elapsedMs,
    resume_attempted: canResumeSession,
    model: model || 'default',
    effort_level: effortLevel || 'auto',
  });

  state.currentPrompt = canResumeSession
    ? buildResumeRetryPrompt(cp, state.timedOutTools)
    : buildRetryPrompt(cp, promptWithAttachments, state.timedOutTools);

  callbacks.queueOutput(
    `\n[[MSTRO_AUTO_RETRY]] Auto-retry ${state.retryNumber}/${maxRetries}: ${canResumeSession ? 'Resuming session' : 'Continuing'} with ${cp.completedTools.length} successful results, skipping failed ${cp.hungTool.toolName}.\n`
  );
  callbacks.flushOutputQueue();

  return true;
}

// ── Signal-crash retry ───────────────────────────────────────

/** Detect and retry after a signal crash. Returns true if loop should continue. */
export function shouldRetrySignalCrash(
  result: HeadlessRunResult,
  state: RetryLoopState,
  session: RetrySessionState,
  maxRetries: number,
  promptWithAttachments: string,
  callbacks: RetryCallbacks,
): boolean {
  const isSignalCrash = !!result.signalName;
  const exitCodeSignal = !result.completed && !result.signalName && result.error?.match(/exited with code (1[2-9]\d|[2-9]\d{2})/);
  if ((!isSignalCrash && !exitCodeSignal) || state.retryNumber >= maxRetries) {
    return false;
  }
  if (state.checkpointRef.value) {
    return false;
  }

  accumulateToolResults(result, state);
  state.retryNumber++;

  const completedCount = state.accumulatedToolResults.length;
  const signalInfo = result.signalName || 'unknown signal';
  const useResume = !!result.claudeSessionId && state.retryNumber === 1;

  state.retryLog.push({
    retryNumber: state.retryNumber,
    path: 'SignalCrash',
    reason: `Process killed (${signalInfo}), ${completedCount} tools preserved, ${useResume ? 'resuming' : 'fresh start'}`,
    timestamp: Date.now(),
  });

  callbacks.emit('onAutoRetry', {
    retryNumber: state.retryNumber,
    maxRetries,
    toolName: `SignalCrash(${signalInfo})`,
    completedCount,
  });

  trackEvent(AnalyticsEvents.IMPROVISE_AUTO_RETRY, {
    retry_number: state.retryNumber,
    hung_tool: `signal_crash:${signalInfo}`,
    completed_tools: completedCount,
    resume_attempted: useResume,
  });

  if (useResume) {
    callbacks.queueOutput(
      `\n[[MSTRO_SIGNAL_RECOVERY]] Process killed (${signalInfo}) — resuming session with ${completedCount} preserved results (retry ${state.retryNumber}/${maxRetries}).\n`
    );
    callbacks.flushOutputQueue();
    state.contextRecoverySessionId = result.claudeSessionId;
    session.claudeSessionId = result.claudeSessionId;
    state.currentPrompt = buildSignalCrashRecoveryPrompt(promptWithAttachments, true);
  } else {
    callbacks.queueOutput(
      `\n[[MSTRO_SIGNAL_RECOVERY]] Process killed (${signalInfo}) — restarting with ${completedCount} preserved results (retry ${state.retryNumber}/${maxRetries}).\n`
    );
    callbacks.flushOutputQueue();
    state.freshRecoveryMode = true;
    const allResults = [...extractHistoricalToolResults(session.history.movements), ...state.accumulatedToolResults];
    state.currentPrompt = buildSignalCrashRecoveryPrompt(promptWithAttachments, false, allResults);
  }

  return true;
}
