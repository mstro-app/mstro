// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Types and interfaces for the Improvisation Session Manager.
 */

import type { HeadlessRunner } from './headless/index.js';
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
  assistantResponse?: string;
  thinkingOutput?: string;
  toolUseHistory?: ToolUseRecord[];
  errorOutput?: string;
  durationMs?: number;
  retryLog?: RetryLogEntry[];
}

export interface SessionHistory {
  sessionId: string;
  startedAt: string;
  lastActivityAt: string;
  totalTokens: number;
  movements: MovementRecord[];
  claudeSessionId?: string;
}

/** Entry in the retry log for debugging recovery paths */
export interface RetryLogEntry {
  retryNumber: number;
  path: string;
  reason: string;
  timestamp: number;
  durationMs?: number;
}

/** Mutable state for the retry loop in executePrompt */
export interface RetryLoopState {
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
  retryLog: RetryLogEntry[];
}

/** Type alias for HeadlessRunner execution result */
export type HeadlessRunResult = Awaited<ReturnType<HeadlessRunner['run']>>;

/** Score a run result for best-result tracking (higher = more productive) */
export function scoreRunResult(r: HeadlessRunResult): number {
  const toolCount = r.toolUseHistory?.filter(t => t.result !== undefined && !t.isError).length ?? 0;
  const responseLen = Math.min((r.assistantResponse?.length ?? 0) / 50, 100);
  const hasThinking = r.thinkingOutput ? 20 : 0;
  return toolCount * 10 + responseLen + hasThinking;
}
