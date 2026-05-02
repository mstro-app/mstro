// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Shared retry strategy functions for headless execution.
 *
 * Pure decision functions that evaluate a SessionResult and RetryState,
 * returning a RetryDecision when a retry should happen or null to skip.
 * Used by both PM board execution (issue-retry) and Chat view (improvisation-retry).
 */

import {
  buildFreshRecoveryPrompt,
  buildResumeRetryPrompt,
  buildRetryPrompt,
  buildSignalCrashRecoveryPrompt,
} from '../prompt-builders.js';
import { hlog } from './headless-logger.js';
import { assessContextLoss, assessPrematureCompletion } from './stall-assessor.js';
import type { ExecutionCheckpoint, SessionResult } from './types.js';

export interface ToolRecord {
  toolName: string;
  toolId: string;
  toolInput: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  duration?: number;
}

export interface RetryState {
  retryNumber: number;
  maxRetries: number;
  originalPrompt: string;
  accumulatedToolResults: ToolRecord[];
  timedOutTools: Array<{ toolName: string; input: Record<string, unknown>; timeoutMs: number }>;
  checkpoint: ExecutionCheckpoint | null;
  bestResult: SessionResult | null;
}

export interface RetryDecision {
  nextPrompt: string;
  useResume: boolean;
  resumeSessionId?: string;
  path: string;
  reason: string;
}

export interface RetryConfig {
  enableContextLossDetection: boolean;
  enableBestResultSelection: boolean;
  verbose: boolean;
}

const MAX_ACCUMULATED_RESULTS = 50;

export function createRetryState(originalPrompt: string, maxRetries: number): RetryState {
  return {
    retryNumber: 0,
    maxRetries,
    originalPrompt,
    accumulatedToolResults: [],
    timedOutTools: [],
    checkpoint: null,
    bestResult: null,
  };
}

