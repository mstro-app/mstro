// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Issue Retry — Retry loop for PM issue execution.
 *
 * Brings the same resilience as Chat view (improvisation-retry.ts) to PM agents:
 * - Tool timeout checkpoint recovery (preserves completed tools, skips hung tool)
 * - Signal crash recovery (preserves accumulated results across retries)
 * - Premature completion handling (max_tokens / end_turn → resume with "continue")
 *
 * Unlike Chat's retry system, PM agents don't maintain session continuity across
 * prompts — each issue is independent — so we skip inter-movement recovery and
 * simplify the resume strategy.
 */

import { hlog } from '../../cli/headless/headless-logger.js';
import { HeadlessRunner } from '../../cli/headless/index.js';
import { assessPrematureCompletion } from '../../cli/headless/stall-assessor.js';
import type { ExecutionCheckpoint, SessionResult } from '../../cli/headless/types.js';
import {
  buildResumeRetryPrompt,
  buildRetryPrompt,
  buildSignalCrashRecoveryPrompt,
} from '../../cli/prompt-builders.js';

/** Max retries per issue execution (tool timeout, signal crash, premature completion combined) */
const MAX_ISSUE_RETRIES = 3;

/** Max accumulated tool results to carry across retries */
const MAX_ACCUMULATED_RESULTS = 50;

/** Lightweight tool record for accumulation across retries */
interface ToolRecord {
  toolName: string;
  toolId: string;
  toolInput: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  duration?: number;
}

interface IssueRetryState {
  currentPrompt: string;
  retryNumber: number;
  checkpoint: ExecutionCheckpoint | null;
  accumulatedToolResults: ToolRecord[];
  timedOutTools: Array<{ toolName: string; input: Record<string, unknown>; timeoutMs: number }>;
  /** Session ID from a prior run — enables --resume for premature completion */
  lastSessionId: string | undefined;
  bestResult: SessionResult | null;
}

export interface IssueRunnerConfig {
  workingDir: string;
  /** Original enriched prompt for this issue */
  prompt: string;
  /** Stall detection timeouts (ms) */
  stallWarningMs: number;
  stallKillMs: number;
  stallHardCapMs: number;
  stallMaxExtensions: number;
  /** Callback for streaming output to executor event bus */
  outputCallback?: (text: string) => void;
  /** Extra environment variables for spawned Claude processes (e.g. API keys) */
  extraEnv?: Record<string, string>;
  /** Signal to abort execution — when aborted, kills the running HeadlessRunner */
  abortSignal?: AbortSignal;
}

/**
 * Execute a PM issue with retry logic.
 *
 * This wraps HeadlessRunner.run() with the same retry strategies as Chat view:
 * 1. Tool timeout → checkpoint recovery with accumulated results
 * 2. Signal crash → fresh start with preserved tool results
 * 3. Premature completion → resume session with "continue"
 */
