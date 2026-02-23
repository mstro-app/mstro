// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Improvisation Session Manager v2
 *
 * Optimized for fast, direct prompt execution in Improvise mode.
 * For complex multi-part prompts with parallel/sequential movements, use Compose tab instead.
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnalyticsEvents, trackEvent } from '../services/analytics.js';
import { HeadlessRunner } from './headless/index.js';
import { assessBestResult, assessContextLoss, type ContextLossContext } from './headless/stall-assessor.js';
import type { ExecutionCheckpoint } from './headless/types.js';

export interface ImprovisationOptions {
  workingDir: string;
  sessionId: string;
  tokenBudgetThreshold: number;
  maxSessions: number;
  verbose: boolean;
  noColor: boolean;
  /** Claude model for main execution (e.g., 'opus', 'sonnet'). 'default' = no --model flag. */
  model?: string;
}

// File attachment for multimodal prompts (images)
export interface FileAttachment {
  fileName: string;       // Display name (e.g., "screenshot.png")
  filePath: string;       // Full path on disk (for context)
  content: string;        // Base64 for images
  isImage: boolean;       // True for image files
  mimeType?: string;      // MIME type for images (e.g., "image/png")
}

export interface ToolUseRecord {
  toolName: string;
  toolId: string;
  toolInput: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  duration?: number;
}

export interface MovementRecord {
  id: string;
  sequenceNumber: number;
  userPrompt: string;
  timestamp: string;
  tokensUsed: number;
  summary: string;
  filesModified: string[];
  // NEW: Persisted output fields
  assistantResponse?: string;      // Claude's text output
  thinkingOutput?: string;         // Extended thinking
  toolUseHistory?: ToolUseRecord[];// Tool invocations + results
  errorOutput?: string;            // Any errors
  durationMs?: number;             // Execution duration in milliseconds
}

export interface SessionHistory {
  sessionId: string;
  startedAt: string;
  lastActivityAt: string;
  totalTokens: number;
  movements: MovementRecord[];
  claudeSessionId?: string;
}


/** Mutable state for the retry loop in executePrompt */
interface RetryLoopState {
  currentPrompt: string;
  retryNumber: number;
  checkpointRef: { value: ExecutionCheckpoint | null };
  contextRecoverySessionId: string | undefined;
  freshRecoveryMode: boolean;
  accumulatedToolResults: ToolUseRecord[];
  contextLost: boolean;
  lastWatchdogCheckpoint: ExecutionCheckpoint | null;
  timedOutTools: Array<{ toolName: string; input: Record<string, unknown>; timeoutMs: number }>;
  bestResult: HeadlessRunResult | null;
}

/** Type alias for HeadlessRunner execution result */
type HeadlessRunResult = Awaited<ReturnType<HeadlessRunner['run']>>;

/** Score a run result for best-result tracking (higher = more productive) */
function scoreRunResult(r: HeadlessRunResult): number {
  const toolCount = r.toolUseHistory?.filter(t => t.result !== undefined && !t.isError).length ?? 0;
  const responseLen = Math.min((r.assistantResponse?.length ?? 0) / 50, 100);
  const hasThinking = r.thinkingOutput ? 20 : 0;
  return toolCount * 10 + responseLen + hasThinking;
}
export class ImprovisationSessionManager extends EventEmitter {
  private sessionId: string;
  private improviseDir: string;
  private historyPath: string;
  private history: SessionHistory;
  private currentRunner: HeadlessRunner | null = null;
  private options: ImprovisationOptions;
  private pendingApproval?: {
    plan: any;
    resolve: (approved: boolean) => void;
  };
  private outputQueue: Array<{ text: string; timestamp: number }> = [];
  private queueTimer: NodeJS.Timeout | null = null;
  private isFirstPrompt: boolean = true; // Track if this is the first prompt (no --resume needed)
  private claudeSessionId: string | undefined; // Claude CLI session ID for tab isolation
  private isResumedSession: boolean = false; // Track if this is a resumed historical session
  accumulatedKnowledge: string = '';

  /** Whether a prompt is currently executing */
  private _isExecuting: boolean = false;
  /** Timestamp when current execution started (for accurate elapsed time across reconnects) */
  private _executionStartTimestamp: number | undefined;
  /** Buffered events during current execution, for replay on reconnect */
  private executionEventLog: Array<{ type: string; data: any; timestamp: number }> = [];

  /**
   * Resume from a historical session.
   * Creates a new session manager that continues the conversation from a previous session.
   * The first prompt will include context from the historical session.
   */
  static resumeFromHistory(workingDir: string, historicalSessionId: string, overrides?: Partial<ImprovisationOptions>): ImprovisationSessionManager {
    const historyDir = join(workingDir, '.mstro', 'history');

    // Extract timestamp from session ID (format: improv-1234567890123 or just 1234567890123)
    const timestamp = historicalSessionId.replace('improv-', '');
    const historyPath = join(historyDir, `${timestamp}.json`);

    if (!existsSync(historyPath)) {
      throw new Error(`Historical session not found: ${historicalSessionId}`);
    }

    // Read the historical session
    const historyData = JSON.parse(readFileSync(historyPath, 'utf-8')) as SessionHistory;

    // Create a new session manager with the SAME session ID
    // This ensures we continue writing to the same history file
    const manager = new ImprovisationSessionManager({
      workingDir,
      sessionId: historyData.sessionId,
      ...overrides,
    });

    // Load the historical data
    manager.history = historyData;

    // Build accumulated knowledge from historical movements
    manager.accumulatedKnowledge = historyData.movements
      .filter(m => m.summary)
      .map(m => m.summary)
      .join('\n\n');

    // Restore Claude session ID if available so we can --resume the actual conversation
    // NOTE: Always mark as resumed session so historical context can be injected as fallback
    // if the Claude CLI session has expired (e.g., client was restarted)
    manager.isResumedSession = true;
    manager.isFirstPrompt = true; // Always true so historical context is injected on first prompt
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

    // Ensure history directory exists
    if (!existsSync(this.improviseDir)) {
      mkdirSync(this.improviseDir, { recursive: true });
    }

    // Load or initialize history
    this.history = this.loadHistory();

    // Start output queue processor
    this.startQueueProcessor();
  }

