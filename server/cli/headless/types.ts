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

/** Per-tool-type timeout configuration with adaptive tracking */
export interface ToolTimeoutProfile {
  /** Initial timeout when no prior samples exist (ms) */
  coldStartMs: number;
  /** Minimum timeout — never kill before this (ms) */
  floorMs: number;
  /** Maximum timeout — always kill after this (ms) */
  ceilingMs: number;
  /** Track EMA of past durations and adapt timeout dynamically */
  useAdaptive: boolean;
  /** Spawn a Haiku call to assess before killing */
  useHaikuTiebreaker: boolean;
}

/** Snapshot of execution state at the moment a tool times out */
export interface ExecutionCheckpoint {
  originalPrompt: string;
  assistantText: string;
  thinkingText: string;
  completedTools: Array<{
    toolName: string;
    toolId: string;
    input: Record<string, unknown>;
    result: string;
    isError: boolean;
    durationMs: number;
  }>;
  /** Tools that were still running (not the hung tool) when the process was killed */
  inProgressTools: Array<{
    toolName: string;
    toolId: string;
    input: Record<string, unknown>;
  }>;
  hungTool: {
    toolName: string;
    toolId: string;
    input: Record<string, unknown>;
    timeoutMs: number;
    url?: string;
  };
  claudeSessionId?: string;
  elapsedMs: number;
}

/** EMA tracker for a single tool type's completion times */
export interface ToolDurationTracker {
  estimatedDuration: number;
  deviation: number;
  sampleCount: number;
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
  /** Per-tool timeout profiles (merge with defaults) */
  toolTimeoutProfiles?: Record<string, Partial<ToolTimeoutProfile>>;
  /** Enable per-tool adaptive timeout watchdog (default: true) */
  enableToolWatchdog?: boolean;
  /** Max auto-retries on tool timeout (default: 2) */
  maxAutoRetries?: number;
  /** Called when a tool times out with checkpoint data */
  onToolTimeout?: (checkpoint: ExecutionCheckpoint) => void;
  /** When true, spawn Claude with sanitized env (strips secrets, HOME=workingDir) */
  sandboxed?: boolean;
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
  /** Number of Claude Code native tool timeouts detected during this execution */
  nativeTimeoutCount?: number;
  /** Assistant text buffered after native timeouts — not yet shown to user.
   *  Flush to output if context is OK, discard if context was lost and recovery starts. */
  postTimeoutOutput?: string;
  /** Assistant text buffered during resume assessment — held back until thinking/tool activity
   *  confirms Claude has context. Undefined when not in resume mode or buffer was flushed. */
  resumeBufferedOutput?: string;
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

/** Map of toolId -> toolName for currently pending (started but not yet returned) tools */
export type PendingToolMap = Map<string, string>;

export interface ExecutionResult {
  output: string;
  error?: string;
  exitCode: number;
  assistantResponse?: string;
  thinkingOutput?: string;
  toolUseHistory?: ToolUseAccumulator[];
  claudeSessionId?: string;
  /** Number of Claude Code native tool timeouts detected during this execution */
  nativeTimeoutCount?: number;
  /** Assistant text buffered after native timeouts — not yet sent to outputCallback.
   *  The session manager should flush this to the client if context is OK, or discard if recovering. */
  postTimeoutOutput?: string;
  /** Assistant text buffered during resume assessment — held back until thinking/tool activity
   *  confirms Claude has context. Undefined when not in resume mode or buffer was flushed. */
  resumeBufferedOutput?: string;
}

/** Resolved config with all defaults applied */
export type ResolvedHeadlessConfig = Omit<Required<HeadlessConfig>, 'outputCallback' | 'thinkingCallback' | 'toolUseCallback' | 'continueSession' | 'claudeSessionId' | 'imageAttachments' | 'model' | 'toolTimeoutProfiles' | 'onToolTimeout' | 'sandboxed'> & {
  outputCallback?: (text: string) => void;
  thinkingCallback?: (text: string) => void;
  toolUseCallback?: (event: ToolUseEvent) => void;
  continueSession?: boolean;
  claudeSessionId?: string;
  imageAttachments?: ImageAttachment[];
  model?: string;
  toolTimeoutProfiles?: Record<string, Partial<ToolTimeoutProfile>>;
  onToolTimeout?: (checkpoint: ExecutionCheckpoint) => void;
  sandboxed?: boolean;
};
