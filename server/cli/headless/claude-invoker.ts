// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Claude Invoker
 *
 * Orchestrates spawning and managing Claude CLI processes.
 * Stream handling, stall detection, tool tracking, and process management
 * are delegated to focused sub-modules.
 */

import type { ChildProcess } from 'node:child_process';
import { buildCloseResult, handleSpawnError, spawnAndRegister } from './claude-invoker-process.js';
import { runStallCheckTick, type StallState } from './claude-invoker-stall.js';
import { classifyUnmatchedStderr, processStreamLines, type StreamHandlerContext, verboseLog } from './claude-invoker-stream.js';
import { setupToolTracking } from './claude-invoker-tools.js';
import { NativeTimeoutDetector } from './native-timeout-detector.js';
import { detectErrorInStderr } from './output-utils.js';
import type { ExecutionResult, ResolvedHeadlessConfig } from './types.js';

export interface ClaudeInvokerOptions {
  config: ResolvedHeadlessConfig;
  runningProcesses: Map<number, ChildProcess>;
}

/**
 * Execute a Claude CLI command for a single movement.
 * Supports multimodal prompts via --input-format stream-json when image attachments are present.
 */
export async function executeClaudeCommand(
  prompt: string,
  _movementId: string,
  _sessionNumber: number,
  options: ClaudeInvokerOptions
): Promise<ExecutionResult> {
  const { config, runningProcesses } = options;
  const perfStart = Date.now();
  verboseLog(config.verbose, '[PERF] executeMovement started');

  const hasImageAttachments = config.imageAttachments && config.imageAttachments.length > 0;
  const useStreamJson = hasImageAttachments || config.thinkingCallback || config.outputCallback || config.toolUseCallback;

  const claudeProcess = await spawnAndRegister(config, prompt, !!hasImageAttachments, !!useStreamJson, runningProcesses, perfStart);

  let stdout = '';
  let stderr = '';
  let thinkingBuffer = '';
  let firstStdoutReceived = false;
  let errorAlreadySurfaced = false;

  const sessionCapture: { claudeSessionId?: string } = {};
  const isResumeMode = !!(config.continueSession && config.claudeSessionId);

  const ctx: StreamHandlerContext = {
    config,
    accumulatedAssistantResponse: '',
    accumulatedThinking: '',
    accumulatedToolUse: [],
    toolInputBuffers: new Map(),
    nativeTimeoutDetector: new NativeTimeoutDetector(),
    resumeAssessmentActive: isResumeMode,
    resumeAssessmentBuffer: '',
    apiTokenUsage: { inputTokens: 0, outputTokens: 0 },
    currentStepOutputTokens: 0,
    lastTokenActivityTime: Date.now(),
    hasReceivedTextDeltas: false,
    hasReceivedThinkingDeltas: false,
  };

  const stallState: StallState = {
    lastActivityTime: Date.now(),
    stallWarningEmitted: false,
    assessmentInProgress: false,
    extensionsGranted: 0,
    currentKillDeadline: Date.now() + (config.stallKillMs ?? 1_800_000),
    nextWarningAfter: 0,
  };

  const toolTracking = setupToolTracking(config, stallState, ctx, sessionCapture, prompt, perfStart);
  const { pendingTools, watchdog, toolWatchdogActive } = toolTracking;
  const toolCounters = toolTracking.counters;

  claudeProcess.stdout!.on('data', (data) => {
    stallState.lastActivityTime = Date.now();
    stallState.stallWarningEmitted = false;
    stallState.nextWarningAfter = 0;
    const killMs = config.stallKillMs ?? 1_800_000;
    stallState.currentKillDeadline = Date.now() + killMs;

    if (!firstStdoutReceived) {
      firstStdoutReceived = true;
      verboseLog(config.verbose, `[PERF] First stdout data: ${Date.now() - perfStart}ms`);
    }

    const chunk = data.toString();
    stdout += chunk;

    if (useStreamJson) {
      thinkingBuffer = processStreamLines(thinkingBuffer + chunk, sessionCapture, ctx);
    }
  });

  claudeProcess.stderr!.on('data', async (data) => {
    const chunk = data.toString();
    stderr += chunk;

    if (errorAlreadySurfaced) return;

    const error = detectErrorInStderr(stderr);
    if (error) {
      errorAlreadySurfaced = true;
      if (config.outputCallback) {
        config.outputCallback(`\n[[MSTRO_ERROR:${error.errorCode}]] ${error.message}\n`);
      }
    }
  });

  // Stall detection with intelligent assessment
  const stallWarningMs = config.stallWarningMs ?? 300_000;
  const stallHardCapMs = config.stallHardCapMs ?? 14_400_000;
  const maxExtensions = config.stallMaxExtensions ?? 3;
  const stallAssessEnabled = config.stallAssessEnabled !== false;

  // eslint-disable-next-line prefer-const
  let stallCheckInterval: ReturnType<typeof setInterval>;
  stallCheckInterval = setInterval(() => {
    runStallCheckTick(stallState, {
      perfStart, stallWarningMs, stallHardCapMs, maxExtensions, stallAssessEnabled,
      toolWatchdogActive, prompt, pendingTools, lastToolInputSummary: toolCounters.lastToolInputSummary, totalToolCalls: toolCounters.totalToolCalls,
      claudeProcess, stallCheckInterval, config, lastTokenActivityTime: ctx.lastTokenActivityTime,
    });
  }, 10_000);

  toolTracking.setKillContext(claudeProcess, stallCheckInterval);

  return new Promise((resolve, reject) => {
    claudeProcess.on('close', async (code, signal) => {
      clearInterval(stallCheckInterval);
      watchdog?.clearAll();
      await classifyUnmatchedStderr(stderr, errorAlreadySurfaced, code, config);
      if (claudeProcess.pid) runningProcesses.delete(claudeProcess.pid);
      resolve(buildCloseResult(ctx, stdout, stderr, code, signal, sessionCapture));
    });

    claudeProcess.on('error', (error: NodeJS.ErrnoException) => {
      clearInterval(stallCheckInterval);
      watchdog?.clearAll();
      if (claudeProcess.pid) runningProcesses.delete(claudeProcess.pid);
      handleSpawnError(error, config, reject);
    });
  });
}
