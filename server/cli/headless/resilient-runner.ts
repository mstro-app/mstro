// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Resilient Runner
 *
 * Wraps HeadlessRunner with composable retry strategies for tool timeouts,
 * signal crashes, context loss, and premature completions. Configurable via
 * policy levels: FULL (all strategies + best-result selection), STANDARD
 * (basic retry without context-loss detection), or NONE (single attempt).
 */

import { hlog, runWithFileLogger } from './headless-logger.js';
import {
  createRetryState,
  isResponseAbandoned,
  type RetryConfig,
  type RetryDecision,
  type RetryState,
  scoreResult,
  tryContextLoss,
  tryPrematureCompletion,
  trySignalCrash,
  tryToolTimeout,
} from './retry-strategies.js';
import { HeadlessRunner } from './runner.js';
import { assessBestResult } from './stall-assessor.js';
import type { ExecutionCheckpoint, ImageAttachment, SessionResult, ToolUseEvent } from './types.js';

export type RetryPolicy = 'FULL' | 'STANDARD' | 'NONE';

export interface ResilientRunnerConfig {
  workingDir: string;
  prompt: string;

  policy?: RetryPolicy;
  maxRetries?: number;

  stallWarningMs?: number;
  stallKillMs?: number;
  stallHardCapMs?: number;
  stallMaxExtensions?: number;

  outputCallback?: (text: string) => void;
  thinkingCallback?: (text: string) => void;
  toolUseCallback?: (event: ToolUseEvent) => void;
  tokenUsageCallback?: (usage: { inputTokens: number; outputTokens: number }) => void;

  logLabel?: string;
  logDir?: string;

  abortSignal?: AbortSignal;
  verbose?: boolean;
  model?: string;
  extraEnv?: Record<string, string>;

  maxAutoContinues?: number;

  imageAttachments?: ImageAttachment[];

  onRetry?: (info: { retryNumber: number; maxRetries: number; path: string; reason: string }) => void;
}

function resolveRetryConfig(policy: RetryPolicy, verbose: boolean): RetryConfig {
  switch (policy) {
    case 'FULL':
      return { enableContextLossDetection: true, enableBestResultSelection: true, verbose };
    case 'STANDARD':
      return { enableContextLossDetection: false, enableBestResultSelection: false, verbose };
    case 'NONE':
      return { enableContextLossDetection: false, enableBestResultSelection: false, verbose };
  }
}

function wireAbortSignal(runner: HeadlessRunner, abortSignal?: AbortSignal): (() => void) | null {
  if (!abortSignal) return null;
  const handler = () => { runner.cleanup(); };
  abortSignal.addEventListener('abort', handler, { once: true });
  return () => abortSignal.removeEventListener('abort', handler);
}

function abortedFallback(bestResult: SessionResult | null): SessionResult {
  return bestResult ?? {
    completed: false,
    needsHandoff: false,
    totalTokens: 0,
    sessionId: '',
    error: 'Execution stopped by user',
  };
}

function buildResultSummary(r: SessionResult): {
  successfulToolCalls: number;
  responseLength: number;
  hasThinking: boolean;
  responseTail: string;
} {
  return {
    successfulToolCalls: r.toolUseHistory?.filter(t => t.result !== undefined && !t.isError).length ?? 0,
    responseLength: r.assistantResponse?.length ?? 0,
    hasThinking: !!r.thinkingOutput,
    responseTail: (r.assistantResponse ?? '').slice(-500),
  };
}

export class ResilientRunner {
  private readonly config: ResilientRunnerConfig;

  constructor(config: ResilientRunnerConfig) {
    this.config = config;
  }

  async run(): Promise<SessionResult> {
    const { logLabel, logDir } = this.config;
    if (logLabel) {
      return runWithFileLogger(logLabel, () => this.execute(), logDir);
    }
    return this.execute();
  }

