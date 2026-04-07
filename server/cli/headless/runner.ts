// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Headless Runner
 *
 * Executes prompts via Claude Code CLI in improvise mode.
 * Uses direct prompt execution with persistent Claude sessions.
 */

import type { ChildProcess } from 'node:child_process';
import { type ClaudeInvokerOptions, executeClaudeCommand } from './claude-invoker.js';
import { estimateTokensFromOutput } from './output-utils.js';
import { enrichPromptWithContext } from './prompt-utils.js';
import type {
  HeadlessConfig,
  PromptContext, 
  ResolvedHeadlessConfig,
  SessionResult,
} from './types.js';

// Re-export types for backward compatibility
export type { ExecutionCheckpoint, HeadlessConfig, ImageAttachment, SessionResult, SessionState, ToolTimeoutProfile, ToolUseEvent } from './types.js';

/**
 * Kill an entire process group by sending a signal to -pid.
 * Falls back to direct kill if the process group kill fails.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Process group kill failed (e.g. not a group leader) — try direct kill
    try { process.kill(pid, signal); } catch { /* already dead */ }
  }
}

export class HeadlessRunner {
  private config: ResolvedHeadlessConfig;
  private runningProcesses: Map<number, ChildProcess> = new Map();

  constructor(config: Partial<HeadlessConfig>) {
    this.config = {
      workingDir: config.workingDir || process.cwd(),
      tokenBudgetThreshold: config.tokenBudgetThreshold || 170000,
      maxSessions: config.maxSessions || 50,
      maxRetries: config.maxRetries || 3,
      claudeCommand: config.claudeCommand || process.env.CLAUDE_COMMAND || 'claude',
      verbose: !!config.verbose,
      noColor: !!config.noColor,
      improvisationMode: !!config.improvisationMode,
      movementNumber: config.movementNumber ?? 0,
      outputCallback: config.outputCallback,
      thinkingCallback: config.thinkingCallback,
      toolUseCallback: config.toolUseCallback,
      continueSession: config.continueSession,
      claudeSessionId: config.claudeSessionId,
      directPrompt: config.directPrompt || '',
      promptContext: config.promptContext || { accumulatedKnowledge: '', filesModified: [] },
      imageAttachments: config.imageAttachments,
      stallWarningMs: config.stallWarningMs ?? 300_000,
      stallKillMs: config.stallKillMs ?? 1_800_000,
      stallAssessEnabled: config.stallAssessEnabled !== false,
      stallMaxExtensions: config.stallMaxExtensions ?? 3,
      stallHardCapMs: config.stallHardCapMs ?? 3_600_000,
      model: config.model,
      toolTimeoutProfiles: config.toolTimeoutProfiles,
      enableToolWatchdog: config.enableToolWatchdog !== false,
      maxAutoRetries: config.maxAutoRetries ?? 2,
      onToolTimeout: config.onToolTimeout,
      extraEnv: config.extraEnv,
    };
  }

  /**
   * Run direct prompt execution
   */
  async run(): Promise<SessionResult> {
    if (this.config.directPrompt) {
      return await this.runDirectPrompt(this.config.directPrompt, this.config.promptContext);
    }

    return {
      completed: false,
      needsHandoff: false,
      totalTokens: 0,
      sessionId: '',
      error: 'No prompt provided. Use directPrompt in improvise mode.'
    };
  }

