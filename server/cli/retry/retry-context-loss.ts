// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Context-loss detection: figures out when a run's output indicates the
 * Claude session dropped its memory, either on `--resume` (Path 1) or after
 * native tool timeouts scrambled the conversation (Path 2).
 */

import { hlog } from '../headless/headless-logger.js';
import { assessContextLoss, type ContextLossContext } from '../headless/stall-assessor.js';
import type { HeadlessRunResult, RetryLoopState } from '../improvisation-types.js';

const WRITE_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

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

  const { effectiveTimeouts } = computeEffectiveTimeouts(result, nativeTimeouts);
  if (effectiveTimeouts === 0 || !result.assistantResponse || state.checkpointRef.value || state.retryNumber >= maxRetries) {
    return;
  }

  const contextLossCtx: ContextLossContext = {
    assistantResponse: result.assistantResponse,
    effectiveTimeouts,
    nativeTimeoutCount: nativeTimeouts,
    successfulToolCalls: result.toolUseHistory?.filter(t => t.result !== undefined && !t.isError).length ?? 0,
    thinkingOutputLength: result.thinkingOutput?.length ?? 0,
    hasSuccessfulWrite: result.toolUseHistory?.some(
      t => WRITE_TOOL_NAMES.has(t.toolName) && t.result !== undefined && !t.isError
    ) ?? false,
  };

  const claudeCmd = process.env.CLAUDE_COMMAND || 'claude';
  const verdict = await assessContextLoss(contextLossCtx, claudeCmd, verbose);
  state.contextLost = verdict.contextLost;
  if (verbose) {
    hlog(`[CONTEXT-RECOVERY] Haiku verdict: ${state.contextLost ? 'LOST' : 'OK'} — ${verdict.reason}`);
  }
}

function computeEffectiveTimeouts(result: HeadlessRunResult, nativeTimeouts: number): { effectiveTimeouts: number } {
  const succeededIds = new Set<string>();
  const allIds = new Set<string>();
  for (const t of result.toolUseHistory ?? []) {
    allIds.add(t.toolId);
    if (t.result !== undefined) succeededIds.add(t.toolId);
  }
  const toolsWithoutResult = [...allIds].filter(id => !succeededIds.has(id)).length;
  return { effectiveTimeouts: Math.max(nativeTimeouts, toolsWithoutResult) };
}