  private async execute(): Promise<SessionResult> {
    const policy = this.config.policy ?? 'STANDARD';
    const maxRetries = this.config.maxRetries ?? 3;
    const verbose = this.config.verbose ?? true;
    const maxAutoContinues = this.config.maxAutoContinues ?? (policy === 'NONE' ? 0 : 1);
    const retryConfig = resolveRetryConfig(policy, verbose);

    if (policy === 'NONE') {
      return this.runSingle(this.config.prompt, false, undefined);
    }

    const state = createRetryState(this.config.prompt, maxRetries);
    const loopResult = await this.retryLoop(state, retryConfig, policy, maxRetries);

    let result: SessionResult;
    if (retryConfig.enableBestResultSelection && state.retryNumber > 0 && state.bestResult && loopResult) {
      result = await this.selectBestResult(state.bestResult, loopResult, this.config.prompt);
    } else {
      result = loopResult ?? abortedFallback(state.bestResult);
    }

    return this.autoContinue(result, retryConfig, policy, maxRetries, maxAutoContinues);
  }

  private async retryLoop(
    state: RetryState,
    retryConfig: RetryConfig,
    policy: RetryPolicy,
    maxRetries: number,
    initialPrompt?: string,
    initialResumeSessionId?: string,
  ): Promise<SessionResult | undefined> {
    let lastResult: SessionResult | undefined;
    let currentPrompt = initialPrompt ?? this.config.prompt;
    let resumeSessionId = initialResumeSessionId;
    let useResume = !!initialResumeSessionId;

    while (state.retryNumber <= maxRetries) {
      if (this.config.abortSignal?.aborted) return undefined;

      state.checkpoint = null;
      const result = await this.runAttempt(currentPrompt, useResume, resumeSessionId, state);
      if (this.config.abortSignal?.aborted) return state.bestResult ?? result;

      if (!state.bestResult || scoreResult(result) > scoreResult(state.bestResult)) {
        state.bestResult = result;
      }
      lastResult = result;

      const decision = await this.evaluateStrategies(result, state, retryConfig, policy);
      if (!decision) break;

      state.checkpoint = null;
      currentPrompt = decision.nextPrompt;
      resumeSessionId = decision.resumeSessionId;
      useResume = decision.useResume;

      hlog(`[RESILIENT] Retry ${state.retryNumber}/${maxRetries}: ${decision.path} — ${decision.reason}`);
      this.config.onRetry?.({
        retryNumber: state.retryNumber,
        maxRetries,
        path: decision.path,
        reason: decision.reason,
      });
    }

    return lastResult;
  }

  private async runAttempt(
    prompt: string,
    useResume: boolean,
    resumeSessionId: string | undefined,
    state: RetryState,
  ): Promise<SessionResult> {
    const runner = this.createHeadlessRunner(prompt, useResume, resumeSessionId, state);
    const removeAbortListener = wireAbortSignal(runner, this.config.abortSignal);
    const result = await runner.run();
    removeAbortListener?.();
    return result;
  }

  private createHeadlessRunner(
    prompt: string,
    continueSession: boolean,
    claudeSessionId: string | undefined,
    state: RetryState,
  ): HeadlessRunner {
    return new HeadlessRunner({
      workingDir: this.config.workingDir,
      directPrompt: prompt,
      stallWarningMs: this.config.stallWarningMs,
      stallKillMs: this.config.stallKillMs,
      stallHardCapMs: this.config.stallHardCapMs,
      stallMaxExtensions: this.config.stallMaxExtensions,
      verbose: this.config.verbose ?? true,
      continueSession: continueSession || undefined,
      claudeSessionId,
      outputCallback: this.config.outputCallback,
      thinkingCallback: this.config.thinkingCallback,
      toolUseCallback: this.config.toolUseCallback,
      tokenUsageCallback: this.config.tokenUsageCallback,
      model: this.config.model,
      extraEnv: this.config.extraEnv,
      imageAttachments: this.config.imageAttachments,
      onToolTimeout: (cp: ExecutionCheckpoint) => {
        state.checkpoint = cp;
      },
    });
  }