  /**
   * Start background queue processor that flushes output immediately
   */
  private startQueueProcessor(): void {
    this.queueTimer = setInterval(() => {
      this.flushOutputQueue();
    }, 10); // Process queue every 10ms for near-instant output
  }

  /**
   * Queue output for immediate processing
   */
  private queueOutput(text: string): void {
    this.outputQueue.push({ text, timestamp: Date.now() });
  }

  /**
   * Flush all queued output immediately
   */
  private flushOutputQueue(): void {
    while (this.outputQueue.length > 0) {
      const item = this.outputQueue.shift();
      if (item) {
        this.emit('onOutput', item.text);
      }
    }
  }

  /**
   * Build prompt with text file attachments prepended and disk path references
   * Format: each text file is shown as @path followed by content in code block
   */
  private buildPromptWithAttachments(userPrompt: string, attachments?: FileAttachment[], diskPaths?: string[]): string {
    if ((!attachments || attachments.length === 0) && (!diskPaths || diskPaths.length === 0)) {
      return userPrompt;
    }

    const parts: string[] = [];

    // Filter to text files only (non-images)
    if (attachments) {
      const textFiles = attachments.filter(a => !a.isImage);
      for (const file of textFiles) {
        parts.push(`@${file.filePath}\n\`\`\`\n${file.content}\n\`\`\``);
      }
    }

    // Add disk path references for all persisted files
    if (diskPaths && diskPaths.length > 0) {
      parts.push(`Attached files saved to disk:\n${diskPaths.map(p => `- ${p}`).join('\n')}`);
    }

    if (parts.length === 0) {
      return userPrompt;
    }

    return `${parts.join('\n\n')}\n\n${userPrompt}`;
  }

  /**
   * Write attachments to disk at .mstro/tmp/attachments/{sessionId}/
   * Returns array of absolute file paths for each persisted attachment.
   */
  private persistAttachments(attachments: FileAttachment[]): string[] {
    if (attachments.length === 0) return [];

    const attachDir = join(this.options.workingDir, '.mstro', 'tmp', 'attachments', this.sessionId);
    if (!existsSync(attachDir)) {
      mkdirSync(attachDir, { recursive: true });
    }

    const paths: string[] = [];
    for (const attachment of attachments) {
      const filePath = join(attachDir, attachment.fileName);
      try {
        // All paste content arrives as base64 — decode to binary
        writeFileSync(filePath, Buffer.from(attachment.content, 'base64'));
        paths.push(filePath);
      } catch (err) {
        console.error(`Failed to persist attachment ${attachment.fileName}:`, err);
      }
    }

    return paths;
  }

