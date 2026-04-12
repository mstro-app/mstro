// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Retry and recovery logic for improvisation sessions.
 * Handles context loss, tool timeouts, signal crashes, and premature completion.
 */

import { AnalyticsEvents, trackEvent } from '../services/analytics.js';
import { hlog } from './headless/headless-logger.js';
import { HeadlessRunner } from './headless/index.js';
import { assessBestResult, assessContextLoss, assessPrematureCompletion, type ContextLossContext } from './headless/stall-assessor.js';
import type { ExecutionCheckpoint } from './headless/types.js';
import type { FileAttachment, HeadlessRunResult, ImprovisationOptions, MovementRecord, RetryLoopState, SessionHistory } from './improvisation-types.js';
import { scoreRunResult } from './improvisation-types.js';
import {
  buildContextRecoveryPrompt,
  buildFreshRecoveryPrompt,
  buildHistoricalContext,
  buildInterMovementRecoveryPrompt,
  buildResumeRetryPrompt,
  buildRetryPrompt,
  buildSignalCrashRecoveryPrompt,
  extractHistoricalToolResults,
} from './prompt-builders.js';

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

// ========== Resume Strategy ==========

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

// ========== Runner Creation ==========

/** Create HeadlessRunner for one retry iteration */
export function createExecutionRunner(
  state: RetryLoopState,
  session: RetrySessionState,
  callbacks: RetryCallbacks,
  sequenceNumber: number,
  useResume: boolean,
  resumeSessionId: string | undefined,
  imageAttachments: FileAttachment[] | undefined,
  workingDirOverride?: string,
): HeadlessRunner {
  return new HeadlessRunner({
    workingDir: workingDirOverride || session.options.workingDir,
    tokenBudgetThreshold: session.options.tokenBudgetThreshold,
    maxSessions: session.options.maxSessions,
    verbose: session.options.verbose,
    noColor: session.options.noColor,
    model: session.options.model,
    improvisationMode: true,
    movementNumber: sequenceNumber,
    continueSession: useResume,
    claudeSessionId: resumeSessionId,
    outputCallback: (text: string) => {
      if (callbacks.isCancelled()) return;
      callbacks.addEventLog({ type: 'output', data: { text, timestamp: Date.now() }, timestamp: Date.now() });
      callbacks.queueOutput(text);
      callbacks.flushOutputQueue();
    },
    thinkingCallback: (text: string) => {
      if (callbacks.isCancelled()) return;
      callbacks.addEventLog({ type: 'thinking', data: { text }, timestamp: Date.now() });
      callbacks.emit('onThinking', text);
      callbacks.flushOutputQueue();
    },
    toolUseCallback: (event) => {
      if (callbacks.isCancelled()) return;
      callbacks.addEventLog({ type: 'toolUse', data: { ...event, timestamp: Date.now() }, timestamp: Date.now() });
      callbacks.emit('onToolUse', event);
      callbacks.flushOutputQueue();
    },
    tokenUsageCallback: (usage) => {
      if (callbacks.isCancelled()) return;
      callbacks.emit('onTokenUsage', usage);
    },
    directPrompt: state.currentPrompt,
    imageAttachments,
    promptContext: (state.retryNumber === 0 && session.isResumedSession && session.isFirstPrompt)
      ? { accumulatedKnowledge: buildHistoricalContext(session.history.movements), filesModified: [] }
      : undefined,
    onToolTimeout: (checkpoint: ExecutionCheckpoint) => {
      state.checkpointRef.value = checkpoint;
    },
  });
}

// ========== Context Loss Detection ==========

/** Detect resume context loss (Path 1): session expired on --resume */
export function detectResumeContextLoss(
  result: HeadlessRunResult,
  state: RetryLoopState,
  useResume: boolean,
  maxRetries: number,
  nativeTimeouts: number,
  verbose: boolean,
): void {
  if (!useResume || state.checkpointRef.value || state.retryNumber >= maxRetries || nativeTimeouts > 0) {
    return;
  }
  if (!result.assistantResponse || result.assistantResponse.trim().length === 0) {
    state.contextLost = true;
    if (verbose) hlog('[CONTEXT-RECOVERY] Resume context loss: null/empty response');
  } else if (result.resumeBufferedOutput !== undefined) {
    state.contextLost = true;
    if (verbose) hlog('[CONTEXT-RECOVERY] Resume context loss: buffer never flushed (no thinking/tools)');
  } else if (
    (!result.toolUseHistory || result.toolUseHistory.length === 0) &&
    !result.thinkingOutput &&
    result.assistantResponse.length < 500
  ) {
    state.contextLost = true;
    if (verbose) hlog('[CONTEXT-RECOVERY] Resume context loss: no tools, no thinking, short response');
  }
}