  private async evaluateStrategies(
    result: SessionResult,
    state: RetryState,
    retryConfig: RetryConfig,
    policy: RetryPolicy,
  ): Promise<RetryDecision | null> {
    const toolTimeout = tryToolTimeout(result, state);
    if (toolTimeout) return toolTimeout;

    const signalCrash = trySignalCrash(result, state);
    if (signalCrash) return signalCrash;

    if (policy === 'FULL') {
      const contextLoss = await tryContextLoss(result, state, retryConfig);
      if (contextLoss) return contextLoss;
    }

    const premature = await tryPrematureCompletion(result, state, retryConfig);
    if (premature) return premature;

    return null;
  }

  private async selectBestResult(
    bestResult: SessionResult,
    finalResult: SessionResult,
    originalPrompt: string,
  ): Promise<SessionResult> {
    if (bestResult === finalResult) return finalResult;

    try {
      const verdict = await assessBestResult(
        {
          originalPrompt,
          resultA: buildResultSummary(bestResult),
          resultB: buildResultSummary(finalResult),
        },
        process.env.CLAUDE_COMMAND || 'claude',
        this.config.verbose ?? true,
      );

      hlog(`[RESILIENT] Best result selection: ${verdict.winner} — ${verdict.reason}`);
      return verdict.winner === 'A' ? bestResult : finalResult;
    } catch (err) {
      hlog(`[RESILIENT] Best result assessment failed, using score: ${err}`);
      return scoreResult(bestResult) >= scoreResult(finalResult) ? bestResult : finalResult;
    }
  }

  private shouldAutoContinue(result: SessionResult): boolean {
    if (!result.claudeSessionId) return false;

    if (result.signalName) return true;

    if (result.completed && !result.signalName && result.stopReason === 'end_turn') {
      return isResponseAbandoned(result);
    }

    return false;
  }

  private async autoContinue(
    initialResult: SessionResult,
    retryConfig: RetryConfig,
    policy: RetryPolicy,
    maxRetries: number,
    maxAutoContinues: number,
  ): Promise<SessionResult> {
    let result = initialResult;

    for (let count = 0; count < maxAutoContinues; count++) {
      if (this.config.abortSignal?.aborted) break;
      if (!this.shouldAutoContinue(result)) break;

      const reason = result.signalName ? 'Process stalled' : 'Response appears incomplete';
      hlog(`[RESILIENT] Auto-continue ${count + 1}/${maxAutoContinues}: ${reason}`);
      this.config.onRetry?.({
        retryNumber: count + 1,
        maxRetries: maxAutoContinues,
        path: 'AutoContinue',
        reason,
      });

      const continueState = createRetryState('continue', maxRetries);
      const continueResult = await this.retryLoop(
        continueState, retryConfig, policy, maxRetries,
        'continue', result.claudeSessionId,
      );

      if (!continueResult) break;
      result = scoreResult(continueResult) >= scoreResult(result) ? continueResult : result;
    }

    return result;
  }

  private async runSingle(
    prompt: string,
    continueSession: boolean,
    claudeSessionId: string | undefined,
  ): Promise<SessionResult> {
    const runner = new HeadlessRunner({
      workingDir: this.config.workingDir,
      directPrompt: prompt,
      stallWarningMs: this.config.stallWarningMs,
      stallKillMs: this.config.stallKillMs,
      stallHardCapMs: this.config.stallHardCapMs,
      stallMaxExtensions: this.config.stallMaxExtensions,
      verbose: this.config.verbose ?? true,
      continueSession: continueSession || undefined,
      claudeSessionId,
      outputCallback: this.config.outputCallback,
      thinkingCallback: this.config.thinkingCallback,
      toolUseCallback: this.config.toolUseCallback,
      tokenUsageCallback: this.config.tokenUsageCallback,
      model: this.config.model,
      extraEnv: this.config.extraEnv,
      imageAttachments: this.config.imageAttachments,
    });

    const removeAbortListener = wireAbortSignal(runner, this.config.abortSignal);
    const result = await runner.run();
    removeAbortListener?.();

    return result;
  }
}
