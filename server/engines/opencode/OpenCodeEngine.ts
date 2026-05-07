// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * OpenCodeEngine
 *
 * Adapter that wraps the OpenCode SDK (@opencode-ai/sdk) behind the
 * CodingAgentEngine interface. Owns a single OpenCode `session` per Mstro
 * improvisation:
 *
 * - `startSession` creates (or resumes) an OpenCode session and opens an
 *   SSE subscription to `/event`. A background pump consumes the stream
 *   and translates each payload into the engine-agnostic `EngineEvent`
 *   shape so the rest of the system does not need to know which engine
 *   produced the events.
 * - `sendPrompt` dispatches `session.promptAsync` and resolves as soon as
 *   the server has accepted the prompt. Streaming output arrives via SSE.
 * - `cancel` calls `session.abort`, which the OpenCode server eventually
 *   reflects back as a `session.idle` event.
 * - `dispose` stops the pump and deletes the underlying session.
 *
 * The concrete SSE → EngineEvent mapping is documented inline in
 * `handleSseEvent`.
 */

import type {
  AssistantMessage,
  Message,
  OpencodeClient,
  Part,
  Permission,
  ReasoningPart,
  Event as SseEvent,
  StepFinishPart,
  TextPart,
  ToolPart,
} from '@opencode-ai/sdk'
import {
  type BouncerDecision,
  type EnginePermissionReviewRequest,
  formatDenialMessage,
  reviewEnginePermission,
} from '../../mcp/bouncer-integration.js'
import type { EngineEvent, EngineId } from '../EngineEvent.js'
import type {
  CodingAgentEngine,
  EngineUsage,
  PromptAttachment,
  StartSessionOptions,
} from '../types.js'

/**
 * Bouncer entry-point signature. Exposed as an option on OpenCodeEngine so
 * tests can swap in a stub without patching module internals. Production
 * code passes `reviewEnginePermission` from bouncer-integration.ts, which
 * in turn calls {@link reviewOperation} — the single source of truth for
 * security decisions across every engine.
 */
export type ReviewEnginePermissionFn = (
  request: EnginePermissionReviewRequest,
) => Promise<BouncerDecision>

/**
 * Inferred type of the value returned by `OpencodeClient.event.subscribe()`.
 * We derive it from the SDK rather than importing the underlying
 * `ServerSentEventsResult` symbol so we don't depend on an internal SDK
 * module path that isn't part of its public exports map.
 */
type EventSubscription = Awaited<
  ReturnType<OpencodeClient['event']['subscribe']>
>

type Resolver = (r: IteratorResult<EngineEvent>) => void

/** Construction-time dependencies for {@link OpenCodeEngine}. */
export interface OpenCodeEngineOptions {
  /**
   * Typed SDK client, already bound to a running opencode server. Usually
   * obtained from `OpenCodeServerManager.getClient()`. Tests inject a
   * hand-rolled mock matching the subset of methods used here.
   */
  client: OpencodeClient
  /**
   * Directory query parameter forwarded to each request. OpenCode scopes
   * sessions and events by directory — the value is typically the same
   * working directory passed to `startSession`.
   */
  directory?: string
  /**
   * Override the bouncer review function. Defaults to
   * `reviewEnginePermission` from `cli/server/mcp/bouncer-integration.ts`
   * — which wraps the unified {@link reviewOperation} entry point used by
   * the Claude MCP path. Tests inject a stub to drive specific decisions.
   */
  reviewPermission?: ReviewEnginePermissionFn
}

/** Narrowing helper: OpenCode wraps the message union under `info`. */
function isAssistantMessage(msg: Message): msg is AssistantMessage {
  return msg.role === 'assistant'
}

/**
 * Token counts from `StepFinishPart` or the `AssistantMessage.tokens`
 * object. Both sources share the same shape.
 */
interface TokenCounts {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

export class OpenCodeEngine implements CodingAgentEngine {
  readonly engineId: EngineId = 'opencode'

