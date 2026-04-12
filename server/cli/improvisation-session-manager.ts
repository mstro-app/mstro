// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Improvisation Session Manager v2
 *
 * Optimized for fast, direct prompt execution in Improvise mode.
 * For complex multi-part prompts with parallel/sequential movements, use Compose tab instead.
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnalyticsEvents, trackEvent } from '../services/analytics.js';
import { herror } from './headless/headless-logger.js';
import { cleanupAttachments, preparePromptAndAttachments } from './improvisation-attachments.js';
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
  private outputQueue: Array<{ text: string; timestamp: number }> = [];
  private queueTimer: NodeJS.Timeout | null = null;
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
    };

    this.sessionId = this.options.sessionId;
    this.improviseDir = join(this.options.workingDir, '.mstro', 'history');
    this.historyPath = join(this.improviseDir, `${this.sessionId.replace('improv-', '')}.json`);

    if (!existsSync(this.improviseDir)) {
      mkdirSync(this.improviseDir, { recursive: true });
    }

    this.history = this.loadHistory();
    this.saveHistory(); // Persist immediately so the session file exists on disk from creation
    this.startQueueProcessor();
  }

  // ========== Output Queue ==========

  private startQueueProcessor(): void {
    this.queueTimer = setInterval(() => { this.flushOutputQueue(); }, 50);
  }

  private queueOutput(text: string): void {
    this.outputQueue.push({ text, timestamp: Date.now() });
  }

  private flushOutputQueue(): void {
    while (this.outputQueue.length > 0) {
      const item = this.outputQueue.shift();
      if (item) this.emit('onOutput', item.text);
    }
  }

  // ========== Main Execution ==========

  async executePrompt(userPrompt: string, attachments?: FileAttachment[], options?: { workingDir?: string; isAutoContinue?: boolean }): Promise<MovementRecord> {
    const _execStart = Date.now();
    const isAutoContinue = options?.isAutoContinue ?? false;
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
    this._currentUserPrompt = userPrompt;
    this._currentSequenceNumber = sequenceNumber;
    this.emit('onMovementStart', sequenceNumber, userPrompt, isAutoContinue);
    trackEvent(AnalyticsEvents.IMPROVISE_PROMPT_RECEIVED, {
      prompt_length: userPrompt.length,
      has_attachments: !!(attachments && attachments.length > 0),
      attachment_count: attachments?.length || 0,
      image_attachment_count: attachments?.filter(a => a.isImage).length || 0,
      sequence_number: sequenceNumber,
      is_resumed_session: this.isResumedSession,
      model: this.options.model || 'default',
    });

    // Save pending movement immediately so history survives page refresh
    const pendingMovement: MovementRecord = {
      id: `prompt-${sequenceNumber}`,
      sequenceNumber,
      userPrompt,
      timestamp: new Date().toISOString(),
      tokensUsed: 0,
      summary: '',
      filesModified: [],
      durationMs: 0,
      ...(isAutoContinue && { isAutoContinue: true }),
    };
    this.history.movements.push(pendingMovement);
    this.saveHistory();

    try {
      this.executionEventLog.push({
        type: 'movementStart',
        data: { sequenceNumber, prompt: userPrompt, timestamp: Date.now(), executionStartTimestamp: this._executionStartTimestamp },
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

      if (this._cancelled) {
        return this.handleCancelledExecution(result, userPrompt, sequenceNumber, _execStart);
      }

      if (state.contextLost) this.claudeSessionId = undefined;
      result = await selectBestResult(state, result!, userPrompt, this.options.verbose);
      this.captureSessionAndSurfaceErrors(result);
      this.isFirstPrompt = false;

      const movement = this.buildMovementRecord(result, userPrompt, sequenceNumber, _execStart, state.retryLog, isAutoContinue);
      this.handleConflicts(result);
      this.persistMovement(movement);

      this._isExecuting = false;
      this._executionStartTimestamp = undefined;
      this.executionEventLog = [];

      this.emitMovementComplete(movement, result, _execStart, sequenceNumber);

      if (this.shouldAutoContinue(result, userPrompt)) {
        this.scheduleAutoContinue();
      }

      return movement;

    } catch (error: unknown) {
      this._isExecuting = false;
      this._executionStartTimestamp = undefined;
      this.executionEventLog = [];
      this.currentRunner = null;

      // Update the pending movement with error info so it's not lost
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorMovement: MovementRecord = {
        id: `prompt-${sequenceNumber}`,
        sequenceNumber,
        userPrompt,
        timestamp: new Date().toISOString(),
        tokensUsed: 0,
        summary: '',
        filesModified: [],
        errorOutput: errorMessage,
        durationMs: Date.now() - _execStart,
      };
      this.persistMovement(errorMovement);

      this.emit('onMovementError', error);
      trackEvent(AnalyticsEvents.IMPROVISE_MOVEMENT_ERROR, {
        error_message: errorMessage.slice(0, 200),
        sequence_number: sequenceNumber,
        duration_ms: Date.now() - _execStart,
        model: this.options.model || 'default',
      });
      this.queueOutput(`\n❌ Error: ${errorMessage}\n`);
      this.flushOutputQueue();
      throw error;
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

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this._cancelled) break;
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
    if (applyToolTimeoutRetry(state, maxRetries, promptWithAttachments, callbacks, this.options.model)) return true;
    if (await shouldRetryPrematureCompletion(result, state, session, maxRetries, callbacks)) { this.syncSessionStateBack(session); return true; }
    this.syncSessionStateBack(session);
    return false;
  }

  // ========== Cancel Handling ==========

  private handleCancelledExecution(
    result: HeadlessRunResult | undefined,
    userPrompt: string,
    sequenceNumber: number,
    execStart: number,
  ): MovementRecord {
    this._isExecuting = false;
    this._executionStartTimestamp = undefined;
    this.executionEventLog = [];
    this.currentRunner = null;

    if (this._cancelCompleteEmitted) {
      const existing = this.history.movements.find(m => m.sequenceNumber === sequenceNumber);
      if (existing) return existing;
    }

    const cancelledMovement: MovementRecord = {
      id: `prompt-${sequenceNumber}`,
      sequenceNumber,
      userPrompt,
      timestamp: new Date().toISOString(),
      tokensUsed: result ? result.totalTokens : 0,
      summary: '',
      filesModified: [],
      assistantResponse: result?.assistantResponse,
      thinkingOutput: result?.thinkingOutput,
      toolUseHistory: result?.toolUseHistory?.map(t => ({
        toolName: t.toolName, toolId: t.toolId, toolInput: t.toolInput,
        result: t.result,
      })),
      errorOutput: 'Execution cancelled by user',
      durationMs: Date.now() - execStart,
    };
    this.persistMovement(cancelledMovement);
    const fallbackResult = {
      completed: false, needsHandoff: false, totalTokens: 0, sessionId: '',
      output: '', exitCode: 1, signalName: 'SIGTERM',
    } as HeadlessRunResult;
    this.emitMovementComplete(cancelledMovement, result ?? fallbackResult, execStart, sequenceNumber);
    return cancelledMovement;
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

  private buildMovementRecord(
    result: HeadlessRunResult,
    userPrompt: string,
    sequenceNumber: number,
    execStart: number,
    retryLog?: import('./improvisation-types.js').RetryLogEntry[],
    isAutoContinue?: boolean,
  ): MovementRecord {
    return {
      id: `prompt-${sequenceNumber}`,
      sequenceNumber,
      userPrompt,
      timestamp: new Date().toISOString(),
      tokensUsed: result.totalTokens,
      summary: '',
      filesModified: [],
      assistantResponse: result.assistantResponse,
      thinkingOutput: result.thinkingOutput,
      toolUseHistory: result.toolUseHistory?.map(t => ({
        toolName: t.toolName, toolId: t.toolId, toolInput: t.toolInput,
        result: t.result, isError: t.isError, duration: t.duration,
      })),
      errorOutput: result.error,
      durationMs: Date.now() - execStart,
      retryLog: retryLog && retryLog.length > 0 ? retryLog : undefined,
      ...(isAutoContinue && { isAutoContinue: true }),
    };
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
    this.saveHistory();
  }

  private emitMovementComplete(movement: MovementRecord, result: HeadlessRunResult, execStart: number, sequenceNumber: number): void {
    this.emit('onMovementComplete', movement);
    trackEvent(AnalyticsEvents.IMPROVISE_MOVEMENT_COMPLETED, {
      tokens_used: movement.tokensUsed,
      duration_ms: Date.now() - execStart,
      sequence_number: sequenceNumber,
      tool_count: result.toolUseHistory?.length || 0,
      model: this.options.model || 'default',
    });
    this.emit('onSessionUpdate', this.getHistory());
  }

  // ========== Auto-Continue ==========

  private _autoContinueCount = 0;
  private _autoContinuePending = false;
  private static readonly MAX_AUTO_CONTINUES = 1;

  private shouldAutoContinue(result: HeadlessRunResult, _userPrompt: string): boolean {
    if (this._autoContinueCount >= ImprovisationSessionManager.MAX_AUTO_CONTINUES) return false;
    if (this._cancelled) return false;
    if (!result.completed || result.signalName) return false;
    if (result.stopReason !== 'end_turn') return false;

    const thinkingLen = result.thinkingOutput?.length ?? 0;
    const responseLen = result.assistantResponse?.length ?? 0;
    const successfulToolCalls = result.toolUseHistory?.filter(t => t.result !== undefined && !t.isError).length ?? 0;

    if (thinkingLen < 500 || responseLen > 1000) return false;
    // When the agent executed tool calls and produced a non-trivial response,
    // long thinking is expected — the work happened in the tools, not the text.
    if (successfulToolCalls > 0 && responseLen > 200) return false;
    return thinkingLen >= responseLen * 3;
  }

  private scheduleAutoContinue(): void {
    this._autoContinueCount++;
    this._autoContinuePending = true;
    this.queueOutput('\n⟳ Response appears incomplete — auto-continuing…\n');
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

  private loadHistory(): SessionHistory {
    if (existsSync(this.historyPath)) {
      try {
        const data = readFileSync(this.historyPath, 'utf-8');
        return JSON.parse(data);
      } catch (error) {
        herror('Failed to load history:', error);
      }
    }
    return {
      sessionId: this.sessionId,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      totalTokens: 0,
      movements: [],
    };
  }

  private saveHistory(): void {
    this.history.lastActivityAt = new Date().toISOString();
    writeFileSync(this.historyPath, JSON.stringify(this.history, null, 2));
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

    if (this._isExecuting && !this._cancelCompleteEmitted) {
      this._cancelCompleteEmitted = true;
      const execStart = this._executionStartTimestamp || Date.now();
      this._isExecuting = false;
      this._executionStartTimestamp = undefined;

      const cancelledMovement: MovementRecord = {
        id: `prompt-${this._currentSequenceNumber}`,
        sequenceNumber: this._currentSequenceNumber,
        userPrompt: this._currentUserPrompt,
        timestamp: new Date().toISOString(),
        tokensUsed: 0,
        summary: '',
        filesModified: [],
        errorOutput: 'Execution cancelled by user',
        durationMs: Date.now() - execStart,
      };
      this.persistMovement(cancelledMovement);

      const fallbackResult = {
        completed: false, needsHandoff: false, totalTokens: 0, sessionId: '',
        output: '', exitCode: 1, signalName: 'SIGTERM',
      } as HeadlessRunResult;
      this.emitMovementComplete(cancelledMovement, fallbackResult, execStart, this._currentSequenceNumber);
    }

    this.flushOutputQueue();
  }

  destroy(): void {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
    this.flushOutputQueue();
  }

  clearHistory(): void {
    this.history.movements = [];
    this.history.totalTokens = 0;
    this.accumulatedKnowledge = '';
    this.isFirstPrompt = true;
    this.claudeSessionId = undefined;
    cleanupAttachments(this.options.workingDir, this.sessionId);
    this.saveHistory();
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
    this.saveHistory();
    return new ImprovisationSessionManager({
      ...this.options,
      sessionId: `improv-${Date.now()}`,
      ...overrides,
    });
  }
}
