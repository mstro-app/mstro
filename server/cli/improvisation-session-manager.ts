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
import { HeadlessRunner } from './headless/index.js';
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
}

export interface SessionHistory {
  sessionId: string;
  startedAt: string;
  lastActivityAt: string;
  totalTokens: number;
  movements: MovementRecord[];
  claudeSessionId?: string;
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
  /** Buffered events during current execution, for replay on reconnect */
  private executionEventLog: Array<{ type: string; data: any; timestamp: number }> = [];

  /**
   * Resume from a historical session.
   * Creates a new session manager that continues the conversation from a previous session.
   * The first prompt will include context from the historical session.
   */
  static resumeFromHistory(workingDir: string, historicalSessionId: string, overrides?: Partial<ImprovisationOptions>): ImprovisationSessionManager {
    const improviseDir = join(workingDir, '.mstro', 'improvise');

    // Extract timestamp from session ID (format: improv-1234567890123 or just 1234567890123)
    const timestamp = historicalSessionId.replace('improv-', '');
    const historyPath = join(improviseDir, `history-${timestamp}.json`);

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
    this.improviseDir = join(this.options.workingDir, '.mstro', 'improvise');
    this.historyPath = join(this.improviseDir, `history-${this.sessionId.replace('improv-', '')}.json`);

    // Ensure improvise directory exists
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
   * Build prompt with text file attachments prepended
   * Format: each text file is shown as @path followed by content in code block
   */
  private buildPromptWithAttachments(userPrompt: string, attachments?: FileAttachment[]): string {
    if (!attachments || attachments.length === 0) {
      return userPrompt;
    }

    // Filter to text files only (non-images)
    const textFiles = attachments.filter(a => !a.isImage);
    if (textFiles.length === 0) {
      return userPrompt;
    }

    // Build file content blocks
    const fileBlocks = textFiles.map(file => {
      return `@${file.filePath}\n\`\`\`\n${file.content}\n\`\`\``;
    }).join('\n\n');

    // Prepend file content to user prompt
    return `${fileBlocks}\n\n${userPrompt}`;
  }

  /**
   * Execute a user prompt directly (Improvise mode - no score decomposition)
   * Uses persistent Claude sessions via --resume <sessionId> for conversation continuity
   * Each tab maintains its own claudeSessionId for proper isolation
   * Supports file attachments: text files prepended to prompt, images via stream-json multimodal
   */
  async executePrompt(userPrompt: string, attachments?: FileAttachment[]): Promise<MovementRecord> {
    const _execStart = Date.now();

    // Start execution event log for reconnect replay
    this._isExecuting = true;
    this.executionEventLog = [];

    this.emit('onMovementStart', this.history.movements.length + 1, userPrompt);
    trackEvent(AnalyticsEvents.IMPROVISE_PROMPT_RECEIVED, {
      prompt_length: userPrompt.length,
      has_attachments: !!(attachments && attachments.length > 0),
      attachment_count: attachments?.length || 0,
      image_attachment_count: attachments?.filter(a => a.isImage).length || 0,
      sequence_number: this.history.movements.length + 1,
      is_resumed_session: this.isResumedSession,
      model: this.options.model || 'default',
    });

    try {
      const sequenceNumber = this.history.movements.length + 1;

      // Log the movement start event
      this.executionEventLog.push({
        type: 'movementStart',
        data: { sequenceNumber, prompt: userPrompt, timestamp: Date.now() },
        timestamp: Date.now(),
      });

      // DEBUG: Removed "Executing prompt..." message - it serves no purpose now that system responds fast
      // this.queueOutput(`\n🎵 Executing prompt...\n`);
      // this.flushOutputQueue();

      // NOTE: Risk analysis removed - now handled by MCP bouncer at tool-use time
      // The MCP bouncer intercepts ALL tool calls (Bash, Write, etc.) and uses
      // Mstro's bouncer-integration.ts for AI-powered approval/denial.
      // This is more effective than analyzing user prompts, which had false positives.


      // Build prompt with text file attachments prepended
      const promptWithAttachments = this.buildPromptWithAttachments(userPrompt, attachments);

      // Checkpoint-and-retry loop: if a tool times out, we capture a checkpoint,
      // kill the process, and retry with context from successful results
      const maxRetries = 2;
      let currentPrompt = promptWithAttachments;
      let retryNumber = 0;
      // Object wrapper so TS doesn't narrow the callback-assigned value to `never`
      const checkpointRef: { value: ExecutionCheckpoint | null } = { value: null };
      let result: Awaited<ReturnType<HeadlessRunner['run']>>;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        checkpointRef.value = null;

        // PERSISTENT SESSION: Use --resume <sessionId> to maintain conversation history per tab
        // CRITICAL FIX: Using claudeSessionId ensures each tab resumes its own Claude session
        // On retry: start fresh session (no --resume since old session has incomplete tool call)
        const runner = new HeadlessRunner({
          workingDir: this.options.workingDir,
          tokenBudgetThreshold: this.options.tokenBudgetThreshold,
          maxSessions: this.options.maxSessions,
          verbose: this.options.verbose,
          noColor: this.options.noColor,
          model: this.options.model,
          improvisationMode: true,
          movementNumber: sequenceNumber,
          // On retry, don't resume the old session (it has an incomplete tool call)
          continueSession: retryNumber === 0 ? !this.isFirstPrompt : false,
          claudeSessionId: retryNumber === 0 ? this.claudeSessionId : undefined,
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
          directPrompt: currentPrompt,
          // Pass image attachments for multimodal handling via stream-json (first attempt only)
          imageAttachments: retryNumber === 0 ? attachments?.filter(a => a.isImage) : undefined,
          // Inject historical context on first prompt of a resumed session
          promptContext: (retryNumber === 0 && this.isResumedSession && this.isFirstPrompt)
            ? { accumulatedKnowledge: this.buildHistoricalContext(), filesModified: [] }
            : undefined,
          onToolTimeout: (checkpoint: ExecutionCheckpoint) => {
            checkpointRef.value = checkpoint;
          },
        });

        this.currentRunner = runner;
        result = await runner.run();
        this.currentRunner = null;

        // If no tool timeout occurred, or we've exhausted retries, break
        if (!checkpointRef.value || retryNumber >= maxRetries) {
          break;
        }

        // Tool timed out — extract checkpoint (TS needs this in a separate const after the guard)
        const cp: ExecutionCheckpoint = checkpointRef.value;
        retryNumber++;
        this.emit('onAutoRetry', {
          retryNumber,
          maxRetries,
          toolName: cp.hungTool.toolName,
          url: cp.hungTool.url,
          completedCount: cp.completedTools.length,
        });

        trackEvent(AnalyticsEvents.IMPROVISE_AUTO_RETRY, {
          retry_number: retryNumber,
          hung_tool: cp.hungTool.toolName,
          hung_url: cp.hungTool.url?.slice(0, 200),
          completed_tools: cp.completedTools.length,
          elapsed_ms: cp.elapsedMs,
        });

        currentPrompt = this.buildRetryPrompt(cp, promptWithAttachments);

        this.queueOutput(
          `\n[[MSTRO_AUTO_RETRY]] Auto-retry ${retryNumber}/${maxRetries}: Continuing with ${cp.completedTools.length} successful results, skipping failed ${cp.hungTool.toolName}.\n`
        );
        this.flushOutputQueue();
      }

      // Capture Claude session ID for future prompts in this tab
      // This is critical for tab isolation - each tab maintains its own Claude session
      if (result.claudeSessionId) {
        this.claudeSessionId = result.claudeSessionId;
        this.history.claudeSessionId = result.claudeSessionId;
      }

      // Surface execution failure to user — without this, failures show as
      // "Command completed" with no output (the error only existed in errorOutput)
      if (!result.completed && result.error) {
        this.queueOutput(`\n[[MSTRO_ERROR:EXECUTION_FAILED]] ${result.error}\n`);
        this.flushOutputQueue();
      }

      // Mark that we've executed at least one prompt
      this.isFirstPrompt = false;

      // Create movement record with accumulated output for persistence
      const movement: MovementRecord = {
        id: `prompt-${sequenceNumber}`,
        sequenceNumber,
        userPrompt,
        timestamp: new Date().toISOString(),
        tokensUsed: result.totalTokens,
        summary: '', // No summary needed - Claude session maintains context
        filesModified: [],
        // Persist accumulated output for history replay
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
        errorOutput: result.error
      };

      // Handle file conflicts if any
      if (result.conflicts && result.conflicts.length > 0) {
        this.queueOutput(`\n⚠ File conflicts detected: ${result.conflicts.length}`);
        result.conflicts.forEach(c => {
          this.queueOutput(`  - ${c.filePath} (modified by: ${c.modifiedBy.join(', ')})`);
          if (c.backupPath) {
            this.queueOutput(`    Backup created: ${c.backupPath}`);
          }
        });
        this.flushOutputQueue();
      }

      this.history.movements.push(movement);
      this.history.totalTokens += movement.tokensUsed;

      // Save history
      this.saveHistory();

      // Completion message is now handled by the client-side movementComplete event handler
      // This prevents duplicate completion messages (one white, one green)
      // this.queueOutput(`\n✓ Complete (tokens: ${result.totalTokens.toLocaleString()})\n`);
      // this.flushOutputQueue();

      this._isExecuting = false;
      this.executionEventLog = [];

      this.emit('onMovementComplete', movement);
      trackEvent(AnalyticsEvents.IMPROVISE_MOVEMENT_COMPLETED, {
        tokens_used: movement.tokensUsed,
        duration_ms: Date.now() - _execStart,
        sequence_number: sequenceNumber,
        tool_count: result.toolUseHistory?.length || 0,
        model: this.options.model || 'default',
      });
      this.emit('onSessionUpdate', this.getHistory());

      return movement;

    } catch (error: any) {
      this._isExecuting = false;
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
      // Ensure final flush
      this.flushOutputQueue();
    }
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
  private buildRetryPrompt(checkpoint: ExecutionCheckpoint, originalPrompt: string): string {
    const parts: string[] = [];

    parts.push('## AUTOMATIC RETRY -- Previous Execution Interrupted');
    parts.push('');
    parts.push(
      `The previous execution was interrupted because ${checkpoint.hungTool.toolName} timed out after ${Math.round(checkpoint.hungTool.timeoutMs / 1000)}s${checkpoint.hungTool.url ? ` while fetching: ${checkpoint.hungTool.url}` : ''}.`
    );
    parts.push('');
    parts.push('This URL/resource is unreachable. DO NOT retry the same URL or query.');
    parts.push('');

    if (checkpoint.completedTools.length > 0) {
      parts.push('### Results already obtained:');
      for (const tool of checkpoint.completedTools) {
        const inputSummary = this.summarizeToolInput(tool.input);
        const resultPreview = tool.result.length > 500
          ? `${tool.result.slice(0, 500)}...`
          : tool.result;
        parts.push(`- **${tool.toolName}**(${inputSummary}): ${resultPreview}`);
      }
      parts.push('');
    }

    if (checkpoint.inProgressTools && checkpoint.inProgressTools.length > 0) {
      parts.push('### Tools that were still running (lost when process was killed):');
      for (const tool of checkpoint.inProgressTools) {
        const inputSummary = this.summarizeToolInput(tool.input);
        parts.push(`- **${tool.toolName}**(${inputSummary}) — was in progress, may need re-running`);
      }
      parts.push('');
    }

    if (checkpoint.assistantText) {
      parts.push('### Your response before interruption:');
      const preview = checkpoint.assistantText.length > 2000
        ? `${checkpoint.assistantText.slice(0, 2000)}...`
        : checkpoint.assistantText;
      parts.push(preview);
      parts.push('');
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

  /** Summarize a tool input for display in retry prompts */
  private summarizeToolInput(input: Record<string, unknown>): string {
    if (input.url) return String(input.url).slice(0, 100);
    if (input.query) return String(input.query).slice(0, 100);
    if (input.command) return String(input.command).slice(0, 100);
    if (input.prompt) return String(input.prompt).slice(0, 100);
    return JSON.stringify(input).slice(0, 100);
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