  private readonly client: OpencodeClient
  private readonly directory: string | undefined
  private readonly reviewPermission: ReviewEnginePermissionFn

  private sessionOptions: StartSessionOptions | null = null
  private openCodeSessionId: string | undefined
  /** True once the caller has called `startSession` successfully. */
  private started = false

  /** Active SSE subscription returned by `client.event.subscribe()`. */
  private subscription: EventSubscription | null = null
  /** Background task consuming `subscription.stream`. */
  private pumpPromise: Promise<void> | null = null

  /** In-flight prompt promise — enforces the one-prompt-at-a-time contract. */
  private currentPromptPromise: Promise<void> | null = null

  private disposed = false
  private iteratorDone = false
  private readonly queue: EngineEvent[] = []
  private readonly pending: Resolver[] = []

  /**
   * Tool-call id → start timestamp. Populated on the first `running`
   * state of a ToolPart so we can compute `durationMs` when the part
   * transitions to `completed` or `error`.
   */
  private readonly toolStartTimes: Map<string, number> = new Map()
  /**
   * Tool-call ids we have already announced via `tool.start`. Prevents
   * duplicate starts when OpenCode emits multiple `running` updates.
   */
  private readonly toolStarted: Set<string> = new Set()

  private usage: EngineUsage = {
    inputTokens: 0,
    outputTokens: 0,
    lastUpdatedAt: Date.now(),
  }

  constructor(options: OpenCodeEngineOptions) {
    if (!options || !options.client) {
      throw new Error('OpenCodeEngine: client is required')
    }
    this.client = options.client
    this.directory = options.directory
    this.reviewPermission = options.reviewPermission ?? reviewEnginePermission
  }

  async startSession(options: StartSessionOptions): Promise<void> {
    if (this.started) {
      throw new Error('OpenCodeEngine: startSession called more than once')
    }
    if (this.disposed) {
      throw new Error('OpenCodeEngine: cannot start a disposed engine')
    }
    this.sessionOptions = options
    const dir = options.workingDir || this.directory

    if (options.resumeSessionId) {
      this.openCodeSessionId = options.resumeSessionId
    } else {
      const created = await this.client.session.create({
        query: dir ? { directory: dir } : undefined,
      })
      const session = extractData<{ id: string }>(created)
      if (!session || typeof session.id !== 'string') {
        throw new Error(
          'OpenCodeEngine: session.create did not return a session id',
        )
      }
      this.openCodeSessionId = session.id
    }

    this.subscription = await this.client.event.subscribe({
      query: dir ? { directory: dir } : undefined,
    })
    this.pumpPromise = this.runEventPump()
    this.started = true
  }

  async sendPrompt(
    prompt: string,
    _attachments?: PromptAttachment[],
  ): Promise<void> {
    if (!this.started || !this.openCodeSessionId) {
      throw new Error('OpenCodeEngine: sendPrompt called before startSession')
    }
    if (this.disposed) {
      throw new Error('OpenCodeEngine: sendPrompt called after dispose')
    }
    if (this.currentPromptPromise) {
      throw new Error('OpenCodeEngine: another prompt is already in flight')
    }

    const model = parseModel(this.sessionOptions?.model)
    const sendPromise = (async () => {
      const result = await this.client.session.promptAsync({
        path: { id: this.openCodeSessionId as string },
        query: this.directory ? { directory: this.directory } : undefined,
        body: {
          parts: [{ type: 'text', text: prompt }],
          ...(model ? { model } : {}),
        },
      })
      const err = extractError(result)
      if (err) {
        throw new Error(err)
      }
    })()

    this.currentPromptPromise = sendPromise
    try {
      await sendPromise
    } finally {
      this.currentPromptPromise = null
    }
  }

