// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Headless Runner Types
 *
 * Shared type definitions for the headless execution system.
 */

export interface PromptContext {
  previousMovements?: string[];
  accumulatedKnowledge: string;
  filesModified: string[];
}

export interface ToolUseEvent {
  type: 'tool_start' | 'tool_input_delta' | 'tool_complete' | 'tool_result';
  toolName?: string;
  toolId?: string;
  index?: number;
  partialJson?: string;
  completeInput?: any;
  result?: string;
  isError?: boolean;
}

// Image attachment for multimodal prompts
export interface ImageAttachment {
  fileName: string;       // Display name (e.g., "screenshot.png")
  filePath: string;       // Full path on disk (for context)
  content: string;        // Base64 encoded image data
  isImage: boolean;       // Should always be true
  mimeType?: string;      // MIME type (e.g., "image/png")
}

export interface HeadlessConfig {
  workingDir: string;
  tokenBudgetThreshold: number;
  maxSessions: number;
  maxRetries: number;
  claudeCommand: string;
  verbose: boolean;
  noColor: boolean;
  improvisationMode?: boolean;
  movementNumber?: number;
  outputCallback?: (text: string) => void;
  thinkingCallback?: (text: string) => void;
  toolUseCallback?: (event: ToolUseEvent) => void;
  directPrompt?: string;
  promptContext?: PromptContext;
  continueSession?: boolean;
  claudeSessionId?: string;
  imageAttachments?: ImageAttachment[];
  stallWarningMs?: number;   // No stdout before warning (default: 300000 = 5 min)
  stallKillMs?: number;      // No stdout before kill (default: 1800000 = 30 min)
  stallAssessEnabled?: boolean; // Use Haiku to assess stalls (default: true)
  stallMaxExtensions?: number;  // Max number of Haiku-granted extensions (default: 3)
  stallHardCapMs?: number;     // Absolute wall-clock kill cap (default: 3600000 = 60 min)
  /** Claude model for main execution (e.g., 'opus', 'sonnet'). 'default' = no --model flag. */
  model?: string;
}

export interface SessionState {
  sessionId: string;
  sessionNumber: number;
  tokensUsed: number;
  checkpointPath: string;
  handoffGenerated: boolean;
  retryCount: number;
  status: 'running' | 'completed' | 'failed' | 'handoff';
}

export interface SessionResult {
  completed: boolean;
  needsHandoff: boolean;
  totalTokens: number;
  sessionId: string;
  error?: string;
  conflicts?: Array<{
    filePath: string;
    modifiedBy: string[];
    backupPath?: string;
  }>;
  assistantResponse?: string;
  thinkingOutput?: string;
  toolUseHistory?: Array<{
    toolName: string;
    toolId: string;
    toolInput: Record<string, unknown>;
    result?: string;
    isError?: boolean;
    duration?: number;
  }>;
  claudeSessionId?: string;
}

export interface ToolUseAccumulator {
  toolName: string;
  toolId: string;
  toolInput: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  startTime: number;
  duration?: number;
}

export interface ExecutionResult {
  output: string;
  error?: string;
  exitCode: number;
  assistantResponse?: string;
  thinkingOutput?: string;
  toolUseHistory?: ToolUseAccumulator[];
  claudeSessionId?: string;
}

/** Resolved config with all defaults applied */
export type ResolvedHeadlessConfig = Omit<Required<HeadlessConfig>, 'outputCallback' | 'thinkingCallback' | 'toolUseCallback' | 'continueSession' | 'claudeSessionId' | 'imageAttachments' | 'model'> & {
  outputCallback?: (text: string) => void;
  thinkingCallback?: (text: string) => void;
  toolUseCallback?: (event: ToolUseEvent) => void;
  continueSession?: boolean;
  claudeSessionId?: string;
  imageAttachments?: ImageAttachment[];
  model?: string;
};
