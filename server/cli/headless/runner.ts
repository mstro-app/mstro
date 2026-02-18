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
export type { HeadlessConfig, ImageAttachment, SessionResult, SessionState, ToolUseEvent } from './types.js';

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
      verbose: config.verbose || false,
      noColor: config.noColor || false,
      improvisationMode: config.improvisationMode || false,
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
      ? enrichPromptWithContext(userPrompt, context)
      : userPrompt;

    const result = await this.executePromptCommand(enrichedPrompt, 'main', 1);

    if (result.exitCode !== 0) {
      return {
        completed: false,
        needsHandoff: false,
        totalTokens: 0,
        sessionId,
        error: result.error || 'Execution failed',
        assistantResponse: result.assistantResponse,
        thinkingOutput: result.thinkingOutput,
        toolUseHistory: result.toolUseHistory,
        claudeSessionId: result.claudeSessionId
      };
    }

    const tokens = estimateTokensFromOutput(result.output);

    return {
      completed: true,
      needsHandoff: false,
      totalTokens: tokens,
      sessionId,
      assistantResponse: result.assistantResponse,
      thinkingOutput: result.thinkingOutput,
      toolUseHistory: result.toolUseHistory,
      claudeSessionId: result.claudeSessionId
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
   * Cleanup on exit
   */
  cleanup(): void {
    for (const [_pid, process] of this.runningProcesses) {
      process.kill();
    }
    this.runningProcesses.clear();
  }
}
