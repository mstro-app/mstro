// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * ClaudeCodeEngine
 *
 * Thin adapter that wraps the existing Claude Code subprocess path
 * (claude-invoker) behind the CodingAgentEngine interface. All stdout
 * parsing, watchdog, stall detection, and process spawning stays in the
 * headless runner modules — this file only translates HeadlessRunner
 * callbacks into EngineEvents and owns its own process-group map for
 * cancellation.
 */

import type { ChildProcess } from 'node:child_process';
import { executeClaudeCommand } from '../../cli/headless/claude-invoker.js';
import { killProcessGroup } from '../../cli/headless/runner.js';
import type {
  ExecutionResult,
  ImageAttachment,
  ResolvedHeadlessConfig,
  ToolUseEvent,
} from '../../cli/headless/types.js';
import type {
  EngineEvent,
  EngineId,
} from '../EngineEvent.js';
import type {
  CodingAgentEngine,
  EngineUsage,
  PromptAttachment,
  StartSessionOptions,
} from '../types.js';

type Resolver = (r: IteratorResult<EngineEvent>) => void;

/**
 * Implementation of CodingAgentEngine backed by the Claude Code headless
 * runner. The engine holds a single logical conversation — subsequent
 * prompts automatically continue the Claude session via --resume.
 */
export class ClaudeCodeEngine implements CodingAgentEngine {
  readonly engineId: EngineId = 'claude-code';

  private sessionOptions: StartSessionOptions | null = null;
  private claudeSessionId: string | undefined;
  /**
   * Live child processes spawned by the current prompt. Keyed by pid; values
   * are the raw ChildProcess handles. executeClaudeCommand registers the
   * spawned process here and removes it on 'close'. cancel() iterates this
   * map and SIGTERMs each process group — matching the pre-engine behavior
   * from HeadlessRunner.cleanup().
   */
  private readonly runningProcesses: Map<number, ChildProcess> = new Map();
  private currentRunPromise: Promise<ExecutionResult> | null = null;

  private disposed = false;
  private iteratorDone = false;
  private readonly queue: EngineEvent[] = [];
  private readonly pending: Resolver[] = [];

  private usage: EngineUsage = {
    inputTokens: 0,
    outputTokens: 0,
    lastUpdatedAt: Date.now(),
  };

  async startSession(options: StartSessionOptions): Promise<void> {
    if (this.sessionOptions) {
      throw new Error('ClaudeCodeEngine: startSession called more than once');
    }
    if (this.disposed) {
      throw new Error('ClaudeCodeEngine: cannot start a disposed engine');
    }
    this.sessionOptions = options;
    this.claudeSessionId = options.resumeSessionId;
    this.usage = {
      inputTokens: 0,
      outputTokens: 0,
      lastUpdatedAt: Date.now(),
    };
  }