  /**
   * Clean up persisted attachments for this session
   */
  private cleanupAttachments(): void {
    const attachDir = join(this.options.workingDir, '.mstro', 'tmp', 'attachments', this.sessionId);
    if (existsSync(attachDir)) {
      try {
        rmSync(attachDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }


  /**
   * Execute a user prompt directly (Improvise mode - no score decomposition)
   * Uses persistent Claude sessions via --resume <sessionId> for conversation continuity
   * Each tab maintains its own claudeSessionId for proper isolation
   * Supports file attachments: text files prepended to prompt, images via stream-json multimodal
   */
  async executePrompt(userPrompt: string, attachments?: FileAttachment[], options?: { sandboxed?: boolean }): Promise<MovementRecord> {
    const _execStart = Date.now();
    this._isExecuting = true;
    this._executionStartTimestamp = _execStart;
    this.executionEventLog = [];

    const sequenceNumber = this.history.movements.length + 1;
    this.emit('onMovementStart', sequenceNumber, userPrompt);
    trackEvent(AnalyticsEvents.IMPROVISE_PROMPT_RECEIVED, {
      prompt_length: userPrompt.length,
      has_attachments: !!(attachments && attachments.length > 0),
      attachment_count: attachments?.length || 0,
      image_attachment_count: attachments?.filter(a => a.isImage).length || 0,
      sequence_number: sequenceNumber,
      is_resumed_session: this.isResumedSession,
      model: this.options.model || 'default',
    });

    try {
      this.executionEventLog.push({
        type: 'movementStart',
        data: { sequenceNumber, prompt: userPrompt, timestamp: Date.now(), executionStartTimestamp: this._executionStartTimestamp },
        timestamp: Date.now(),
      });

      const { prompt: promptWithAttachments, imageAttachments } = this.preparePromptAndAttachments(userPrompt, attachments);
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
      };

      const maxRetries = 3;
      let result: HeadlessRunResult;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        this.resetIterationState(state);

        const { useResume, resumeSessionId } = this.determineResumeStrategy(state);
        const runner = this.createExecutionRunner(state, sequenceNumber, useResume, resumeSessionId, imageAttachments, options?.sandboxed);
        this.currentRunner = runner;
        result = await runner.run();
        this.currentRunner = null;

        this.updateBestResult(state, result);
        const nativeTimeouts = result.nativeTimeoutCount ?? 0;
        this.detectResumeContextLoss(result, state, useResume, maxRetries, nativeTimeouts);
        await this.detectNativeTimeoutContextLoss(result, state, maxRetries, nativeTimeouts);
        this.flushPostTimeoutOutput(result, state);

        if (this.shouldRetryContextLoss(result, state, useResume, nativeTimeouts, maxRetries, promptWithAttachments)) continue;
        if (this.applyToolTimeoutRetry(state, maxRetries, promptWithAttachments)) continue;
        break;
      }

      if (state.contextLost) this.claudeSessionId = undefined;
      result = await this.selectBestResult(state, result, userPrompt);
      this.captureSessionAndSurfaceErrors(result);
      this.isFirstPrompt = false;

      const movement = this.buildMovementRecord(result, userPrompt, sequenceNumber, _execStart);
      this.handleConflicts(result);
      this.persistMovement(movement);

      this._isExecuting = false;
      this._executionStartTimestamp = undefined;
      this.executionEventLog = [];

      this.emitMovementComplete(movement, result, _execStart, sequenceNumber);
      return movement;

    } catch (error: any) {
      this._isExecuting = false;
      this._executionStartTimestamp = undefined;
      this.executionEventLog = [];
      this.currentRunner = null;
      this.emit('onMovementError', error);
      trackEvent(AnalyticsEvents.IMPROVISE_MOVEMENT_ERROR, {
        error_message: error.message?.slice(0, 200),
        sequence_number: this.history.movements.length + 1,
        duration_ms: Date.now() - _execStart,
        model: this.options.model || 'default',
      });
      this.queueOutput(`\n❌ Error: ${error.message}\n`);
      this.flushOutputQueue();
      throw error;
    } finally {
      this.flushOutputQueue();
    }
  }

  // ========== Extracted helpers for executePrompt ==========

  /** Prepare prompt with attachments and limit image count */
  private preparePromptAndAttachments(
    userPrompt: string,
    attachments: FileAttachment[] | undefined,
  ): { prompt: string; imageAttachments: FileAttachment[] | undefined } {
    const diskPaths = attachments ? this.persistAttachments(attachments) : [];
    const prompt = this.buildPromptWithAttachments(userPrompt, attachments, diskPaths);

    const MAX_IMAGE_ATTACHMENTS = 20;
    const allImages = attachments?.filter(a => a.isImage);
    let imageAttachments = allImages;
    if (allImages && allImages.length > MAX_IMAGE_ATTACHMENTS) {
      imageAttachments = allImages.slice(-MAX_IMAGE_ATTACHMENTS);
      this.queueOutput(
        `\n[[MSTRO_ERROR:TOO_MANY_IMAGES]] ${allImages.length} images attached, limit is ${MAX_IMAGE_ATTACHMENTS}. Using the ${MAX_IMAGE_ATTACHMENTS} most recent.\n`
      );
      this.flushOutputQueue();
    }

    return { prompt, imageAttachments };
  }

  /** Determine whether to use --resume and which session ID */
  private determineResumeStrategy(state: RetryLoopState): { useResume: boolean; resumeSessionId: string | undefined } {
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
      return { useResume: !this.isFirstPrompt, resumeSessionId: this.claudeSessionId };
    }
    if (state.lastWatchdogCheckpoint?.inProgressTools.length === 0 && state.lastWatchdogCheckpoint.claudeSessionId) {
      return { useResume: true, resumeSessionId: state.lastWatchdogCheckpoint.claudeSessionId };
    }
    return { useResume: false, resumeSessionId: undefined };
  }

  /** Create HeadlessRunner for one retry iteration */
  private createExecutionRunner(
    state: RetryLoopState,
    sequenceNumber: number,
    useResume: boolean,
    resumeSessionId: string | undefined,
    imageAttachments: FileAttachment[] | undefined,
    sandboxed: boolean | undefined,
  ): HeadlessRunner {
    return new HeadlessRunner({
      workingDir: this.options.workingDir,
      tokenBudgetThreshold: this.options.tokenBudgetThreshold,
      maxSessions: this.options.maxSessions,
      verbose: this.options.verbose,
      noColor: this.options.noColor,
      model: this.options.model,
      improvisationMode: true,
      movementNumber: sequenceNumber,
      continueSession: useResume,
      claudeSessionId: resumeSessionId,
      outputCallback: (text: string) => {
        this.executionEventLog.push({ type: 'output', data: { text, timestamp: Date.now() }, timestamp: Date.now() });
        this.queueOutput(text);
        this.flushOutputQueue();
      },
      thinkingCallback: (text: string) => {
        this.executionEventLog.push({ type: 'thinking', data: { text }, timestamp: Date.now() });
        this.emit('onThinking', text);
        this.flushOutputQueue();
      },
      toolUseCallback: (event) => {
        this.executionEventLog.push({ type: 'toolUse', data: { ...event, timestamp: Date.now() }, timestamp: Date.now() });
        this.emit('onToolUse', event);
        this.flushOutputQueue();
      },
      directPrompt: state.currentPrompt,
      imageAttachments,
      promptContext: (state.retryNumber === 0 && this.isResumedSession && this.isFirstPrompt)
        ? { accumulatedKnowledge: this.buildHistoricalContext(), filesModified: [] }
        : undefined,
      onToolTimeout: (checkpoint: ExecutionCheckpoint) => {
        state.checkpointRef.value = checkpoint;
      },
      sandboxed,
    });
  }

