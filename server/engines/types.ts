// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * CodingAgentEngine — the contract every coding-agent backend must satisfy.
 *
 * An engine owns a single logical conversation with a coding agent (Claude
 * Code, OpenCode, …). Callers drive it via `startSession` + `sendPrompt`
 * + `cancel` and consume events by iterating the engine with `for await`.
 *
 * Lifecycle:
 *
 *   const engine = factory.create(engineId);
 *   await engine.startSession({ workingDir, model, ... });
 *   const consumer = (async () => {
 *     for await (const event of engine) { ... }
 *   })();
 *   await engine.sendPrompt("help me refactor X", []);
 *   // ... events flow: message.delta, tool.start, tool.end, session.idle
 *   await engine.sendPrompt("now write a test", []);
 *   // ... more events
 *   await engine.dispose();
 *   await consumer; // iterator completes after dispose
 *
 * Cancellation:
 * - `cancel()` aborts the in-flight turn (if any) and the iterator receives
 *   a final `session.idle` (or `engine.error` if the engine reports failure
 *   during cancellation). A new `sendPrompt` after cancel is permitted.
 *
 * Disposal:
 * - `dispose()` is terminal. It closes the engine session and completes the
 *   async iterator. Idempotent — safe to call multiple times.
 *
 * Error handling:
 * - Non-fatal errors are emitted as `engine.error` events and the session
 *   continues.
 * - A fatal `engine.error` (with `fatal: true`) completes the iterator; the
 *   caller should `dispose()` and construct a new engine to retry.
 *
 * Threading:
 * - No method may be called before `startSession` resolves.
 * - Only one `sendPrompt` may be in flight at a time; callers serialize.
 * - `cancel` and `dispose` are safe to call concurrently with `sendPrompt`.
 */

import type { EngineEvent, EngineId } from './EngineEvent.js';

/** Attachment payload passed through `sendPrompt`. Mirrors ImageAttachment in the headless runner. */
export interface PromptAttachment {
  /** Display name shown to the user (e.g. "screenshot.png"). */
  fileName: string;
  /** Absolute path on disk, for engines that prefer a path over base64. */
  filePath?: string;
  /** Base64-encoded content, for engines that require inline bytes. */
  base64Content?: string;
  /** MIME type (e.g. "image/png"). */
  mimeType?: string;
  /** True if this attachment is an image (vs. a text file). */
  isImage: boolean;
}

/** Options passed to `startSession`. Fields that aren't relevant to an engine are ignored. */
export interface StartSessionOptions {
  /** Working directory for file operations. Required. */
  workingDir: string;
  /**
   * Model identifier. Interpretation is engine-specific.
   * For Claude: 'opus' | 'sonnet' | 'default'. For OpenCode: provider/model slug.
   * Omit to use the engine's default.
   */
  model?: string;
  /**
   * Effort level (Claude-style: 'low' | 'medium' | 'high' | 'xhigh' | 'max').
   * Engines without an effort concept ignore this.
   */
  effortLevel?: string;
  /** Resume an existing engine session by id. Omit to start a fresh session. */
  resumeSessionId?: string;
  /** Tools to disallow for the entire session (engine-specific names). */
  disallowedTools?: string[];
  /**
   * Stricter bouncer patterns for end-user-driven deploy sessions.
   * Passed through to the MCP bouncer where applicable.
   */
  deployMode?: boolean;
  /** Extra env vars to merge into any child process the engine spawns. */
  extraEnv?: Record<string, string>;
}

/** Cumulative token usage for an engine session. Values are monotonically non-decreasing. */
export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  /** Unix ms of the last usage.update event, or session start if none yet. */
  lastUpdatedAt: number;
}

/**
 * The engine contract. Implementations wrap a specific backend (Claude Code
 * headless runner, OpenCode SDK, …) and expose a uniform event stream.
 *
 * Implementations MUST:
 * - Emit events in the order defined by EngineEvent's per-kind invariants.
 * - Tolerate `cancel`/`dispose` being called at any point after construction.
 * - Complete the async iterator when `dispose` is called or a fatal
 *   `engine.error` is emitted.
 */
export interface CodingAgentEngine extends AsyncIterable<EngineEvent> {
  /** Identifies which concrete engine this is. Stable across the session. */
  readonly engineId: EngineId;

  /**
   * Initialize the engine session. Must be called exactly once before any
   * other method. Throws if the engine cannot start (e.g. auth missing,
   * binary not found). Non-throwing failures during the session arrive as
   * `engine.error` events.
   */
  startSession(options: StartSessionOptions): Promise<void>;

  /**
   * Send a user turn. Resolves when the engine has accepted the prompt (not
   * when the turn completes — observe events for completion via
   * `session.idle`). Rejects if called before `startSession` or after
   * `dispose`, or while another prompt is still in flight.
   */
  sendPrompt(prompt: string, attachments?: PromptAttachment[]): Promise<void>;

  /**
   * Abort the in-flight turn. Safe to call when no turn is active (no-op).
   * The iterator will receive a terminal `session.idle` for the turn if one
   * was in flight. Does not dispose the session — further `sendPrompt`
   * calls remain valid.
   */
  cancel(): Promise<void>;

  /**
   * Snapshot of cumulative usage for this session. Cheap/synchronous —
   * engines must keep this in sync with the latest `usage.update` event.
   */
  getUsage(): EngineUsage;

  /**
   * Terminate the engine session, release all resources, and complete the
   * async iterator. Idempotent.
   */
  dispose(): Promise<void>;

  /** Async iteration over every EngineEvent this session produces. */
  [Symbol.asyncIterator](): AsyncIterator<EngineEvent>;
}

/**
 * Factory signature — Epic 1 implements a factory returning only
 * ClaudeCodeEngine; Epic 3 extends it to also return OpenCodeEngine.
 */
export type EngineFactory = (engineId: EngineId) => CodingAgentEngine;

// Re-export the event union and identifier type so consumers need only one import.
export type {
  EngineErrorEvent,
  EngineEvent,
  EngineId,
  MessageDeltaEvent,
  MessageThinkingEvent,
  PermissionRequestEvent,
  SessionIdleEvent,
  ToolEndEvent,
  ToolStartEvent,
  UsageUpdateEvent,
} from './EngineEvent.js';
export { isMessageEvent, isToolEvent } from './EngineEvent.js';