  async cancel(): Promise<void> {
    if (!this.openCodeSessionId || this.disposed) return
    try {
      await this.client.session.abort({
        path: { id: this.openCodeSessionId },
        query: this.directory ? { directory: this.directory } : undefined,
      })
    } catch (err) {
      // Swallow — the Bouncer/UI layer only cares that we asked. A real
      // failure surfaces as an `engine.error` emitted by the event pump.
      this.emit({
        kind: 'engine.error',
        sessionId: this.sessionIdForEvent(),
        timestamp: Date.now(),
        code: 'OPENCODE_ABORT_ERROR',
        message: err instanceof Error ? err.message : String(err),
        fatal: false,
      })
    }
  }

  getUsage(): EngineUsage {
    return { ...this.usage }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    // Stop the SSE pump. Calling `return()` on the generator is the
    // documented way to break a `for await` loop inside the pump.
    const sub = this.subscription
    this.subscription = null
    if (sub) {
      try {
        await sub.stream.return(undefined)
      } catch {
        // ignore — stream may already be exhausted
      }
    }

    if (this.pumpPromise) {
      try {
        await this.pumpPromise
      } catch {
        // pump errors are already surfaced as engine.error events
      }
      this.pumpPromise = null
    }

    // Best-effort session deletion. Failures are non-fatal at dispose.
    if (this.openCodeSessionId) {
      try {
        await this.client.session.delete({
          path: { id: this.openCodeSessionId },
          query: this.directory ? { directory: this.directory } : undefined,
        })
      } catch {
        // ignore
      }
    }

    this.closeIterator()
  }

  [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    return {
      next: (): Promise<IteratorResult<EngineEvent>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({
            value: this.queue.shift() as EngineEvent,
            done: false,
          })
        }
        if (this.iteratorDone) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise<IteratorResult<EngineEvent>>((resolve) => {
          this.pending.push(resolve)
        })
      },
      return: (): Promise<IteratorResult<EngineEvent>> => {
        this.closeIterator()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }

  // ---------- private ----------

  private sessionIdForEvent(): string {
    return this.openCodeSessionId ?? 'pending'
  }

  private emit(event: EngineEvent): void {
    if (this.iteratorDone) return
    const resolver = this.pending.shift()
    if (resolver) {
      resolver({ value: event, done: false })
    } else {
      this.queue.push(event)
    }
    if (event.kind === 'engine.error' && event.fatal) {
      this.closeIterator()
    }
  }

  private closeIterator(): void {
    if (this.iteratorDone) return
    this.iteratorDone = true
    const waiting = this.pending.splice(0)
    for (const resolve of waiting) {
      resolve({ value: undefined, done: true })
    }
  }

  /**
   * Long-running task that consumes the SSE stream. Exits when the stream
   * ends naturally (dispose called `stream.return()`) or when an error
   * propagates out of the generator.
   */
  private async runEventPump(): Promise<void> {
    const sub = this.subscription
    if (!sub) return
    try {
      for await (const event of sub.stream) {
        if (this.disposed) break
        this.handleSseEvent(event)
      }
    } catch (err) {
      if (this.disposed) return
      const message = err instanceof Error ? err.message : String(err)
      this.emit({
        kind: 'engine.error',
        sessionId: this.sessionIdForEvent(),
        timestamp: Date.now(),
        code: 'OPENCODE_EVENT_STREAM_ERROR',
        message,
        fatal: true,
      })
    }
  }