  /** Save checkpoint and reset per-iteration state before each retry loop pass. */
  private resetIterationState(state: RetryLoopState): void {
    if (state.checkpointRef.value) state.lastWatchdogCheckpoint = state.checkpointRef.value;
    state.checkpointRef.value = null;
    state.contextLost = false;
  }

  /** Update best result tracking */
  private updateBestResult(state: RetryLoopState, result: HeadlessRunResult): void {
    if (!state.bestResult || scoreRunResult(result) > scoreRunResult(state.bestResult)) {
      state.bestResult = result;
    }
  }

  /** Detect resume context loss (Path 1): session expired on --resume */
  private detectResumeContextLoss(
    result: HeadlessRunResult,
    state: RetryLoopState,
    useResume: boolean,
    maxRetries: number,
    nativeTimeouts: number,
  ): void {
    if (!useResume || state.checkpointRef.value || state.retryNumber >= maxRetries || nativeTimeouts > 0) {
      return;
    }
    if (!result.assistantResponse || result.assistantResponse.trim().length === 0) {
      state.contextLost = true;
      if (this.options.verbose) console.log('[CONTEXT-RECOVERY] Resume context loss: null/empty response');
    } else if (result.resumeBufferedOutput !== undefined) {
      state.contextLost = true;
      if (this.options.verbose) console.log('[CONTEXT-RECOVERY] Resume context loss: buffer never flushed (no thinking/tools)');
    } else if (
      (!result.toolUseHistory || result.toolUseHistory.length === 0) &&
      !result.thinkingOutput &&
      result.assistantResponse.length < 500
    ) {
      state.contextLost = true;
      if (this.options.verbose) console.log('[CONTEXT-RECOVERY] Resume context loss: no tools, no thinking, short response');
    }
  }

  /** Detect native timeout context loss (Path 2): tool timeouts caused confusion */
  private async detectNativeTimeoutContextLoss(
    result: HeadlessRunResult,
    state: RetryLoopState,
    maxRetries: number,
    nativeTimeouts: number,
  ): Promise<void> {
    if (state.contextLost) return;

    const toolsWithoutResult = result.toolUseHistory?.filter(t => t.result === undefined).length ?? 0;
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
    const verdict = await assessContextLoss(contextLossCtx, claudeCmd, this.options.verbose);
    state.contextLost = verdict.contextLost;
    if (this.options.verbose) {
      console.log(`[CONTEXT-RECOVERY] Haiku verdict: ${state.contextLost ? 'LOST' : 'OK'} — ${verdict.reason}`);
    }
  }

  /** Flush post-timeout output if context wasn't lost */
  private flushPostTimeoutOutput(result: HeadlessRunResult, state: RetryLoopState): void {
    if (!state.contextLost && result.postTimeoutOutput) {
      this.queueOutput(result.postTimeoutOutput);
      this.flushOutputQueue();
    }
  }

  /** Check if context loss recovery should trigger a retry. Returns true if loop should continue. */
  private shouldRetryContextLoss(
    result: HeadlessRunResult,
    state: RetryLoopState,
    useResume: boolean,
    nativeTimeouts: number,
    maxRetries: number,
    promptWithAttachments: string,
  ): boolean {
    if (state.checkpointRef.value || state.retryNumber >= maxRetries || !state.contextLost) {
      return false;
    }
    this.accumulateToolResults(result, state);
    state.retryNumber++;
    if (useResume && nativeTimeouts === 0) {
      this.applyInterMovementRecovery(state, promptWithAttachments);
    } else {
      this.applyNativeTimeoutRecovery(result, state, promptWithAttachments);
    }
    return true;
  }

  /** Accumulate completed tool results from a run into the retry state */
  private accumulateToolResults(result: HeadlessRunResult, state: RetryLoopState): void {
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
  }

  /** Handle inter-movement context loss recovery (resume session expired) */
  private applyInterMovementRecovery(state: RetryLoopState, promptWithAttachments: string): void {
    this.claudeSessionId = undefined;
    const historicalResults = this.extractHistoricalToolResults();
    const allResults = [...historicalResults, ...state.accumulatedToolResults];

    this.emit('onAutoRetry', {
      retryNumber: state.retryNumber,
      maxRetries: 3,
      toolName: 'InterMovementRecovery',
      completedCount: allResults.length,
    });
    this.queueOutput(
      `\n[[MSTRO_CONTEXT_RECOVERY]] Session context expired — continuing with ${allResults.length} preserved results from prior work (retry ${state.retryNumber}/3).\n`
    );
    this.flushOutputQueue();

    state.freshRecoveryMode = true;
    state.currentPrompt = this.buildInterMovementRecoveryPrompt(promptWithAttachments, allResults);
  }

