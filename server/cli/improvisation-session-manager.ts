// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Improvisation Session Manager v2
 *
 * Optimized for fast, direct prompt execution in Improvise mode.
 * For complex multi-part prompts with parallel/sequential movements, use Compose tab instead.
 *
 * Delegates to focused helpers:
 * - improvisation-output-queue.ts  — buffered stdout flush loop
 * - improvisation-history-store.ts — .mstro/history/*.json load/save
 * - improvisation-movements.ts     — pure movement-record builders
 * - improvisation-retry.ts         — retry decision tree + recovery strategies
 */

import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnalyticsEvents, trackEvent } from '../services/analytics.js';
import { herror } from './headless/headless-logger.js';
import { cleanupAttachments, preparePromptAndAttachments } from './improvisation-attachments.js';
import {
  ensureHistoryDir,
  loadHistory,
  resolveHistoryPaths,
  saveHistory,
} from './improvisation-history-store.js';
import {
  buildCancelledMovement,
  buildErrorMovement,
  buildSuccessMovement,
  CANCELLED_FALLBACK_RESULT,
  shouldAutoContinue,
} from './improvisation-movements.js';
import { OutputQueue } from './improvisation-output-queue.js';
import type { RetryCallbacks, RetrySessionState } from './improvisation-retry.js';
import {applyToolTimeoutRetry,
  createExecutionRunner,detectNativeTimeoutContextLoss, detectResumeContextLoss,
  determineResumeStrategy,
  selectBestResult,
  shouldRetryContextLoss,
  shouldRetryPrematureCompletion,
  shouldRetrySignalCrash
} from './improvisation-retry.js';
import type { FileAttachment, HeadlessRunResult, ImprovisationOptions, MovementRecord, RetryLoopState, SessionHistory } from './improvisation-types.js';
import { scoreRunResult } from './improvisation-types.js';

// Re-export types consumed by other packages
export type { FileAttachment, ImprovisationOptions, MovementRecord, SessionHistory, ToolUseRecord } from './improvisation-types.js';

export class ImprovisationSessionManager extends EventEmitter {
  private sessionId: string;
  private improviseDir: string;
  private historyPath: string;
  private history: SessionHistory;
  private currentRunner: import('./headless/index.js').HeadlessRunner | null = null;
  private options: ImprovisationOptions;
  private pendingApproval?: {
    plan: unknown;
    resolve: (approved: boolean) => void;
  };
  private outputBuffer: OutputQueue;
  private isFirstPrompt: boolean = true;
  private claudeSessionId: string | undefined;
  private isResumedSession: boolean = false;
  accumulatedKnowledge: string = '';

  private _isExecuting: boolean = false;
  private _executionStartTimestamp: number | undefined;
  private executionEventLog: Array<{ type: string; data: unknown; timestamp: number }> = [];
  private _cancelled: boolean = false;
  private _cancelCompleteEmitted: boolean = false;
  private _currentUserPrompt: string = '';
  private _currentSequenceNumber: number = 0;
  private _hasPersistedToDisk: boolean = false;

  static resumeFromHistory(workingDir: string, historicalSessionId: string, overrides?: Partial<ImprovisationOptions>): ImprovisationSessionManager {
    const historyDir = join(workingDir, '.mstro', 'history');
    const timestamp = historicalSessionId.replace('improv-', '');
    const historyPath = join(historyDir, `${timestamp}.json`);

    if (!existsSync(historyPath)) {
      throw new Error(`Historical session not found: ${historicalSessionId}`);
    }

    const historyData = JSON.parse(readFileSync(historyPath, 'utf-8')) as SessionHistory;
    const manager = new ImprovisationSessionManager({
      workingDir,
      sessionId: historyData.sessionId,
      ...overrides,
    });

    manager.history = historyData;
    manager.accumulatedKnowledge = historyData.movements
      .filter(m => m.summary)
      .map(m => m.summary)
      .join('\n\n');

    manager.isResumedSession = true;
    manager.isFirstPrompt = true;
    manager._hasPersistedToDisk = true;
    if (historyData.claudeSessionId) {
      manager.claudeSessionId = historyData.claudeSessionId;
    }

    return manager;
  }