  /**
   * Core mapping from OpenCode SSE events to EngineEvents.
   *
   * - message.part.updated (TextPart)        → message.delta
   * - message.part.updated (ReasoningPart)   → message.thinking
   * - message.part.updated (ToolPart running) → tool.start  (once per callID)
   * - message.part.updated (ToolPart done)    → tool.end
   * - message.part.updated (StepFinishPart)   → usage.update
   * - message.updated (AssistantMessage)     → usage.update (if tokens set)
   * - permission.updated                     → permission.request
   * - session.idle                           → session.idle
   * - session.error                          → engine.error
   *
   * Events for sessions other than the one we own are ignored so that a
   * shared server emitting events for multiple clients does not cross
   * streams.
   */
  private handleSseEvent(event: SseEvent): void {
    if (!this.openCodeSessionId) return
    const ours = belongsToSession(event, this.openCodeSessionId)
    if (!ours) return

    switch (event.type) {
      case 'message.part.updated':
        this.handlePartUpdated(event.properties.part, event.properties.delta)
        return

      case 'message.updated':
        this.handleMessageUpdated(event.properties.info)
        return

      case 'permission.updated': {
        const p = event.properties
        // Emit the observability event first so consumers (UI, audit) see
        // the permission request before the Bouncer decision arrives.
        this.emit({
          kind: 'permission.request',
          sessionId: this.sessionIdForEvent(),
          timestamp: Date.now(),
          raw: p,
          requestId: p.id,
          toolName: p.type,
          input: (p.metadata ?? {}) as Record<string, unknown>,
          reason: p.title,
        })
        // Fire-and-forget: resolve via the Bouncer, respond through the
        // SDK, and — on denial — emit a user-visible engine.error. We do
        // not block the SSE pump on this async work so other events from
        // the same stream continue to flow.
        void this.resolvePermission(p)
        return
      }

      case 'session.idle':
        this.emit({
          kind: 'session.idle',
          sessionId: this.sessionIdForEvent(),
          timestamp: Date.now(),
        })
        return

      case 'session.error': {
        const errObj = event.properties.error
        const msg =
          errObj && 'data' in errObj && errObj.data && 'message' in errObj.data
            ? String((errObj.data as { message?: unknown }).message ?? '')
            : errObj?.name ?? 'OpenCode session error'
        this.emit({
          kind: 'engine.error',
          sessionId: this.sessionIdForEvent(),
          timestamp: Date.now(),
          raw: errObj,
          code: errObj?.name ?? 'OPENCODE_SESSION_ERROR',
          message: msg,
          fatal: false,
        })
        return
      }

      default:
        return
    }
  }