  /** Handle native-timeout context loss recovery (tool timeouts caused confusion) */
  private applyNativeTimeoutRecovery(
    result: HeadlessRunResult,
    state: RetryLoopState,
    promptWithAttachments: string,
  ): void {
    const completedCount = state.accumulatedToolResults.length;

    this.emit('onAutoRetry', {
      retryNumber: state.retryNumber,
      maxRetries: 3,
      toolName: 'ContextRecovery',
      completedCount,
    });

    if (result.claudeSessionId && state.retryNumber === 1) {
      this.queueOutput(
        `\n[[MSTRO_CONTEXT_RECOVERY]] Context loss detected — resuming session with ${completedCount} preserved results (retry ${state.retryNumber}/3).\n`
      );
      this.flushOutputQueue();
      state.contextRecoverySessionId = result.claudeSessionId;
      this.claudeSessionId = result.claudeSessionId;
      state.currentPrompt = this.buildContextRecoveryPrompt(promptWithAttachments);
    } else {
      this.queueOutput(
        `\n[[MSTRO_CONTEXT_RECOVERY]] Continuing with fresh context — ${completedCount} preserved results injected (retry ${state.retryNumber}/3).\n`
      );
      this.flushOutputQueue();
      state.freshRecoveryMode = true;
      state.currentPrompt = this.buildFreshRecoveryPrompt(promptWithAttachments, state.accumulatedToolResults);
    }
  }

  /** Handle tool timeout checkpoint. Returns true if loop should continue. */
  private applyToolTimeoutRetry(
    state: RetryLoopState,
    maxRetries: number,
    promptWithAttachments: string,
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
    this.emit('onAutoRetry', {
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
    });

    state.currentPrompt = canResumeSession
      ? this.buildResumeRetryPrompt(cp, state.timedOutTools)
      : this.buildRetryPrompt(cp, promptWithAttachments, state.timedOutTools);

    this.queueOutput(
      `\n[[MSTRO_AUTO_RETRY]] Auto-retry ${state.retryNumber}/${maxRetries}: ${canResumeSession ? 'Resuming session' : 'Continuing'} with ${cp.completedTools.length} successful results, skipping failed ${cp.hungTool.toolName}.\n`
    );
    this.flushOutputQueue();

    return true;
  }