export async function runIssueWithRetry(config: IssueRunnerConfig): Promise<SessionResult> {
  const state: IssueRetryState = {
    currentPrompt: config.prompt,
    retryNumber: 0,
    checkpoint: null,
    accumulatedToolResults: [],
    timedOutTools: [],
    lastSessionId: undefined,
    bestResult: null,
  };

  let result: SessionResult | undefined;

  while (state.retryNumber <= MAX_ISSUE_RETRIES) {
    // Check abort before starting a new attempt
    if (config.abortSignal?.aborted) {
      return state.bestResult ?? {
        completed: false, needsHandoff: false, totalTokens: 0, sessionId: '',
        error: 'Execution stopped by user',
      };
    }

    // Clear checkpoint from prior iteration
    state.checkpoint = null;

    // Determine resume strategy
    const useResume = !!state.lastSessionId;
    const resumeSessionId = state.lastSessionId;
    state.lastSessionId = undefined;

    const runner = new HeadlessRunner({
      workingDir: config.workingDir,
      directPrompt: state.currentPrompt,
      stallWarningMs: config.stallWarningMs,
      stallKillMs: config.stallKillMs,
      stallHardCapMs: config.stallHardCapMs,
      stallMaxExtensions: config.stallMaxExtensions,
      verbose: true,
      continueSession: useResume,
      claudeSessionId: resumeSessionId,
      outputCallback: config.outputCallback,
      onToolTimeout: (cp: ExecutionCheckpoint) => {
        state.checkpoint = cp;
      },
      extraEnv: config.extraEnv,
    });

    // Wire abort signal to kill the runner's processes
    const abortHandler = () => { runner.cleanup(); };
    if (config.abortSignal) {
      if (config.abortSignal.aborted) {
        runner.cleanup();
        return state.bestResult ?? {
          completed: false, needsHandoff: false, totalTokens: 0, sessionId: '',
          error: 'Execution stopped by user',
        };
      }
      config.abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    result = await runner.run();

    // Clean up abort listener
    config.abortSignal?.removeEventListener('abort', abortHandler);

    // If aborted during run, return immediately
    if (config.abortSignal?.aborted) {
      return state.bestResult ?? result ?? {
        completed: false, needsHandoff: false, totalTokens: 0, sessionId: '',
        error: 'Execution stopped by user',
      };
    }

    // Track best result for fallback selection
    if (!state.bestResult || scoreResult(result) > scoreResult(state.bestResult)) {
      state.bestResult = result;
    }

    // Evaluate retry strategies in priority order
    if (tryToolTimeoutRetry(state, result, config)) continue;
    if (trySignalCrashRetry(state, result, config)) continue;
    if (await tryPrematureCompletionRetry(state, result, config)) continue;

    // No retry needed — break out
    break;
  }

  return result ?? state.bestResult ?? {
    completed: false,
    needsHandoff: false,
    totalTokens: 0,
    sessionId: '',
    error: 'No result produced after retries',
  };
}

// ========== Retry Strategies ==========

/**
 * Strategy 1: Tool timeout checkpoint recovery.
 * When a tool times out, we have a checkpoint with all completed tools.
 * Build a new prompt injecting those results and skip the hung resource.
 */
function tryToolTimeoutRetry(
  state: IssueRetryState,
  _result: SessionResult,
  config: IssueRunnerConfig,
): boolean {
  if (!state.checkpoint || state.retryNumber >= MAX_ISSUE_RETRIES) return false;

  const cp = state.checkpoint;
  state.retryNumber++;

  state.timedOutTools.push({
    toolName: cp.hungTool.toolName,
    input: cp.hungTool.input ?? {},
    timeoutMs: cp.hungTool.timeoutMs,
  });

  const canResume = cp.inProgressTools.length === 0 && !!cp.claudeSessionId;

  hlog(`[PM-RETRY] Tool timeout: ${cp.hungTool.toolName} after ${Math.round(cp.hungTool.timeoutMs / 1000)}s, ${cp.completedTools.length} tools completed, retry ${state.retryNumber}/${MAX_ISSUE_RETRIES} (${canResume ? 'resume' : 'fresh'})`);

  if (canResume) {
    state.lastSessionId = cp.claudeSessionId;
    state.currentPrompt = buildResumeRetryPrompt(cp, state.timedOutTools);
  } else {
    state.currentPrompt = buildRetryPrompt(cp, config.prompt, state.timedOutTools);
  }

  config.outputCallback?.(`\n[PM-RETRY] Auto-retry ${state.retryNumber}/${MAX_ISSUE_RETRIES}: ${canResume ? 'Resuming session' : 'Continuing'} with ${cp.completedTools.length} results, skipping failed ${cp.hungTool.toolName}.\n`);

  return true;
}

/**
 * Strategy 2: Signal crash recovery.
 * Process was killed by signal (SIGTERM/SIGKILL from stall watchdog or OS).
 * Accumulate completed tools and retry with preserved context.
 */
function trySignalCrashRetry(
  state: IssueRetryState,
  result: SessionResult,
  config: IssueRunnerConfig,
): boolean {
  const isSignalCrash = !!result.signalName;
  const exitCodeSignal = !result.completed && !result.signalName && result.error?.match(/exited with code (1[2-9]\d|[2-9]\d{2})/);
  if ((!isSignalCrash && !exitCodeSignal) || state.retryNumber >= MAX_ISSUE_RETRIES) return false;
  // Don't double-handle if a checkpoint was already captured (tool timeout takes priority)
  if (state.checkpoint) return false;

  accumulateToolResults(result, state);
  state.retryNumber++;

  const signalInfo = result.signalName || 'unknown signal';
  const useResume = !!result.claudeSessionId && state.retryNumber === 1;

  hlog(`[PM-RETRY] Signal crash: ${signalInfo}, ${state.accumulatedToolResults.length} tools preserved, retry ${state.retryNumber}/${MAX_ISSUE_RETRIES} (${useResume ? 'resume' : 'fresh'})`);

  if (useResume) {
    state.lastSessionId = result.claudeSessionId;
    state.currentPrompt = buildSignalCrashRecoveryPrompt(config.prompt, true);
  } else {
    state.currentPrompt = buildSignalCrashRecoveryPrompt(
      config.prompt,
      false,
      state.accumulatedToolResults,
    );
  }

  config.outputCallback?.(`\n[PM-RETRY] Signal recovery ${state.retryNumber}/${MAX_ISSUE_RETRIES}: ${useResume ? 'Resuming' : 'Restarting'} with ${state.accumulatedToolResults.length} preserved results.\n`);

  return true;
}

/** Check if an end_turn result is actually incomplete using Haiku assessment. */
async function isEndTurnIncomplete(result: SessionResult): Promise<boolean> {
  if (!result.assistantResponse) return false;
  const claudeCmd = process.env.CLAUDE_COMMAND || 'claude';
  try {
    const verdict = await assessPrematureCompletion({
      responseTail: result.assistantResponse.slice(-800),
      successfulToolCalls: result.toolUseHistory?.filter(t => t.result !== undefined && !t.isError).length ?? 0,
      hasThinking: !!result.thinkingOutput,
      responseLength: result.assistantResponse.length,
    }, claudeCmd, true);

    hlog(`[PM-RETRY] Premature completion check: ${verdict.isIncomplete ? 'INCOMPLETE' : 'COMPLETE'} — ${verdict.reason}`);
    return verdict.isIncomplete;
  } catch {
    return false;
  }
}

/**
 * Strategy 3: Premature completion.
 * Claude hit max_tokens or ended early without finishing work.
 * Resume the session with "continue".
 */
async function tryPrematureCompletionRetry(
  state: IssueRetryState,
  result: SessionResult,
  config: IssueRunnerConfig,
): Promise<boolean> {
  if (!result.completed || result.signalName || state.retryNumber >= MAX_ISSUE_RETRIES) return false;
  if (state.checkpoint) return false;
  if (!result.claudeSessionId || !result.stopReason) return false;

  const isMaxTokens = result.stopReason === 'max_tokens';
  const isEndTurn = result.stopReason === 'end_turn';
  if (!isMaxTokens && !isEndTurn) return false;

  // max_tokens always continues; end_turn requires AI assessment
  if (isEndTurn && !(await isEndTurnIncomplete(result))) return false;

  state.retryNumber++;
  state.lastSessionId = result.claudeSessionId;
  state.currentPrompt = 'continue';

  const reason = isMaxTokens ? 'Output limit reached' : 'Task appears unfinished';
  hlog(`[PM-RETRY] Premature completion: ${reason}, resuming session, retry ${state.retryNumber}/${MAX_ISSUE_RETRIES}`);
  config.outputCallback?.(`\n[PM-RETRY] ${reason} — resuming session (retry ${state.retryNumber}/${MAX_ISSUE_RETRIES}).\n`);

  return true;
}

// ========== Helpers ==========

function accumulateToolResults(result: SessionResult, state: IssueRetryState): void {
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

function scoreResult(r: SessionResult): number {
  const toolCount = r.toolUseHistory?.filter(t => t.result !== undefined && !t.isError).length ?? 0;
  const responseLen = Math.min((r.assistantResponse?.length ?? 0) / 50, 100);
  const hasThinking = r.thinkingOutput ? 20 : 0;
  return toolCount * 10 + responseLen + hasThinking;
}
