// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Picks the best result across retry attempts. Prefers Haiku's judgment
 * when available; falls back to a numeric score when Haiku is unreachable.
 */

import { hlog } from '../headless/headless-logger.js';
import { assessBestResult } from '../headless/stall-assessor.js';
import type { HeadlessRunResult, RetryLoopState } from '../improvisation-types.js';
import { scoreRunResult } from '../improvisation-types.js';

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