  /** Select the best result across retries using Haiku assessment */
  private async selectBestResult(
    state: RetryLoopState,
    result: HeadlessRunResult,
    userPrompt: string,
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
      }, claudeCmd, this.options.verbose);

      if (verdict.winner === 'A') {
        if (this.options.verbose) console.log(`[BEST-RESULT] Haiku picked earlier attempt: ${verdict.reason}`);
        return this.mergeResultSessionId(state.bestResult, result.claudeSessionId);
      }
      if (this.options.verbose) console.log(`[BEST-RESULT] Haiku picked final attempt: ${verdict.reason}`);
      return result;
    } catch {
      return this.fallbackBestResult(state.bestResult, result);
    }
  }

  /** Fallback best result selection using numeric scoring */
  private fallbackBestResult(bestResult: HeadlessRunResult, result: HeadlessRunResult): HeadlessRunResult {
    if (scoreRunResult(bestResult) > scoreRunResult(result)) {
      if (this.options.verbose) {
        console.log(`[BEST-RESULT] Haiku unavailable, numeric fallback: earlier attempt (score ${scoreRunResult(bestResult)} vs ${scoreRunResult(result)})`);
      }
      return this.mergeResultSessionId(bestResult, result.claudeSessionId);
    }
    return result;
  }

  /** Replace a result's claudeSessionId with a newer one */
  private mergeResultSessionId(result: HeadlessRunResult, sessionId: string | undefined): HeadlessRunResult {
    if (sessionId) return { ...result, claudeSessionId: sessionId };
    return result;
  }

  /** Capture Claude session ID and surface execution failures */
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

  /** Build a MovementRecord from execution result */
  private buildMovementRecord(
    result: HeadlessRunResult,
    userPrompt: string,
    sequenceNumber: number,
    execStart: number,
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
        toolName: t.toolName,
        toolId: t.toolId,
        toolInput: t.toolInput,
        result: t.result,
        isError: t.isError,
        duration: t.duration
      })),
      errorOutput: result.error,
      durationMs: Date.now() - execStart,
    };
  }

  /** Handle file conflicts from execution result */
  private handleConflicts(result: HeadlessRunResult): void {
    if (!result.conflicts || result.conflicts.length === 0) return;
    this.queueOutput(`\n⚠ File conflicts detected: ${result.conflicts.length}`);
    result.conflicts.forEach(c => {
      this.queueOutput(`  - ${c.filePath} (modified by: ${c.modifiedBy.join(', ')})`);
      if (c.backupPath) {
        this.queueOutput(`    Backup created: ${c.backupPath}`);
      }
    });
    this.flushOutputQueue();
  }

  /** Persist movement to history */
  private persistMovement(movement: MovementRecord): void {
    this.history.movements.push(movement);
    this.history.totalTokens += movement.tokensUsed;
    this.saveHistory();
  }

  /** Emit movement completion events and analytics */
  private emitMovementComplete(
    movement: MovementRecord,
    result: HeadlessRunResult,
    execStart: number,
    sequenceNumber: number,
  ): void {
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

  /**
   * Build historical context for resuming a session.
   * This creates a summary of the previous conversation that will be injected
   * into the first prompt of a resumed session.
   */
  private buildHistoricalContext(): string {
    if (this.history.movements.length === 0) {
      return '';
    }

    const contextParts: string[] = [
      '--- CONVERSATION HISTORY (for context, do not repeat these responses) ---',
      ''
    ];

    // Include each movement as context
    for (const movement of this.history.movements) {
      contextParts.push(`[User Prompt ${movement.sequenceNumber}]:`);
      contextParts.push(movement.userPrompt);
      contextParts.push('');

      if (movement.assistantResponse) {
        contextParts.push(`[Your Response ${movement.sequenceNumber}]:`);
        // Truncate very long responses to save tokens
        const response = movement.assistantResponse.length > 2000
          ? `${movement.assistantResponse.slice(0, 2000)}\n... (response truncated for context)`
          : movement.assistantResponse;
        contextParts.push(response);
        contextParts.push('');
      }

      if (movement.toolUseHistory && movement.toolUseHistory.length > 0) {
        contextParts.push(`[Tools Used in Prompt ${movement.sequenceNumber}]:`);
        for (const tool of movement.toolUseHistory) {
          contextParts.push(`- ${tool.toolName}`);
        }
        contextParts.push('');
      }
    }

    contextParts.push('--- END OF CONVERSATION HISTORY ---');
    contextParts.push('');
    contextParts.push('Continue the conversation from where we left off. The user is now asking:');
    contextParts.push('');

    return contextParts.join('\n');
  }

  /**
   * Build a retry prompt from a tool timeout checkpoint.
   * Injects completed tool results and instructs Claude to skip the failed resource.
   */
  private buildRetryPrompt(
    checkpoint: ExecutionCheckpoint,
    originalPrompt: string,
    allTimedOut?: Array<{ toolName: string; input: Record<string, unknown>; timeoutMs: number }>,
  ): string {
    const urlSuffix = checkpoint.hungTool.url ? ` while fetching: ${checkpoint.hungTool.url}` : '';
    const parts: string[] = [
      '## AUTOMATIC RETRY -- Previous Execution Interrupted',
      '',
      `The previous execution was interrupted because ${checkpoint.hungTool.toolName} timed out after ${Math.round(checkpoint.hungTool.timeoutMs / 1000)}s${urlSuffix}.`,
      '',
    ];

    if (allTimedOut && allTimedOut.length > 0) {
      parts.push(...this.formatTimedOutTools(allTimedOut), '');
    } else {
      parts.push('This URL/resource is unreachable. DO NOT retry the same URL or query.', '');
    }

    if (checkpoint.completedTools.length > 0) {
      parts.push(...this.formatCompletedTools(checkpoint.completedTools), '');
    }

    if (checkpoint.inProgressTools && checkpoint.inProgressTools.length > 0) {
      parts.push(...this.formatInProgressTools(checkpoint.inProgressTools), '');
    }

    if (checkpoint.assistantText) {
      const preview = checkpoint.assistantText.length > 8000
        ? `${checkpoint.assistantText.slice(0, 8000)}...\n(truncated — full response was ${checkpoint.assistantText.length} chars)`
        : checkpoint.assistantText;
      parts.push('### Your response before interruption:', preview, '');
    }

    parts.push('### Original task (continue from where you left off):');
    parts.push(originalPrompt);
    parts.push('');
    parts.push('INSTRUCTIONS:');
    parts.push('1. Use the results above -- do not re-fetch content you already have');
    parts.push('2. Find ALTERNATIVE sources for the content that timed out (different URL, different approach)');
    parts.push('3. Re-run any in-progress tools that were lost (listed above) if their results are needed');
    parts.push('4. If no alternative exists, proceed with the results you have and note what was unavailable');

    return parts.join('\n');
  }

  /**
   * Build a short retry prompt for --resume sessions.
   * The session already has full conversation context, so we only need to
   * explain what timed out and instruct Claude to continue.
   */
  private buildResumeRetryPrompt(
    checkpoint: ExecutionCheckpoint,
    allTimedOut?: Array<{ toolName: string; input: Record<string, unknown>; timeoutMs: number }>,
  ): string {
    const parts: string[] = [];

    parts.push(
      `Your previous ${checkpoint.hungTool.toolName} call timed out after ${Math.round(checkpoint.hungTool.timeoutMs / 1000)}s${checkpoint.hungTool.url ? ` fetching: ${checkpoint.hungTool.url}` : ''}.`
    );

    // List all timed-out tools across retries so Claude avoids repeating them
    if (allTimedOut && allTimedOut.length > 1) {
      parts.push('');
      parts.push('All timed-out tools/resources (DO NOT retry any of these):');
      for (const t of allTimedOut) {
        const inputSummary = this.summarizeToolInput(t.input);
        parts.push(`- ${t.toolName}(${inputSummary})`);
      }
    } else {
      parts.push('This URL/resource is unreachable. DO NOT retry the same URL or query.');
    }
    parts.push('Continue your task — find an alternative source or proceed with the results you already have.');

    return parts.join('\n');
  }

  // Context loss detection is now handled by assessContextLoss() in stall-assessor.ts
  // using Haiku assessment instead of brittle regex patterns.

  /**
   * Build a recovery prompt for --resume after context loss.
   * Since we're resuming the same session, Claude has full conversation history
   * (including all preserved tool results). We just need to redirect it back to the task.
   */
  private buildContextRecoveryPrompt(originalPrompt: string): string {
    const parts: string[] = [];

    parts.push('Your previous response indicated you lost context due to tool timeouts, but your full conversation history is preserved — including all successful tool results.');
    parts.push('');
    parts.push('Review your conversation history above. You already have results from many successful tool calls. Use those results to continue the task.');
    parts.push('');
    parts.push('Original task:');
    parts.push(originalPrompt);
    parts.push('');
    parts.push('INSTRUCTIONS:');
    parts.push('1. Review your conversation history — all your previous tool results are still available');
    parts.push('2. Continue from where you left off using the results you already gathered');
    parts.push('3. If specific tool calls timed out, skip those and work with what you have');
    parts.push('4. Do NOT start over — build on the work already done');
    parts.push('5. Do NOT spawn Task subagents for work that previously timed out — do it inline instead');
    parts.push('6. Prefer multiple small, focused tool calls over single large ones to avoid further timeouts');

    return parts.join('\n');
  }

  /**
   * Build a recovery prompt for a fresh session (no --resume) after repeated context loss.
   * Injects all accumulated tool results from previous attempts so Claude can continue
   * the task without re-fetching data it already gathered.
   */
  private buildFreshRecoveryPrompt(originalPrompt: string, toolResults: ToolUseRecord[]): string {
    const parts: string[] = [
      '## CONTINUING LONG-RUNNING TASK',
      '',
      'The previous execution encountered tool timeouts and lost context.',
      'Below are all results gathered before the interruption. Continue the task using these results.',
      '',
    ];

    parts.push(...this.formatToolResults(toolResults));

    parts.push('### Original task:');
    parts.push(originalPrompt);
    parts.push('');
    parts.push('INSTRUCTIONS:');
    parts.push('1. Use the preserved results above \u2014 do NOT re-fetch data you already have');
    parts.push('2. Continue the task from where it was interrupted');
    parts.push('3. If you need additional data, fetch it (but try alternative sources if the original timed out)');
    parts.push('4. Complete the original task fully');
    parts.push('5. Do NOT spawn Task subagents for work that previously timed out \u2014 do it inline instead');
    parts.push('6. Prefer multiple small, focused tool calls over single large ones to avoid further timeouts');

    return parts.join('\n');
  }

  /**
   * Extract tool results from the last N movements in history.
   * Used for inter-movement recovery to provide context from prior work
   * when a resume session is corrupted/expired.
   */
  private extractHistoricalToolResults(maxMovements = 3): ToolUseRecord[] {
    const results: ToolUseRecord[] = [];
    const recentMovements = this.history.movements.slice(-maxMovements);

    for (const movement of recentMovements) {
      if (!movement.toolUseHistory) continue;
      for (const tool of movement.toolUseHistory) {
        if (tool.result !== undefined && !tool.isError) {
          results.push({
            toolName: tool.toolName,
            toolId: tool.toolId,
            toolInput: tool.toolInput,
            result: tool.result,
            isError: tool.isError,
            duration: tool.duration,
          });
        }
      }
    }

    return results;
  }

  /**
   * Build a recovery prompt for inter-movement context loss.
   * The Claude session expired between movements (not due to native timeouts).
   * Includes prior conversation summary + preserved tool results + anti-timeout guidance.
   */
  private buildInterMovementRecoveryPrompt(originalPrompt: string, toolResults: ToolUseRecord[]): string {
    const parts: string[] = [
      '## SESSION RECOVERY — Prior Session Expired',
      '',
      'Your previous session expired between prompts. Below is a summary of the conversation so far and all preserved tool results.',
      '',
    ];

    parts.push(...this.formatConversationHistory(this.history.movements));
    parts.push(...this.formatToolResults(toolResults));

    parts.push('### Current user prompt:');
    parts.push(originalPrompt);
    parts.push('');
    parts.push('INSTRUCTIONS:');
    parts.push('1. Use the preserved results above — do NOT re-fetch data you already have');
    parts.push('2. Continue the conversation naturally based on the history above');
    parts.push('3. If you need additional data, fetch it with small focused tool calls');
    parts.push('4. Do NOT spawn Task subagents — do work inline to avoid further timeouts');
    parts.push('5. Prefer multiple small, focused tool calls over single large ones');

    return parts.join('\n');
  }

  /** Summarize a tool input for display in retry prompts */
  private summarizeToolInput(input: Record<string, unknown>): string {
    if (input.url) return String(input.url).slice(0, 100);
    if (input.query) return String(input.query).slice(0, 100);
    if (input.command) return String(input.command).slice(0, 100);
    if (input.prompt) return String(input.prompt).slice(0, 100);
    return JSON.stringify(input).slice(0, 100);
  }

  /** Format a list of timed-out tools for retry prompts */
  private formatTimedOutTools(tools: Array<{ toolName: string; input: Record<string, unknown>; timeoutMs: number }>): string[] {
    const lines: string[] = [];
    lines.push('### Tools/resources that have timed out (DO NOT retry these):');
    for (const t of tools) {
      const inputSummary = this.summarizeToolInput(t.input);
      lines.push(`- **${t.toolName}**(${inputSummary}) — timed out after ${Math.round(t.timeoutMs / 1000)}s`);
    }
    return lines;
  }

  /** Format completed checkpoint tools for retry prompts */
  private formatCompletedTools(tools: Array<{ toolName: string; input: Record<string, unknown>; result: string }>, maxLen = 2000): string[] {
    const lines: string[] = [];
    lines.push('### Results already obtained:');
    for (const tool of tools) {
      const inputSummary = this.summarizeToolInput(tool.input);
      const preview = tool.result.length > maxLen ? `${tool.result.slice(0, maxLen)}...` : tool.result;
      lines.push(`- **${tool.toolName}**(${inputSummary}): ${preview}`);
    }
    return lines;
  }

  /** Format in-progress tools for retry prompts */
  private formatInProgressTools(tools: Array<{ toolName: string; input: Record<string, unknown> }>): string[] {
    const lines: string[] = [];
    lines.push('### Tools that were still running (lost when process was killed):');
    for (const tool of tools) {
      const inputSummary = this.summarizeToolInput(tool.input);
      lines.push(`- **${tool.toolName}**(${inputSummary}) — was in progress, may need re-running`);
    }
    return lines;
  }

  /** Format tool results from ToolUseRecord[] for recovery prompts */
  private formatToolResults(toolResults: ToolUseRecord[], maxLen = 3000): string[] {
    const completed = toolResults.filter(t => t.result !== undefined && !t.isError);
    if (completed.length === 0) return [];
    const lines: string[] = [`### ${completed.length} preserved results from prior work:`, ''];
    for (const tool of completed) {
      const inputSummary = this.summarizeToolInput(tool.toolInput);
      const preview = tool.result && tool.result.length > maxLen
        ? `${tool.result.slice(0, maxLen)}...\n(truncated, ${tool.result.length} chars total)`
        : tool.result || '';
      lines.push(`**${tool.toolName}**(${inputSummary}):`);
      lines.push(preview);
      lines.push('');
    }
    return lines;
  }

  /** Format conversation history for recovery prompts */
  private formatConversationHistory(movements: MovementRecord[], maxMovements = 5): string[] {
    const recent = movements.slice(-maxMovements);
    if (recent.length === 0) return [];
    const lines: string[] = ['### Conversation so far:'];
    for (const movement of recent) {
      const promptText = movement.userPrompt.length > 300 ? `${movement.userPrompt.slice(0, 300)}...` : movement.userPrompt;
      lines.push(`**User (prompt ${movement.sequenceNumber}):** ${promptText}`);
      if (movement.assistantResponse) {
        const response = movement.assistantResponse.length > 1000
          ? `${movement.assistantResponse.slice(0, 1000)}...\n(truncated, ${movement.assistantResponse.length} chars)`
          : movement.assistantResponse;
        lines.push(`**Your response:** ${response}`);
      }
      lines.push('');
    }
    return lines;
  }

  /**
   * Load history from disk
   */
  private loadHistory(): SessionHistory {
    if (existsSync(this.historyPath)) {
      try {
        const data = readFileSync(this.historyPath, 'utf-8');
        return JSON.parse(data);
      } catch (error) {
        console.error('Failed to load history:', error);
      }
    }

    return {
      sessionId: this.sessionId,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      totalTokens: 0,
      movements: []
    };
  }

  /**
   * Save history to disk
   */
  private saveHistory(): void {
    this.history.lastActivityAt = new Date().toISOString();
    writeFileSync(this.historyPath, JSON.stringify(this.history, null, 2));
  }

  /**
   * Get session history
   */
  getHistory(): SessionHistory {
    return this.history;
  }

  /**
   * Cancel current execution
   */
  cancel(): void {
    if (this.currentRunner) {
      this.currentRunner.cleanup();
      this.currentRunner = null;
      this.queueOutput('\n⚠ Execution cancelled\n');
      this.flushOutputQueue();
    }
  }

  /**
   * Cleanup queue processor on shutdown
   */
  destroy(): void {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
    this.flushOutputQueue(); // Final flush
  }

  /**
   * Clear session history and reset to fresh Claude session
   * This resets the isFirstPrompt flag and claudeSessionId so the next prompt starts a new session
   */
  clearHistory(): void {
    this.history.movements = [];
    this.history.totalTokens = 0;
    this.accumulatedKnowledge = '';
    this.isFirstPrompt = true; // Reset to start fresh Claude session
    this.claudeSessionId = undefined; // Clear Claude session ID to start new conversation
    this.cleanupAttachments();
    this.saveHistory();
    this.emit('onSessionUpdate', this.getHistory());
  }

  /**
   * Request user approval for a plan
   * Returns a promise that resolves when the user approves/rejects
   */
  async requestApproval(plan: any): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingApproval = { plan, resolve };
      this.emit('onApprovalRequired', plan);
    });
  }

  /**
   * Respond to approval request
   */
  respondToApproval(approved: boolean): void {
    if (this.pendingApproval) {
      this.pendingApproval.resolve(approved);
      this.pendingApproval = undefined;
    }
  }

  /**
   * Get session metadata
   */
  getSessionInfo() {
    return {
      sessionId: this.sessionId,
      startTime: this.history.startedAt,
      workingDir: this.options.workingDir,
      totalTokens: this.history.totalTokens,
      tokenBudgetThreshold: this.options.tokenBudgetThreshold,
      movementCount: this.history.movements.length
    };
  }

  /**
   * Whether a prompt is currently executing
   */
  get isExecuting(): boolean {
    return this._isExecuting;
  }

  /**
   * Timestamp when current execution started (undefined when not executing)
   */
  get executionStartTimestamp(): number | undefined {
    return this._executionStartTimestamp;
  }

  /**
   * Get buffered execution events for replay on reconnect.
   * Only meaningful while isExecuting is true.
   */
  getExecutionEventLog(): Array<{ type: string; data: any; timestamp: number }> {
    return this.executionEventLog;
  }

  /**
   * Start a new session with fresh context
   * Creates a completely new session manager with isFirstPrompt=true and no claudeSessionId,
   * ensuring the next prompt starts a fresh Claude conversation (proper tab isolation)
   */
  startNewSession(overrides?: Partial<ImprovisationOptions>): ImprovisationSessionManager {
    // Save current session
    this.saveHistory();

    // Create new session manager - the new instance has:
    // - isFirstPrompt=true by default
    // - claudeSessionId=undefined by default
    // This means the first prompt will start a completely fresh Claude conversation
    const newSession = new ImprovisationSessionManager({
      ...this.options,
      sessionId: `improv-${Date.now()}`,
      ...overrides,
    });

    return newSession;
  }
}
