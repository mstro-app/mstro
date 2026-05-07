// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * EngineEvent — the engine-agnostic event stream produced by every
 * CodingAgentEngine (see ./types.ts).
 *
 * Contract:
 * - Every event has a `kind` discriminator, a `sessionId` (the engine's own
 *   session identifier — Claude Code session id, OpenCode session id, etc.),
 *   and a `timestamp` in Unix ms.
 * - Payloads must carry enough information to populate OutputLine in the web
 *   client without the consumer knowing which engine produced them. Do not
 *   leak engine-specific fields (e.g. Claude tool_use_ids, OpenCode part ids)
 *   through typed event fields — keep them in `raw` when needed for debugging.
 * - Ordering is guaranteed within a single session: for a given tool call,
 *   `tool.start` precedes `tool.end`; `usage.update` values are monotonic.
 * - `session.idle` marks the end of a turn (assistant finished responding),
 *   not the end of the session. Multiple idle events per session are normal.
 * - `engine.error` with `fatal: true` is terminal — the async iterator must
 *   complete after emitting it.
 */

/** Identifier for which concrete engine produced an event. */
export type EngineId = 'claude-code' | 'opencode';

/** Fields shared by every engine event. */
interface EngineEventBase {
  /** Engine-reported session id (e.g. Claude Code session id, OpenCode session id). */
  sessionId: string;
  /** Unix epoch milliseconds when the engine observed this event. */
  timestamp: number;
  /** Optional raw payload from the engine for debugging/audit. Must not be used for business logic. */
  raw?: unknown;
}

/** Streaming assistant text (user-visible output). */
export interface MessageDeltaEvent extends EngineEventBase {
  kind: 'message.delta';
  /** Incremental chunk of assistant-visible text. Consumers concatenate. */
  text: string;
}

/** Streaming assistant thinking/reasoning text (collapsed by default in UI). */
export interface MessageThinkingEvent extends EngineEventBase {
  kind: 'message.thinking';
  /** Incremental chunk of thinking text. */
  text: string;
}

/** A tool invocation has started. */
export interface ToolStartEvent extends EngineEventBase {
  kind: 'tool.start';
  /** Engine-agnostic tool call id (unique within the session). */
  toolCallId: string;
  /** Name of the tool (e.g. "Read", "Bash"). */
  toolName: string;
  /**
   * Arguments passed to the tool. May be partial at start — some engines
   * stream arguments. Consumers should treat this as best-effort until
   * `tool.end` arrives with the authoritative input.
   */
  input: Record<string, unknown>;
}

/** A tool invocation has completed (successfully or with an error). */
export interface ToolEndEvent extends EngineEventBase {
  kind: 'tool.end';
  toolCallId: string;
  toolName: string;
  /** Authoritative tool input as executed. */
  input: Record<string, unknown>;
  /** Serialized tool result (stdout, file contents, JSON, etc.). */
  result: string;
  /** True if the tool returned an error. */
  isError: boolean;
  /** Wall-clock duration in ms between tool.start and tool.end. */
  durationMs: number;
}

/**
 * The engine is asking whether a tool call should proceed. Consumed by
 * the Bouncer in Epic 4 which must resolve the request via the engine's
 * matching permission-response channel.
 */
export interface PermissionRequestEvent extends EngineEventBase {
  kind: 'permission.request';
  /** Opaque id the engine will expect echoed back in a decision. */
  requestId: string;
  toolName: string;
  /** Tool arguments to be classified. */
  input: Record<string, unknown>;
  /** Engine-provided reason string, if any. */
  reason?: string;
}

/**
 * Session returned to idle — the assistant finished its current turn.
 * Not the end of the session; a new prompt may still be sent.
 */
export interface SessionIdleEvent extends EngineEventBase {
  kind: 'session.idle';
  /** Engine's stop reason if known (e.g. 'end_turn', 'max_tokens'). */
  stopReason?: string;
}

/**
 * Running token counts. Values are cumulative across the session
 * (not per-turn) and must be monotonically non-decreasing.
 */
export interface UsageUpdateEvent extends EngineEventBase {
  kind: 'usage.update';
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

/**
 * An engine-level error occurred. With `fatal: true`, the session is
 * unrecoverable and the async iterator completes after this event.
 */
export interface EngineErrorEvent extends EngineEventBase {
  kind: 'engine.error';
  /** Short error code for UI mapping (see ClaudeErrorCode in web/src/types/output.ts). */
  code: string;
  /** Human-readable message. */
  message: string;
  /** True if the session is unrecoverable and should be torn down. */
  fatal: boolean;
}

/** Discriminated union of every event a CodingAgentEngine may emit. */
export type EngineEvent =
  | MessageDeltaEvent
  | MessageThinkingEvent
  | ToolStartEvent
  | ToolEndEvent
  | PermissionRequestEvent
  | SessionIdleEvent
  | UsageUpdateEvent
  | EngineErrorEvent;

/** Narrow helper — returns true for events that carry user-visible text. */
export function isMessageEvent(
  event: EngineEvent,
): event is MessageDeltaEvent | MessageThinkingEvent {
  return event.kind === 'message.delta' || event.kind === 'message.thinking';
}

/** Narrow helper — returns true for the tool lifecycle events. */
export function isToolEvent(
  event: EngineEvent,
): event is ToolStartEvent | ToolEndEvent {
  return event.kind === 'tool.start' || event.kind === 'tool.end';
}