export function accumulateToolResults(result: SessionResult, state: RetryState): void {
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

export function scoreResult(r: SessionResult): number {
  const toolCount = r.toolUseHistory?.filter(t => t.result !== undefined && !t.isError).length ?? 0;
  const responseLen = Math.min((r.assistantResponse?.length ?? 0) / 50, 100);
  const hasThinking = r.thinkingOutput ? 20 : 0;
  return toolCount * 10 + responseLen + hasThinking;
}

export function isResponseAbandoned(result: SessionResult): boolean {
  const thinkingLen = result.thinkingOutput?.length ?? 0;
  const responseLen = result.assistantResponse?.length ?? 0;
  const toolCallsInResponse = result.toolUseHistory?.filter(t => t.result !== undefined).length ?? 0;

  if (thinkingLen < 500 || responseLen > 1000) return false;
  if (toolCallsInResponse > 0 && responseLen > 200) return false;

  return thinkingLen >= responseLen * 3;
}

export function extractFinalTextBlock(response: string, maxLen: number): string {
  const lastBreak = response.lastIndexOf('\n\n');
  if (lastBreak !== -1 && response.length - lastBreak > 20) {
    return response.slice(lastBreak + 2).slice(-maxLen);
  }
  return response.slice(-maxLen);
}

export function tryToolTimeout(_result: SessionResult, state: RetryState): RetryDecision | null {
  if (!state.checkpoint || state.retryNumber >= state.maxRetries) return null;

  const cp = state.checkpoint;
  state.retryNumber++;

  state.timedOutTools.push({
    toolName: cp.hungTool.toolName,
    input: cp.hungTool.input ?? {},
    timeoutMs: cp.hungTool.timeoutMs,
  });

  const canResume = cp.inProgressTools.length === 0 && !!cp.claudeSessionId;
  const reason = `${cp.hungTool.toolName} timed out after ${Math.round(cp.hungTool.timeoutMs / 1000)}s, ${cp.completedTools.length} tools completed, ${canResume ? 'resuming' : 'fresh start'}`;

  hlog(`[RETRY] Tool timeout: ${reason} (retry ${state.retryNumber}/${state.maxRetries})`);

  if (canResume) {
    return {
      nextPrompt: buildResumeRetryPrompt(cp, state.timedOutTools),
      useResume: true,
      resumeSessionId: cp.claudeSessionId,
      path: 'ToolTimeout',
      reason,
    };
  }

  return {
    nextPrompt: buildRetryPrompt(cp, state.originalPrompt, state.timedOutTools),
    useResume: false,
    path: 'ToolTimeout',
    reason,
  };
}

export function trySignalCrash(result: SessionResult, state: RetryState): RetryDecision | null {
  const isSignalCrash = !!result.signalName;
  const exitCodeSignal = !result.completed && !result.signalName && result.error?.match(/exited with code (1[2-9]\d|[2-9]\d{2})/);
  if (!isSignalCrash && !exitCodeSignal) return null;
  if (state.retryNumber >= state.maxRetries) return null;
  if (state.checkpoint) return null;

  accumulateToolResults(result, state);
  state.retryNumber++;

  const signalInfo = result.signalName || 'unknown signal';
  const useResume = !!result.claudeSessionId && state.retryNumber === 1;
  const reason = `Process killed (${signalInfo}), ${state.accumulatedToolResults.length} tools preserved, ${useResume ? 'resuming' : 'fresh start'}`;

  hlog(`[RETRY] Signal crash: ${reason} (retry ${state.retryNumber}/${state.maxRetries})`);

  if (useResume) {
    return {
      nextPrompt: buildSignalCrashRecoveryPrompt(state.originalPrompt, true),
      useResume: true,
      resumeSessionId: result.claudeSessionId,
      path: 'SignalCrash',
      reason,
    };
  }

  return {
    nextPrompt: buildSignalCrashRecoveryPrompt(state.originalPrompt, false, state.accumulatedToolResults),
    useResume: false,
    path: 'SignalCrash',
    reason,
  };
}

function detectContextLossHeuristic(result: SessionResult, verbose: boolean): boolean {
  if (!result.assistantResponse || result.assistantResponse.trim().length === 0) {
    if (verbose) hlog('[RETRY] Context loss heuristic: null/empty response');
    return true;
  }
  if (result.resumeBufferedOutput !== undefined) {
    if (verbose) hlog('[RETRY] Context loss heuristic: buffer never flushed (no thinking/tools)');
    return true;
  }
  if (
    (!result.toolUseHistory || result.toolUseHistory.length === 0) &&
    !result.thinkingOutput &&
    result.assistantResponse.length < 500
  ) {
    if (verbose) hlog('[RETRY] Context loss heuristic: no tools, no thinking, short response');
    return true;
  }
  return false;
}

function computeEffectiveTimeouts(result: SessionResult): number {
  const nativeTimeouts = result.nativeTimeoutCount ?? 0;
  if (nativeTimeouts === 0) return 0;

  const succeededIds = new Set<string>();
  const allIds = new Set<string>();
  for (const t of result.toolUseHistory ?? []) {
    allIds.add(t.toolId);
    if (t.result !== undefined) succeededIds.add(t.toolId);
  }
  const toolsWithoutResult = Array.from(allIds).filter(id => !succeededIds.has(id)).length;
  return Math.max(nativeTimeouts, toolsWithoutResult);
}

async function detectContextLossViaHaiku(
  result: SessionResult,
  effectiveTimeouts: number,
  verbose: boolean,
): Promise<boolean> {
  if (effectiveTimeouts === 0 || !result.assistantResponse) return false;

  const writeToolNames = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  const claudeCmd = process.env.CLAUDE_COMMAND || 'claude';
  try {
    const verdict = await assessContextLoss({
      assistantResponse: result.assistantResponse,
      effectiveTimeouts,
      nativeTimeoutCount: result.nativeTimeoutCount ?? 0,
      successfulToolCalls: result.toolUseHistory?.filter(t => t.result !== undefined && !t.isError).length ?? 0,
      thinkingOutputLength: result.thinkingOutput?.length ?? 0,
      hasSuccessfulWrite: result.toolUseHistory?.some(
        t => writeToolNames.has(t.toolName) && t.result !== undefined && !t.isError
      ) ?? false,
    }, claudeCmd, verbose);
    if (verbose) hlog(`[RETRY] Haiku context loss verdict: ${verdict.contextLost ? 'LOST' : 'OK'} — ${verdict.reason}`);
    return verdict.contextLost;
  } catch {
    if (verbose) hlog('[RETRY] Haiku context loss assessment failed, assuming OK');
    return false;
  }
}

export async function tryContextLoss(
  result: SessionResult,
  state: RetryState,
  config: RetryConfig,
): Promise<RetryDecision | null> {
  if (!config.enableContextLossDetection) return null;
  if (state.checkpoint || state.retryNumber >= state.maxRetries) return null;

  const heuristicLost = detectContextLossHeuristic(result, config.verbose);
  const haikuLost = heuristicLost
    ? false
    : await detectContextLossViaHaiku(result, computeEffectiveTimeouts(result), config.verbose);

  if (!heuristicLost && !haikuLost) return null;

  accumulateToolResults(result, state);
  state.retryNumber++;

  const reason = `Context lost, ${state.accumulatedToolResults.length} tools preserved`;
  hlog(`[RETRY] Context loss: ${reason} (retry ${state.retryNumber}/${state.maxRetries})`);

  return {
    nextPrompt: buildFreshRecoveryPrompt(state.originalPrompt, state.accumulatedToolResults, state.timedOutTools),
    useResume: false,
    path: 'ContextLoss',
    reason,
  };
}

async function isEndTurnIncomplete(result: SessionResult, verbose: boolean): Promise<boolean> {
  if (isResponseAbandoned(result)) {
    if (verbose) hlog('[RETRY] Response abandoned heuristic triggered');
    return true;
  }
  if (!result.assistantResponse) return false;

  const claudeCmd = process.env.CLAUDE_COMMAND || 'claude';
  try {
    const verdict = await assessPrematureCompletion({
      responseTail: extractFinalTextBlock(result.assistantResponse, 800),
      successfulToolCalls: result.toolUseHistory?.filter(t => t.result !== undefined && !t.isError).length ?? 0,
      hasThinking: !!result.thinkingOutput,
      responseLength: result.assistantResponse.length,
    }, claudeCmd, verbose);
    if (verbose) {
      hlog(`[RETRY] Premature completion verdict: ${verdict.isIncomplete ? 'INCOMPLETE' : 'COMPLETE'} — ${verdict.reason}`);
    }
    return verdict.isIncomplete;
  } catch {
    if (verbose) hlog('[RETRY] Premature completion assessment failed, assuming complete');
    return false;
  }
}

function isPrematureCompletionCandidate(result: SessionResult, state: RetryState): boolean {
  if (!result.completed || result.signalName || !result.stopReason) return false;
  if (state.retryNumber >= state.maxRetries) return false;
  if (state.checkpoint) return false;
  if (!result.claudeSessionId) return false;
  return result.stopReason === 'max_tokens' || result.stopReason === 'end_turn';
}

export async function tryPrematureCompletion(
  result: SessionResult,
  state: RetryState,
  config: RetryConfig,
): Promise<RetryDecision | null> {
  if (!isPrematureCompletionCandidate(result, state)) return null;

  const isMaxTokens = result.stopReason === 'max_tokens';

  if (!isMaxTokens && !(await isEndTurnIncomplete(result, config.verbose))) return null;

  state.retryNumber++;
  const reason = isMaxTokens ? 'Output limit reached' : 'Task appears unfinished (AI assessment)';

  hlog(`[RETRY] Premature completion: ${reason}, resuming session (retry ${state.retryNumber}/${state.maxRetries})`);

  return {
    nextPrompt: 'continue',
    useResume: true,
    resumeSessionId: result.claudeSessionId,
    path: 'PrematureCompletion',
    reason,
  };
}