  async sendPrompt(prompt: string, attachments?: PromptAttachment[]): Promise<void> {
    if (!this.sessionOptions) {
      throw new Error('ClaudeCodeEngine: sendPrompt called before startSession');
    }
    if (this.disposed) {
      throw new Error('ClaudeCodeEngine: sendPrompt called after dispose');
    }
    if (this.currentRunPromise) {
      throw new Error('ClaudeCodeEngine: another prompt is already in flight');
    }

    const opts = this.sessionOptions;
    const imageAttachments = convertImageAttachments(attachments);

    const toolStartTimes = new Map<string, number>();
    const toolNames = new Map<string, string>();
    const toolInputs = new Map<string, Record<string, unknown>>();

    const config: ResolvedHeadlessConfig = {
      workingDir: opts.workingDir,
      tokenBudgetThreshold: 170_000,
      maxSessions: 50,
      maxRetries: 3,
      claudeCommand: process.env.CLAUDE_COMMAND || 'claude',
      verbose: false,
      noColor: false,
      improvisationMode: false,
      movementNumber: 0,
      directPrompt: prompt,
      promptContext: { accumulatedKnowledge: '', filesModified: [] },
      stallWarningMs: 300_000,
      stallKillMs: 1_800_000,
      stallAssessEnabled: true,
      stallMaxExtensions: 3,
      stallHardCapMs: 3_600_000,
      enableToolWatchdog: true,
      maxAutoRetries: 2,
      model: opts.model,
      effortLevel: opts.effortLevel,
      continueSession: !!this.claudeSessionId,
      claudeSessionId: this.claudeSessionId,
      imageAttachments,
      disallowedTools: opts.disallowedTools,
      deployMode: opts.deployMode,
      extraEnv: opts.extraEnv,
      outputCallback: (text: string) => {
        this.emit({
          kind: 'message.delta',
          sessionId: this.sessionIdForEvent(),
          timestamp: Date.now(),
          text,
        });
      },
      thinkingCallback: (text: string) => {
        this.emit({
          kind: 'message.thinking',
          sessionId: this.sessionIdForEvent(),
          timestamp: Date.now(),
          text,
        });
      },
      toolUseCallback: (event: ToolUseEvent) => {
        this.handleToolUseEvent(event, toolStartTimes, toolNames, toolInputs);
      },
      tokenUsageCallback: (usage: { inputTokens: number; outputTokens: number }) => {
        this.usage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          lastUpdatedAt: Date.now(),
        };
        this.emit({
          kind: 'usage.update',
          sessionId: this.sessionIdForEvent(),
          timestamp: Date.now(),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      },
    };

    const runPromise = executeClaudeCommand(prompt, 'engine', 1, {
      config,
      runningProcesses: this.runningProcesses,
    });
    this.currentRunPromise = runPromise;

    runPromise.then(
      (result) => this.onRunCompleted(result),
      (err) => this.onRunFailed(err),
    );
  }

  async cancel(): Promise<void> {
    if (this.runningProcesses.size === 0 && !this.currentRunPromise) return;
    this.killAllRunningProcesses();
    if (this.currentRunPromise) {
      await this.currentRunPromise.catch(() => { /* surfaced as engine.error */ });
    }
  }

  getUsage(): EngineUsage {
    return { ...this.usage };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.killAllRunningProcesses();
    if (this.currentRunPromise) {
      await this.currentRunPromise.catch(() => { /* surfaced as engine.error */ });
    }
    this.closeIterator();
  }

  [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    return {
      next: (): Promise<IteratorResult<EngineEvent>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift() as EngineEvent, done: false });
        }
        if (this.iteratorDone) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<EngineEvent>>((resolve) => {
          this.pending.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<EngineEvent>> => {
        this.closeIterator();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  // ---------- private ----------

  private sessionIdForEvent(): string {
    return this.claudeSessionId ?? 'pending';
  }

  /**
   * SIGTERM every tracked child process group; schedule a SIGKILL fallback
   * for any that haven't exited in 5s. Mirrors HeadlessRunner.cleanup().
   */
  private killAllRunningProcesses(): void {
    if (this.runningProcesses.size === 0) return;
    const pids = new Set<number>();
    for (const pid of this.runningProcesses.keys()) {
      pids.add(pid);
      killProcessGroup(pid, 'SIGTERM');
    }
    setTimeout(() => {
      for (const [pid, proc] of this.runningProcesses) {
        if (pids.has(pid) && !proc.killed) {
          killProcessGroup(pid, 'SIGKILL');
        }
      }
    }, 5000).unref?.();
  }

  private emit(event: EngineEvent): void {
    if (this.iteratorDone) return;
    const resolver = this.pending.shift();
    if (resolver) {
      resolver({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
    if (event.kind === 'engine.error' && event.fatal) {
      this.closeIterator();
    }
  }

  private closeIterator(): void {
    if (this.iteratorDone) return;
    this.iteratorDone = true;
    const waiting = this.pending.splice(0);
    for (const resolve of waiting) {
      resolve({ value: undefined, done: true });
    }
  }

  private onRunCompleted(result: ExecutionResult): void {
    this.currentRunPromise = null;
    if (result.claudeSessionId) {
      this.claudeSessionId = result.claudeSessionId;
    }
    // Fall back to the definitive end-of-run usage — the streaming callback
    // may have missed the final numbers if the result event arrived after
    // the last message_delta.
    if (result.apiTokenUsage) {
      const u = result.apiTokenUsage;
      if (u.inputTokens > this.usage.inputTokens || u.outputTokens > this.usage.outputTokens) {
        this.usage = {
          inputTokens: Math.max(u.inputTokens, this.usage.inputTokens),
          outputTokens: Math.max(u.outputTokens, this.usage.outputTokens),
          lastUpdatedAt: Date.now(),
        };
      }
    }
    this.emit({
      kind: 'session.idle',
      sessionId: this.sessionIdForEvent(),
      timestamp: Date.now(),
      stopReason: result.stopReason,
    });
    if (result.exitCode !== 0 && !result.assistantResponse && !result.toolUseHistory?.length) {
      const message = result.error || `Claude exited with code ${result.exitCode}`;
      this.emit({
        kind: 'engine.error',
        sessionId: this.sessionIdForEvent(),
        timestamp: Date.now(),
        code: 'CLAUDE_RUN_ERROR',
        message,
        fatal: false,
      });
    }
  }

  private onRunFailed(err: unknown): void {
    this.currentRunPromise = null;
    const message = err instanceof Error ? err.message : String(err);
    this.emit({
      kind: 'engine.error',
      sessionId: this.sessionIdForEvent(),
      timestamp: Date.now(),
      code: 'CLAUDE_SPAWN_ERROR',
      message,
      fatal: true,
    });
  }

  private handleToolUseEvent(
    event: ToolUseEvent,
    starts: Map<string, number>,
    names: Map<string, string>,
    inputs: Map<string, Record<string, unknown>>,
  ): void {
    if (!event.toolId) return;
    if (event.type === 'tool_start') {
      this.onToolStart(event, starts, names);
    } else if (event.type === 'tool_complete') {
      this.onToolComplete(event, names, inputs);
    } else if (event.type === 'tool_result') {
      this.onToolResult(event, starts, names, inputs);
    }
  }

  private onToolStart(
    event: ToolUseEvent,
    starts: Map<string, number>,
    names: Map<string, string>,
  ): void {
    const ts = Date.now();
    const toolId = event.toolId as string;
    starts.set(toolId, ts);
    if (event.toolName) names.set(toolId, event.toolName);
    this.emit({
      kind: 'tool.start',
      sessionId: this.sessionIdForEvent(),
      timestamp: ts,
      toolCallId: toolId,
      toolName: event.toolName ?? '',
      input: {},
    });
  }

  private onToolComplete(
    event: ToolUseEvent,
    names: Map<string, string>,
    inputs: Map<string, Record<string, unknown>>,
  ): void {
    const toolId = event.toolId as string;
    if (event.completeInput) inputs.set(toolId, event.completeInput);
    if (event.toolName) names.set(toolId, event.toolName);
    // tool.end is emitted on tool_result so the result payload is included.
  }

  private onToolResult(
    event: ToolUseEvent,
    starts: Map<string, number>,
    names: Map<string, string>,
    inputs: Map<string, Record<string, unknown>>,
  ): void {
    const ts = Date.now();
    const toolId = event.toolId as string;
    const start = starts.get(toolId) ?? ts;
    this.emit({
      kind: 'tool.end',
      sessionId: this.sessionIdForEvent(),
      timestamp: ts,
      toolCallId: toolId,
      toolName: names.get(toolId) ?? '',
      input: inputs.get(toolId) ?? {},
      result: event.result ?? '',
      isError: event.isError ?? false,
      durationMs: ts - start,
    });
    starts.delete(toolId);
    names.delete(toolId);
    inputs.delete(toolId);
  }
}

function convertImageAttachments(
  attachments?: PromptAttachment[],
): ImageAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  const images: ImageAttachment[] = [];
  for (const a of attachments) {
    if (!a.isImage || !a.base64Content) continue;
    images.push({
      fileName: a.fileName,
      filePath: a.filePath ?? a.fileName,
      content: a.base64Content,
      isImage: true,
      mimeType: a.mimeType,
    });
  }
  return images.length > 0 ? images : undefined;
}