  constructor(options: Partial<ImprovisationOptions> = {}) {
    super();

    this.options = {
      workingDir: options.workingDir || process.cwd(),
      sessionId: options.sessionId || `improv-${Date.now()}`,
      tokenBudgetThreshold: options.tokenBudgetThreshold || 170000,
      maxSessions: options.maxSessions || 10,
      verbose: options.verbose || false,
      noColor: options.noColor || false,
      model: options.model,
      effortLevel: options.effortLevel,
    };

    this.sessionId = this.options.sessionId;
    const paths = resolveHistoryPaths(this.options.workingDir, this.sessionId);
    this.improviseDir = paths.improviseDir;
    this.historyPath = paths.historyPath;
    ensureHistoryDir(this.improviseDir);

    this.history = loadHistory(this.historyPath, this.sessionId);
    // History is persisted lazily on the first `persistHistory` call (see
    // `executePrompt`). Deferring the initial write keeps the Chat History
    // view from showing "0 prompts" entries for tabs the user opens but
    // never prompts.

    this.outputBuffer = new OutputQueue(text => this.emit('onOutput', text));
    this.outputBuffer.start();
  }

  // ========== Output Queue ==========

  private queueOutput(text: string): void {
    this.outputBuffer.queue_(text);
  }

  private flushOutputQueue(): void {
    this.outputBuffer.flush();
  }

  // ========== Main Execution ==========

  async executePrompt(userPrompt: string, attachments?: FileAttachment[], options?: { workingDir?: string; isAutoContinue?: boolean; displayPrompt?: string }): Promise<MovementRecord> {
    const _execStart = Date.now();
    const isAutoContinue = options?.isAutoContinue ?? false;
    const displayPrompt = options?.displayPrompt ?? userPrompt;
    this._isExecuting = true;
    this._cancelled = false;
    this._cancelCompleteEmitted = false;
    if (!isAutoContinue) {
      this._autoContinueCount = 0;
      this._autoContinuePending = false;
    }
    this._executionStartTimestamp = _execStart;
    this.executionEventLog = [];

    const sequenceNumber = this.history.movements.length + 1;
    this._currentUserPrompt = displayPrompt;
    this._currentSequenceNumber = sequenceNumber;
    this.emit('onMovementStart', sequenceNumber, displayPrompt, isAutoContinue);
    trackEvent(AnalyticsEvents.IMPROVISE_PROMPT_RECEIVED, {
      prompt_length: userPrompt.length,
      has_attachments: !!(attachments && attachments.length > 0),
      attachment_count: attachments?.length || 0,
      image_attachment_count: attachments?.filter(a => a.isImage).length || 0,
      sequence_number: sequenceNumber,
      is_resumed_session: this.isResumedSession,
      model: this.options.model || 'default',
      effort_level: this.options.effortLevel || 'auto',
    });

    // Save pending movement immediately so history survives page refresh
    const pendingMovement: MovementRecord = {
      id: `prompt-${sequenceNumber}`,
      sequenceNumber,
      userPrompt: displayPrompt,
      timestamp: new Date().toISOString(),
      tokensUsed: 0,
      summary: '',
      filesModified: [],
      durationMs: 0,
      ...(isAutoContinue && { isAutoContinue: true }),
    };
    this.history.movements.push(pendingMovement);
    this.persistHistory();

    try {
      this.executionEventLog.push({
        type: 'movementStart',
        data: { sequenceNumber, prompt: displayPrompt, timestamp: Date.now(), executionStartTimestamp: this._executionStartTimestamp },
        timestamp: Date.now(),
      });

      const { prompt: promptWithAttachments, imageAttachments } = preparePromptAndAttachments(
        userPrompt, attachments, this.options.workingDir, this.sessionId,
        (msg) => { this.queueOutput(msg); this.flushOutputQueue(); },
      );
      const state: RetryLoopState = {
        currentPrompt: promptWithAttachments,
        retryNumber: 0,
        checkpointRef: { value: null },
        contextRecoverySessionId: undefined,
        freshRecoveryMode: false,
        accumulatedToolResults: [],
        contextLost: false,
        lastWatchdogCheckpoint: null,
        timedOutTools: [],
        bestResult: null,
        retryLog: [],
      };

      let result = await this.runRetryLoop(state, sequenceNumber, promptWithAttachments, imageAttachments, options?.workingDir);

      if (this._cancelled || this._cancelCompleteEmitted) {
        return this.handleCancelledExecution(result, displayPrompt, sequenceNumber, _execStart);
      }

      if (state.contextLost) this.claudeSessionId = undefined;
      result = await selectBestResult(state, result!, userPrompt, this.options.verbose);
      this.captureSessionAndSurfaceErrors(result);
      this.isFirstPrompt = false;

      const movement = buildSuccessMovement(
        result,
        { sequenceNumber, userPrompt: displayPrompt, execStart: _execStart, isAutoContinue },
        state.retryLog,
      );
      this.handleConflicts(result);
      this.persistMovement(movement);

      this._isExecuting = false;
      this._executionStartTimestamp = undefined;
      this.executionEventLog = [];

      if (!this._cancelCompleteEmitted) {
        this.emitMovementComplete(movement, result, _execStart, sequenceNumber);
      }
      this.maybeAutoContinue(result, userPrompt);

      return movement;

    } catch (error: unknown) {
      this.handleExecutionError(error, displayPrompt, sequenceNumber, _execStart);
    } finally {
      this.flushOutputQueue();
    }
  }