  /**
   * Route an OpenCode `permission.updated` through the unified Bouncer
   * and respond to the SDK so the server never hangs waiting.
   *
   * Contract:
   * - Approval (allow / warn_allow) → SDK `{ response: 'once' }`.
   * - Denial (deny)                 → SDK `{ response: 'reject' }` *and*
   *   a user-visible `engine.error` carrying the same message the Claude
   *   MCP path returns on a deny (see `cli/server/mcp/server.ts`), so
   *   both engines surface denials with identical wording.
   *
   * Any error — bouncer failure, SDK failure — is treated as a deny for
   * safety: we tell OpenCode `reject`, emit an engine.error, and keep the
   * session alive (non-fatal).
   */
  private async resolvePermission(permission: Permission): Promise<void> {
    if (this.disposed) return
    const sessionId = this.openCodeSessionId
    if (!sessionId) return

    const decision = await this.reviewPermissionSafely(permission, sessionId)
    const approved = decision.decision !== 'deny'
    const response: 'once' | 'reject' = approved ? 'once' : 'reject'

    try {
      await this.client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permission.id },
        body: { response },
        query: this.directory ? { directory: this.directory } : undefined,
      })
    } catch (err) {
      if (this.disposed) return
      this.emit({
        kind: 'engine.error',
        sessionId: this.sessionIdForEvent(),
        timestamp: Date.now(),
        code: 'OPENCODE_PERMISSION_RESPOND_ERROR',
        message: err instanceof Error ? err.message : String(err),
        fatal: false,
        raw: { permissionId: permission.id, response },
      })
      // Without a successful respond, OpenCode will time out on its side.
      // Still emit the denial event below if this was a deny decision so
      // the user sees why their operation was blocked.
    }

    if (!approved && !this.disposed) {
      this.emit({
        kind: 'engine.error',
        sessionId: this.sessionIdForEvent(),
        timestamp: Date.now(),
        code: 'BOUNCER_DENIED',
        message: formatDenialMessage(decision),
        fatal: false,
        raw: { permissionId: permission.id, toolName: permission.type, decision },
      })
    }
  }

  private async reviewPermissionSafely(
    permission: Permission,
    sessionId: string,
  ): Promise<BouncerDecision> {
    try {
      return await this.reviewPermission({
        toolName: permission.type,
        input: (permission.metadata ?? {}) as Record<string, unknown>,
        context: {
          purpose: 'OpenCode permission request',
          workingDirectory: this.directory ?? this.sessionOptions?.workingDir,
          sessionId,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        decision: 'deny',
        confidence: 0,
        reasoning: `Security analysis failed: ${message}. Denying for safety.`,
        threatLevel: 'critical',
      }
    }
  }

  private handlePartUpdated(part: Part, delta: string | undefined): void {
    switch (part.type) {
      case 'text':
        this.onTextPart(part, delta)
        return
      case 'reasoning':
        this.onReasoningPart(part, delta)
        return
      case 'tool':
        this.onToolPart(part)
        return
      case 'step-finish':
        this.onStepFinish(part)
        return
      default:
        return
    }
  }

  private onTextPart(part: TextPart, delta: string | undefined): void {
    // OpenCode sets `delta` to the incremental chunk. Fall back to the
    // full text if `delta` is absent and this is the first time we see
    // this part id (best effort — the contract only requires the text
    // be eventually concatenable).
    const text = delta ?? ''
    if (!text) return
    this.emit({
      kind: 'message.delta',
      sessionId: this.sessionIdForEvent(),
      timestamp: Date.now(),
      text,
      raw: part,
    })
  }

  private onReasoningPart(
    part: ReasoningPart,
    delta: string | undefined,
  ): void {
    const text = delta ?? ''
    if (!text) return
    this.emit({
      kind: 'message.thinking',
      sessionId: this.sessionIdForEvent(),
      timestamp: Date.now(),
      text,
      raw: part,
    })
  }

  private onToolPart(part: ToolPart): void {
    const callId = part.callID
    if (!callId) return
    const status = part.state.status
    if (status === 'running' || status === 'pending') {
      this.emitToolStartOnce(callId, part)
      return
    }
    if (status === 'completed' || status === 'error') {
      this.emitToolStartOnce(callId, part)
      this.emitToolEnd(callId, part)
    }
  }

  private emitToolStartOnce(callId: string, part: ToolPart): void {
    if (this.toolStarted.has(callId)) return
    const now = Date.now()
    this.toolStarted.add(callId)
    this.toolStartTimes.set(callId, now)
    this.emit({
      kind: 'tool.start',
      sessionId: this.sessionIdForEvent(),
      timestamp: now,
      toolCallId: callId,
      toolName: part.tool,
      input: (part.state.input ?? {}) as Record<string, unknown>,
      raw: part,
    })
  }

  private emitToolEnd(callId: string, part: ToolPart): void {
    const state = part.state
    const now = Date.now()
    const start = this.toolStartTimes.get(callId) ?? now
    const isError = state.status === 'error'
    const result = isError
      ? (state as { error: string }).error
      : (state as { output: string }).output
    this.emit({
      kind: 'tool.end',
      sessionId: this.sessionIdForEvent(),
      timestamp: now,
      toolCallId: callId,
      toolName: part.tool,
      input: (state.input ?? {}) as Record<string, unknown>,
      result: result ?? '',
      isError,
      durationMs: Math.max(0, now - start),
      raw: part,
    })
    this.toolStartTimes.delete(callId)
    // Keep `toolStarted` set so late duplicate `running` updates are
    // deduped rather than spawning a new tool.start for a finished call.
  }

  private onStepFinish(part: StepFinishPart): void {
    this.applyTokens(part.tokens, part)
  }

  private handleMessageUpdated(msg: Message): void {
    if (!isAssistantMessage(msg)) return
    if (!msg.tokens) return
    this.applyTokens(msg.tokens, msg)
  }

  private applyTokens(tokens: TokenCounts, raw: unknown): void {
    const input = tokens.input ?? 0
    const output = tokens.output ?? 0
    const cacheRead = tokens.cache?.read ?? 0
    const cacheWrite = tokens.cache?.write ?? 0
    // Contract: usage values are monotonically non-decreasing. If this
    // update regresses any counter, keep the running maximum.
    const nextInput = Math.max(input, this.usage.inputTokens)
    const nextOutput = Math.max(output, this.usage.outputTokens)
    const nextCacheRead = Math.max(
      cacheRead,
      this.usage.cacheReadTokens ?? 0,
    )
    const nextCacheWrite = Math.max(
      cacheWrite,
      this.usage.cacheCreationTokens ?? 0,
    )
    const changed =
      nextInput !== this.usage.inputTokens ||
      nextOutput !== this.usage.outputTokens ||
      nextCacheRead !== (this.usage.cacheReadTokens ?? 0) ||
      nextCacheWrite !== (this.usage.cacheCreationTokens ?? 0)
    if (!changed) return

    this.usage = {
      inputTokens: nextInput,
      outputTokens: nextOutput,
      cacheReadTokens: nextCacheRead,
      cacheCreationTokens: nextCacheWrite,
      lastUpdatedAt: Date.now(),
    }
    this.emit({
      kind: 'usage.update',
      sessionId: this.sessionIdForEvent(),
      timestamp: Date.now(),
      inputTokens: nextInput,
      outputTokens: nextOutput,
      cacheReadTokens: nextCacheRead,
      cacheCreationTokens: nextCacheWrite,
      raw,
    })
  }
}

/**
 * Returns the session id carried by an SSE event, or `undefined` if the
 * event is global/unrelated. Used to filter events for the session we own.
 */
function belongsToSession(event: SseEvent, ownSessionId: string): boolean {
  switch (event.type) {
    case 'message.part.updated':
      return event.properties.part.sessionID === ownSessionId
    case 'message.updated':
      return event.properties.info.sessionID === ownSessionId
    case 'permission.updated':
      return event.properties.sessionID === ownSessionId
    case 'session.idle':
      return event.properties.sessionID === ownSessionId
    case 'session.error':
      // sessionID is optional on error events. If absent, treat as ours.
      return (
        !event.properties.sessionID ||
        event.properties.sessionID === ownSessionId
      )
    default:
      return false
  }
}

/**
 * Parse the `model` option string into OpenCode's `{ providerID, modelID }`
 * shape. Accepts `"provider/model"` slugs (documented format in
 * StartSessionOptions). Returns `undefined` for unparseable input so the
 * server falls back to its default model.
 */
function parseModel(
  modelString: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (!modelString) return undefined
  const slashIndex = modelString.indexOf('/')
  if (slashIndex <= 0 || slashIndex === modelString.length - 1) {
    return undefined
  }
  return {
    providerID: modelString.slice(0, slashIndex),
    modelID: modelString.slice(slashIndex + 1),
  }
}

/**
 * The SDK client returns `{ data, error, response, request }` by default.
 * Pull out `data` regardless of whether the caller configured ThrowOnError.
 */
function extractData<T>(result: unknown): T | undefined {
  if (result && typeof result === 'object' && 'data' in result) {
    return (result as { data?: T }).data
  }
  return result as T
}

/**
 * Return the error message from an SDK response, or `undefined` if the
 * call succeeded. Mirrors `extractData` for the error channel.
 */
function extractError(result: unknown): string | undefined {
  if (
    result &&
    typeof result === 'object' &&
    'error' in result &&
    (result as { error?: unknown }).error
  ) {
    const err = (result as { error: unknown }).error
    if (err && typeof err === 'object' && 'data' in err) {
      const data = (err as { data?: unknown }).data
      if (data && typeof data === 'object' && 'message' in data) {
        return String((data as { message?: unknown }).message ?? 'OpenCode error')
      }
    }
    return err instanceof Error ? err.message : JSON.stringify(err)
  }
  return undefined
}
