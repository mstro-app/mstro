// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

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
// Main runner class
export { HeadlessRunner } from './runner.js';
// Types
export type {
  ExecutionResult,
  HeadlessConfig,
  ImageAttachment,
  ResolvedHeadlessConfig, 
  SessionResult,
  SessionState,
  ToolUseAccumulator,
  ToolUseEvent
} from './types.js';
