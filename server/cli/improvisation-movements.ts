// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Pure builders for the MovementRecord snapshots that session-manager
 * writes after each executePrompt outcome — normal completion, user
 * cancel, hard error — plus the auto-continue decision heuristic.
 */

import type { HeadlessRunResult, MovementRecord, RetryLogEntry } from './improvisation-types.js';

/**
 * Fallback `HeadlessRunResult` used when a cancellation fires before any
 * run produces one. Shape matches the minimum fields the emit helpers
 * look at downstream.
 */
export const CANCELLED_FALLBACK_RESULT: HeadlessRunResult = {
  completed: false, needsHandoff: false, totalTokens: 0, sessionId: '',
  output: '', exitCode: 1, signalName: 'SIGTERM',
} as HeadlessRunResult;

export interface MovementBuildArgs {
  sequenceNumber: number;
  userPrompt: string;
  execStart: number;
  isAutoContinue?: boolean;
}

/** Build a MovementRecord representing a successful execution. */
export function buildSuccessMovement(
  result: HeadlessRunResult,
  args: MovementBuildArgs,
  retryLog: RetryLogEntry[] | undefined,
): MovementRecord {
  return {
    id: `prompt-${args.sequenceNumber}`,
    sequenceNumber: args.sequenceNumber,
    userPrompt: args.userPrompt,
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
    durationMs: Date.now() - args.execStart,
    retryLog: retryLog && retryLog.length > 0 ? retryLog : undefined,
    ...(args.isAutoContinue && { isAutoContinue: true }),
  };
}

/** Build a MovementRecord representing a user-initiated cancel mid-run. */
export function buildCancelledMovement(
  result: HeadlessRunResult | undefined,
  args: MovementBuildArgs,
): MovementRecord {
  return {
    id: `prompt-${args.sequenceNumber}`,
    sequenceNumber: args.sequenceNumber,
    userPrompt: args.userPrompt,
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
    durationMs: Date.now() - args.execStart,
  };
}

/** Build a MovementRecord for a thrown error inside executePrompt. */
export function buildErrorMovement(errorMessage: string, args: MovementBuildArgs): MovementRecord {
  return {
    id: `prompt-${args.sequenceNumber}`,
    sequenceNumber: args.sequenceNumber,
    userPrompt: args.userPrompt,
    timestamp: new Date().toISOString(),
    tokensUsed: 0,
    summary: '',
    filesModified: [],
    errorOutput: errorMessage,
    durationMs: Date.now() - args.execStart,
  };
}

/**
 * Heuristic for auto-continuing "end_turn" runs that appear incomplete:
 * lots of thinking, not much visible output, and no tool work that
 * already justifies the short response.
 */
export function shouldAutoContinue(
  result: HeadlessRunResult,
  autoContinueCount: number,
  maxAutoContinues: number,
  cancelled: boolean,
): boolean {
  if (autoContinueCount >= maxAutoContinues) return false;
  if (cancelled) return false;
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