  /**
   * Execute a direct prompt without score file I/O
   */
  private async runDirectPrompt(userPrompt: string, context?: PromptContext): Promise<SessionResult> {
    const sessionId = `direct-${Date.now()}`;

    const enrichedPrompt = context
      ? await enrichPromptWithContext(userPrompt, context)
      : userPrompt;

    const result = await this.executePromptCommand(enrichedPrompt, 'main', 1);

    if (result.exitCode !== 0) {
      // Signal exits (128+) with meaningful output are successful completions —
      // Claude finished its work but the process was killed by signal (e.g., stall watchdog SIGTERM)
      const isSignalExit = result.exitCode >= 128;
      const hasOutput = !!(result.assistantResponse || (result.toolUseHistory && result.toolUseHistory.length > 0));

      if (isSignalExit && hasOutput) {
        const tokens = estimateTokensFromOutput(result.output);
        return {
          completed: true,
          needsHandoff: false,
          totalTokens: tokens,
          sessionId,
          signalName: result.signalName,
          assistantResponse: result.assistantResponse,
          thinkingOutput: result.thinkingOutput,
          toolUseHistory: result.toolUseHistory,
          claudeSessionId: result.claudeSessionId,
          nativeTimeoutCount: result.nativeTimeoutCount,
          postTimeoutOutput: result.postTimeoutOutput,
          resumeBufferedOutput: result.resumeBufferedOutput,
          stopReason: result.stopReason,
        };
      }

      // Build meaningful error: prefer stderr, fall back to non-JSON stdout lines
      let errorMessage = result.error;
      if (!errorMessage && result.output) {
        const plainLines = result.output.split('\n')
          .filter(l => l.trim() && !l.trim().startsWith('{'))
          .join('\n')
          .trim();
        if (plainLines) {
          errorMessage = plainLines.slice(0, 500);
        }
      }
      return {
        completed: false,
        needsHandoff: false,
        totalTokens: 0,
        sessionId,
        error: errorMessage || `Claude exited with code ${result.exitCode}`,
        signalName: result.signalName,
        assistantResponse: result.assistantResponse,
        thinkingOutput: result.thinkingOutput,
        toolUseHistory: result.toolUseHistory,
        claudeSessionId: result.claudeSessionId,
        nativeTimeoutCount: result.nativeTimeoutCount,
        postTimeoutOutput: result.postTimeoutOutput,
        resumeBufferedOutput: result.resumeBufferedOutput,
        stopReason: result.stopReason,
      };
    }

    const tokens = estimateTokensFromOutput(result.output);

    return {
      completed: true,
      needsHandoff: false,
      totalTokens: tokens,
      sessionId,
      signalName: result.signalName,
      assistantResponse: result.assistantResponse,
      thinkingOutput: result.thinkingOutput,
      toolUseHistory: result.toolUseHistory,
      claudeSessionId: result.claudeSessionId,
      nativeTimeoutCount: result.nativeTimeoutCount,
      postTimeoutOutput: result.postTimeoutOutput,
      resumeBufferedOutput: result.resumeBufferedOutput,
      stopReason: result.stopReason,
    };
  }

  /**
   * Execute a single prompt via Claude CLI
   */
  private async executePromptCommand(
    prompt: string,
    promptId: string,
    sessionNumber: number
  ) {
    const invokerOptions: ClaudeInvokerOptions = {
      config: this.config,
      runningProcesses: this.runningProcesses
    };

    return executeClaudeCommand(prompt, promptId, sessionNumber, invokerOptions);
  }

  /**
   * Cleanup on exit — SIGTERM all tracked process groups, then SIGKILL stragglers after 5s
   */
  cleanup(): void {
    if (this.runningProcesses.size === 0) return;

    const pids = new Set<number>();
    for (const [pid] of this.runningProcesses) {
      pids.add(pid);
      killProcessGroup(pid, 'SIGTERM');
    }

    // SIGKILL fallback after 5 seconds for any process that didn't exit
    setTimeout(() => {
      for (const [pid, proc] of this.runningProcesses) {
        if (pids.has(pid) && !proc.killed) {
          killProcessGroup(pid, 'SIGKILL');
        }
      }
      this.runningProcesses.clear();
    }, 5000);
  }

  /**
   * Sweep for zombie processes — entries in runningProcesses whose underlying
   * process has already exited but whose 'close' event was missed.
   */
  sweepZombies(): number {
    let swept = 0;
    for (const [pid, proc] of this.runningProcesses) {
      if (proc.exitCode !== null || proc.killed) {
        this.runningProcesses.delete(pid);
        swept++;
      }
    }
    return swept;
  }
}
