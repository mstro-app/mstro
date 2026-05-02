// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Headless Runner Module
 *
 * Re-exports all headless runner components for backward compatibility.
 */

export type { ClaudeInvokerOptions } from './claude-invoker.js';
export { executeClaudeCommand } from './claude-invoker.js';

// Utilities (for advanced usage)
export { generateMcpConfig } from './mcp-config.js';
export {
  detectErrorInStderr,
  ERROR_PATTERNS, 
  estimateTokensFromOutput,
  extractCleanOutput,
  extractModifiedFiles
} from './output-utils.js';
export {
  buildMultimodalMessage, 
  enrichPromptWithContext,
  isApprovalPrompt
} from './prompt-utils.js';
// Resilient runner (retry-aware wrapper)
export { ResilientRunner, type ResilientRunnerConfig, type RetryPolicy } from './resilient-runner.js';
// Main runner class
export { HeadlessRunner } from './runner.js';
// Tool watchdog
export { ToolWatchdog } from './tool-watchdog.js';
// Types
export type {
  ExecutionCheckpoint,
  ExecutionResult,
  HeadlessConfig,
  ImageAttachment,
  PendingToolMap,
  ResolvedHeadlessConfig,
  SessionResult,
  SessionState,
  ToolDurationTracker,
  ToolTimeoutProfile,
  ToolUseAccumulator,
  ToolUseEvent
} from './types.js';