  // ========== Retry Loop ==========

  private buildRetryCallbacks(): RetryCallbacks {
    return {
      isCancelled: () => this._cancelled,
      queueOutput: (text) => this.queueOutput(text),
      flushOutputQueue: () => this.flushOutputQueue(),
      emit: (event, ...args) => this.emit(event, ...args),
      addEventLog: (entry) => this.executionEventLog.push(entry),
      setRunner: (runner) => { this.currentRunner = runner; },
    };
  }

  private buildRetrySessionState(): RetrySessionState {
    return {
      options: this.options,
      claudeSessionId: this.claudeSessionId,
      isFirstPrompt: this.isFirstPrompt,
      isResumedSession: this.isResumedSession,
      history: this.history,
      executionStartTimestamp: this._executionStartTimestamp,
    };
  }

  private syncSessionStateBack(session: RetrySessionState): void {
    if (session.claudeSessionId !== this.claudeSessionId) {
      this.claudeSessionId = session.claudeSessionId;
    }
  }

  private async runRetryLoop(
    state: RetryLoopState,
    sequenceNumber: number,
    promptWithAttachments: string,
    imageAttachments: FileAttachment[] | undefined,
    workingDirOverride: string | undefined,
  ): Promise<HeadlessRunResult | undefined> {
    const maxRetries = 3;
    let result: HeadlessRunResult | undefined;
    const callbacks = this.buildRetryCallbacks();

    const RETRY_BACKOFF_MS = [1000, 5000, 30000];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this._cancelled) break;
      if (state.retryNumber > 0) {
        const delay = RETRY_BACKOFF_MS[Math.min(state.retryNumber - 1, RETRY_BACKOFF_MS.length - 1)];
        await new Promise(r => setTimeout(r, delay));
        if (this._cancelled) break;
      }
      const iteration = await this.executeRetryIteration(state, callbacks, sequenceNumber, imageAttachments, workingDirOverride);
      result = iteration.result;
      if (this._cancelled) break;
      if (await this.evaluateRetryStrategies(result, state, iteration.useResume, iteration.nativeTimeouts, maxRetries, promptWithAttachments, callbacks)) continue;
      break;
    }
    return result;
  }

  /** Run a single iteration: spawn runner, execute, detect context loss */
  private async executeRetryIteration(
    state: RetryLoopState,
    callbacks: RetryCallbacks,
    sequenceNumber: number,
    imageAttachments: FileAttachment[] | undefined,
    workingDirOverride: string | undefined,
  ): Promise<{ result: HeadlessRunResult; useResume: boolean; nativeTimeouts: number }> {
    if (state.checkpointRef.value) state.lastWatchdogCheckpoint = state.checkpointRef.value;
    state.checkpointRef.value = null;
    state.contextLost = false;

    const session = this.buildRetrySessionState();
    const { useResume, resumeSessionId } = determineResumeStrategy(state, session);
    const runner = createExecutionRunner(state, session, callbacks, sequenceNumber, useResume, resumeSessionId, imageAttachments, workingDirOverride);
    this.currentRunner = runner;
    const result = await runner.run();
    this.currentRunner = null;

    if (!state.bestResult || scoreRunResult(result) > scoreRunResult(state.bestResult)) {
      state.bestResult = result;
    }
    const nativeTimeouts = result.nativeTimeoutCount ?? 0;
    detectResumeContextLoss(result, state, useResume, 3, nativeTimeouts, this.options.verbose);
    await detectNativeTimeoutContextLoss(result, state, 3, nativeTimeouts, this.options.verbose);
    if (!state.contextLost && result.postTimeoutOutput) {
      this.queueOutput(result.postTimeoutOutput);
      this.flushOutputQueue();
    }
    return { result, useResume, nativeTimeouts };
  }

  /** Evaluate all retry strategies. Returns true if the loop should continue. */
  private async evaluateRetryStrategies(
    result: HeadlessRunResult,
    state: RetryLoopState,
    useResume: boolean,
    nativeTimeouts: number,
    maxRetries: number,
    promptWithAttachments: string,
    callbacks: RetryCallbacks,
  ): Promise<boolean> {
    const session = this.buildRetrySessionState();

    if (shouldRetrySignalCrash(result, state, session, maxRetries, promptWithAttachments, callbacks)) { this.syncSessionStateBack(session); return true; }
    if (shouldRetryContextLoss(result, state, session, useResume, nativeTimeouts, maxRetries, promptWithAttachments, callbacks)) { this.syncSessionStateBack(session); return true; }
    if (applyToolTimeoutRetry(state, maxRetries, promptWithAttachments, callbacks, this.options.model, this.options.effortLevel)) return true;
    if (await shouldRetryPrematureCompletion(result, state, session, maxRetries, callbacks)) { this.syncSessionStateBack(session); return true; }
    this.syncSessionStateBack(session);
    return false;
  }

  // ========== Cancel / Error Handling ==========

  private resetExecutionState(): void {
    this._isExecuting = false;
    this._executionStartTimestamp = undefined;
    this.executionEventLog = [];
    this.currentRunner = null;
  }

  private handleCancelledExecution(
    result: HeadlessRunResult | undefined,
    userPrompt: string,
    sequenceNumber: number,
    execStart: number,
  ): MovementRecord {
    this.resetExecutionState();

    if (this._cancelCompleteEmitted) {
      const existing = this.history.movements.find(m => m.sequenceNumber === sequenceNumber);
      if (existing) return existing;
    }

    const cancelledMovement = buildCancelledMovement(result, { sequenceNumber, userPrompt, execStart });
    this.persistMovement(cancelledMovement);
    this.emitMovementComplete(cancelledMovement, result ?? CANCELLED_FALLBACK_RESULT, execStart, sequenceNumber);
    return cancelledMovement;
  }

  private handleExecutionError(
    error: unknown,
    displayPrompt: string,
    sequenceNumber: number,
    execStart: number,
  ): never {
    this.resetExecutionState();

    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorMovement = buildErrorMovement(errorMessage, { sequenceNumber, userPrompt: displayPrompt, execStart });
    this.persistMovement(errorMovement);

    this.emit('onMovementError', error);
    trackEvent(AnalyticsEvents.IMPROVISE_MOVEMENT_ERROR, {
      error_message: errorMessage.slice(0, 200),
      sequence_number: sequenceNumber,
      duration_ms: Date.now() - execStart,
      model: this.options.model || 'default',
      effort_level: this.options.effortLevel || 'auto',
    });
    this.queueOutput(`\n❌ Error: ${errorMessage}\n`);
    this.flushOutputQueue();
    throw error;
  }

  // ========== Post-Execution Helpers ==========

  private captureSessionAndSurfaceErrors(result: HeadlessRunResult): void {
    if (result.claudeSessionId) {
      this.claudeSessionId = result.claudeSessionId;
      this.history.claudeSessionId = result.claudeSessionId;
    }
    if (!result.completed && result.error) {
      this.queueOutput(`\n[[MSTRO_ERROR:EXECUTION_FAILED]] ${result.error}\n`);
      this.flushOutputQueue();
    }
  }

  private handleConflicts(result: HeadlessRunResult): void {
    if (!result.conflicts || result.conflicts.length === 0) return;
    this.queueOutput(`\n⚠ File conflicts detected: ${result.conflicts.length}`);
    result.conflicts.forEach(c => {
      this.queueOutput(`  - ${c.filePath} (modified by: ${c.modifiedBy.join(', ')})`);
      if (c.backupPath) this.queueOutput(`    Backup created: ${c.backupPath}`);
    });
    this.flushOutputQueue();
  }

  private persistMovement(movement: MovementRecord): void {
    const existingIdx = this.history.movements.findIndex(m => m.sequenceNumber === movement.sequenceNumber);
    if (existingIdx >= 0) {
      const previousTokens = this.history.movements[existingIdx].tokensUsed;
      this.history.movements[existingIdx] = movement;
      this.history.totalTokens += movement.tokensUsed - previousTokens;
    } else {
      this.history.movements.push(movement);
      this.history.totalTokens += movement.tokensUsed;
    }
    this.persistHistory();
  }

  private emitMovementComplete(movement: MovementRecord, result: HeadlessRunResult, execStart: number, sequenceNumber: number): void {
    this.emit('onMovementComplete', movement);
    trackEvent(AnalyticsEvents.IMPROVISE_MOVEMENT_COMPLETED, {
      tokens_used: movement.tokensUsed,
      duration_ms: Date.now() - execStart,
      sequence_number: sequenceNumber,
      tool_count: result.toolUseHistory?.length || 0,
      model: this.options.model || 'default',
      effort_level: this.options.effortLevel || 'auto',
    });
    this.emit('onSessionUpdate', this.getHistory());
  }

  // ========== Auto-Continue ==========

  private _autoContinueCount = 0;
  private _autoContinuePending = false;
  private static readonly MAX_AUTO_CONTINUES = 1;

  private maybeAutoContinue(result: HeadlessRunResult, userPrompt: string): void {
    const isStallKill = !this._cancelled && !!result.signalName;
    if (isStallKill && this._autoContinueCount < ImprovisationSessionManager.MAX_AUTO_CONTINUES) {
      this.scheduleAutoContinue('Process stalled');
    } else if (shouldAutoContinue(result, this._autoContinueCount, ImprovisationSessionManager.MAX_AUTO_CONTINUES, this._cancelled)) {
      this.scheduleAutoContinue();
    }
    void userPrompt;
  }

  private scheduleAutoContinue(reason?: string): void {
    this._autoContinueCount++;
    this._autoContinuePending = true;
    const msg = reason || 'Response appears incomplete';
    this.queueOutput(`\n[[MSTRO_AUTO_CONTINUE]] ${msg} — resuming session (retry ${this._autoContinueCount}/${ImprovisationSessionManager.MAX_AUTO_CONTINUES}).\n`);
    this.flushOutputQueue();

    setImmediate(() => {
      if (this._cancelled || this._isExecuting || !this._autoContinuePending) return;
      this._autoContinuePending = false;
      this.executePrompt('continue', undefined, { isAutoContinue: true }).catch((err) => {
        herror('Auto-continue failed:', err);
      });
    });
  }

  // ========== History I/O ==========

  private persistHistory(): void {
    saveHistory(this.historyPath, this.history);
    if (!this._hasPersistedToDisk) {
      this._hasPersistedToDisk = true;
      this.emit('onHistoryPersisted');
    }
  }

  getHistory(): SessionHistory {
    return this.history;
  }

  // ========== Lifecycle ==========

  cancel(): void {
    this._cancelled = true;

    if (this.currentRunner) {
      this.currentRunner.cleanup();
      this.currentRunner = null;
    }

    this.outputBuffer.destroy();

    if (this._isExecuting && !this._cancelCompleteEmitted) {
      this._cancelCompleteEmitted = true;
      const execStart = this._executionStartTimestamp || Date.now();
      this._isExecuting = false;
      this._executionStartTimestamp = undefined;

      const cancelledMovement = buildCancelledMovement(undefined, {
        sequenceNumber: this._currentSequenceNumber,
        userPrompt: this._currentUserPrompt,
        execStart,
      });
      this.persistMovement(cancelledMovement);
      this.emitMovementComplete(cancelledMovement, CANCELLED_FALLBACK_RESULT, execStart, this._currentSequenceNumber);
    }

    this.flushOutputQueue();
  }

  destroy(): void {
    this.outputBuffer.destroy();
    this.flushOutputQueue();
  }

  clearHistory(): void {
    this.history.movements = [];
    this.history.totalTokens = 0;
    this.accumulatedKnowledge = '';
    this.isFirstPrompt = true;
    this.claudeSessionId = undefined;
    cleanupAttachments(this.options.workingDir, this.sessionId);
    this.persistHistory();
    this.emit('onSessionUpdate', this.getHistory());
  }

  async requestApproval(plan: unknown): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingApproval = { plan, resolve };
      this.emit('onApprovalRequired', plan);
    });
  }

  respondToApproval(approved: boolean): void {
    if (this.pendingApproval) {
      this.pendingApproval.resolve(approved);
      this.pendingApproval = undefined;
    }
  }

  getSessionInfo() {
    return {
      sessionId: this.sessionId,
      startTime: this.history.startedAt,
      workingDir: this.options.workingDir,
      totalTokens: this.history.totalTokens,
      tokenBudgetThreshold: this.options.tokenBudgetThreshold,
      movementCount: this.history.movements.length,
    };
  }

  get isExecuting(): boolean {
    return this._isExecuting;
  }

  get executionStartTimestamp(): number | undefined {
    return this._executionStartTimestamp;
  }

  getExecutionEventLog(): Array<{ type: string; data: unknown; timestamp: number }> {
    return this.executionEventLog;
  }

  startNewSession(overrides?: Partial<ImprovisationOptions>): ImprovisationSessionManager {
    this.persistHistory();
    return new ImprovisationSessionManager({
      ...this.options,
      sessionId: `improv-${Date.now()}`,
      ...overrides,
    });
  }
}