/** Detect native timeout context loss (Path 2): tool timeouts caused confusion */
export async function detectNativeTimeoutContextLoss(
  result: HeadlessRunResult,
  state: RetryLoopState,
  maxRetries: number,
  nativeTimeouts: number,
  verbose: boolean,
): Promise<void> {
  if (state.contextLost) return;

  const succeededIds = new Set<string>();
  const allIds = new Set<string>();
  for (const t of result.toolUseHistory ?? []) {
    allIds.add(t.toolId);
    if (t.result !== undefined) succeededIds.add(t.toolId);
  }
  const toolsWithoutResult = [...allIds].filter(id => !succeededIds.has(id)).length;
  const effectiveTimeouts = Math.max(nativeTimeouts, toolsWithoutResult);

  if (effectiveTimeouts === 0 || !result.assistantResponse || state.checkpointRef.value || state.retryNumber >= maxRetries) {
    return;
  }

  const writeToolNames = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  const contextLossCtx: ContextLossContext = {
    assistantResponse: result.assistantResponse,
    effectiveTimeouts,
    nativeTimeoutCount: nativeTimeouts,
    successfulToolCalls: result.toolUseHistory?.filter(t => t.result !== undefined && !t.isError).length ?? 0,
    thinkingOutputLength: result.thinkingOutput?.length ?? 0,
    hasSuccessfulWrite: result.toolUseHistory?.some(
      t => writeToolNames.has(t.toolName) && t.result !== undefined && !t.isError
    ) ?? false,
  };

  const claudeCmd = process.env.CLAUDE_COMMAND || 'claude';
  const verdict = await assessContextLoss(contextLossCtx, claudeCmd, verbose);
  state.contextLost = verdict.contextLost;
  if (verbose) {
    hlog(`[CONTEXT-RECOVERY] Haiku verdict: ${state.contextLost ? 'LOST' : 'OK'} — ${verdict.reason}`);
  }
}

// ========== Tool Result Accumulation ==========

const MAX_ACCUMULATED_RESULTS = 50;

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

// ========== Recovery Strategies ==========

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

/** Handle tool timeout checkpoint. Returns true if loop should continue. */
export function applyToolTimeoutRetry(
  state: RetryLoopState,
  maxRetries: number,
  promptWithAttachments: string,
  callbacks: RetryCallbacks,
  model: string | undefined,
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

// ========== Premature Completion ==========

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

/**
 * Fast heuristic: detect response abandonment without a Haiku call.
 * When thinking is significantly longer than the response and the response
 * contains no tool calls, Claude likely planned work it never executed.
 * This pattern occurs after context compaction or heavy parallel tool results.
 */
function isResponseAbandoned(result: HeadlessRunResult): boolean {
  const thinkingLen = result.thinkingOutput?.length ?? 0;
  const responseLen = result.assistantResponse?.length ?? 0;
  const toolCallsInResponse = result.toolUseHistory?.filter(t => t.result !== undefined).length ?? 0;

  if (thinkingLen < 500 || responseLen > 1000) return false;
  if (toolCallsInResponse > 0 && responseLen > 200) return false;

  return thinkingLen >= responseLen * 3;
}

/**
 * Extract the final text block from a concatenated response.
 * The assistantResponse concatenates all text deltas including interleaved
 * progress messages between tool calls. The final paragraph (after the last
 * double-newline break) is the actual conclusion — earlier fragments are
 * progress updates that were already acted on via tool calls.
 */
function extractFinalTextBlock(response: string, maxLen: number): string {
  const lastBreak = response.lastIndexOf('\n\n');
  if (lastBreak !== -1 && response.length - lastBreak > 20) {
    return response.slice(lastBreak + 2).slice(-maxLen);
  }
  return response.slice(-maxLen);
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
    `\n${reason} — resuming session (retry ${state.retryNumber}/${maxRetries}).\n`
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

// ========== Best Result Selection ==========

/** Select the best result across retries using Haiku assessment */
export async function selectBestResult(
  state: RetryLoopState,
  result: HeadlessRunResult,
  userPrompt: string,
  verbose: boolean,
): Promise<HeadlessRunResult> {
  if (!state.bestResult || state.bestResult === result || state.retryNumber === 0) {
    return result;
  }

  const claudeCmd = process.env.CLAUDE_COMMAND || 'claude';
  const bestToolCount = state.bestResult.toolUseHistory?.filter(t => t.result !== undefined && !t.isError).length ?? 0;
  const currentToolCount = result.toolUseHistory?.filter(t => t.result !== undefined && !t.isError).length ?? 0;

  try {
    const verdict = await assessBestResult({
      originalPrompt: userPrompt,
      resultA: {
        successfulToolCalls: bestToolCount,
        responseLength: state.bestResult.assistantResponse?.length ?? 0,
        hasThinking: !!state.bestResult.thinkingOutput,
        responseTail: (state.bestResult.assistantResponse ?? '').slice(-500),
      },
      resultB: {
        successfulToolCalls: currentToolCount,
        responseLength: result.assistantResponse?.length ?? 0,
        hasThinking: !!result.thinkingOutput,
        responseTail: (result.assistantResponse ?? '').slice(-500),
      },
    }, claudeCmd, verbose);

    if (verdict.winner === 'A') {
      if (verbose) hlog(`[BEST-RESULT] Haiku picked earlier attempt: ${verdict.reason}`);
      return mergeResultSessionId(state.bestResult, result.claudeSessionId);
    }
    if (verbose) hlog(`[BEST-RESULT] Haiku picked final attempt: ${verdict.reason}`);
    return result;
  } catch {
    return fallbackBestResult(state.bestResult, result, verbose);
  }
}

function mergeResultSessionId(result: HeadlessRunResult, sessionId: string | undefined): HeadlessRunResult {
  if (sessionId) return { ...result, claudeSessionId: sessionId };
  return result;
}

function fallbackBestResult(bestResult: HeadlessRunResult, result: HeadlessRunResult, verbose: boolean): HeadlessRunResult {
  if (scoreRunResult(bestResult) > scoreRunResult(result)) {
    if (verbose) {
      hlog(`[BEST-RESULT] Haiku unavailable, numeric fallback: earlier attempt (score ${scoreRunResult(bestResult)} vs ${scoreRunResult(result)})`);
    }
    return mergeResultSessionId(bestResult, result.claudeSessionId);
  }
  return result;
}
