// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Engine-contract tests for OpenCodeEngine.
 *
 * Mirrors the structure of `engine-contract.test.ts` (Claude Code) but
 * drives a mocked OpenCode SDK client instead of a real server. Each
 * scenario feeds SSE events into a hand-rolled async generator that the
 * engine consumes, then asserts the resulting EngineEvent stream.
 *
 * No real `opencode` subprocess is spawned; no network is touched.
 */

import type {
  OpencodeClient,
  Part,
  Event as SseEvent,
} from '@opencode-ai/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  EngineEvent,
  MessageDeltaEvent,
  PermissionRequestEvent,
  ToolEndEvent,
  ToolStartEvent,
  UsageUpdateEvent,
} from '../EngineEvent.js'
import { OpenCodeEngine } from './OpenCodeEngine.js'

// ---------- SSE stream harness ----------

/**
 * A controllable async generator used as the mock `subscription.stream`.
 * Tests push canned SSE events via `push` and close the stream with
 * `end`. The generator yields events in FIFO order and, when closed,
 * drains any pending backlog before terminating.
 */
interface FakeStream {
  push: (event: SseEvent) => void
  end: () => void
  stream: AsyncGenerator<SseEvent, void, void>
}

function makeFakeStream(): FakeStream {
  const backlog: SseEvent[] = []
  const waiters: Array<
    (r: IteratorResult<SseEvent, void>) => void
  > = []
  let closed = false

  const push = (event: SseEvent): void => {
    if (closed) return
    const waiter = waiters.shift()
    if (waiter) {
      waiter({ value: event, done: false })
    } else {
      backlog.push(event)
    }
  }

  const drain = (): void => {
    while (waiters.length > 0) {
      const w = waiters.shift()
      w?.({ value: undefined, done: true })
    }
  }

  const end = (): void => {
    if (closed) return
    closed = true
    drain()
  }

  /**
   * Implement AsyncGenerator explicitly so `return()` immediately resolves
   * any pending `next()` waiters. With a `async function*`-based generator
   * the outer `return()` cannot unblock an inner `await` on an unresolved
   * promise, which deadlocks dispose() in tests.
   */
  const stream: AsyncGenerator<SseEvent, void, void> = {
    [Symbol.asyncIterator]() {
      return this
    },
    async [Symbol.asyncDispose]() {
      closed = true
      drain()
    },
    next(): Promise<IteratorResult<SseEvent, void>> {
      if (backlog.length > 0) {
        return Promise.resolve({
          value: backlog.shift() as SseEvent,
          done: false,
        })
      }
      if (closed) return Promise.resolve({ value: undefined, done: true })
      return new Promise<IteratorResult<SseEvent, void>>((resolve) => {
        waiters.push(resolve)
      })
    },
    return(_value?: undefined): Promise<IteratorResult<SseEvent, void>> {
      closed = true
      drain()
      return Promise.resolve({ value: undefined, done: true })
    },
    throw(err: unknown): Promise<IteratorResult<SseEvent, void>> {
      closed = true
      drain()
      return Promise.reject(err)
    },
  }

  return { push, end, stream }
}

/** Typed helper for building SSE events. */
function sse<T extends SseEvent>(event: T): SseEvent {
  return event
}

// ---------- mock client builder ----------

interface MockClientState {
  sessionId: string
  stream: FakeStream
  abortCalls: Array<{ id: string }>
  deleteCalls: Array<{ id: string }>
  promptCalls: Array<{ id: string; parts: unknown }>
  // Resolver for the next promptAsync call — left undefined for normal
  // "accept prompt and return 204" behavior.
  nextPromptResult?: Promise<unknown>
  promptError?: unknown
}

function makeMockClient(
  overrides: Partial<MockClientState> = {},
): { client: OpencodeClient; state: MockClientState } {
  const state: MockClientState = {
    sessionId: overrides.sessionId ?? 'oc-sess-1',
    stream: overrides.stream ?? makeFakeStream(),
    abortCalls: overrides.abortCalls ?? [],
    deleteCalls: overrides.deleteCalls ?? [],
    promptCalls: overrides.promptCalls ?? [],
    nextPromptResult: overrides.nextPromptResult,
    promptError: overrides.promptError,
  }

  const client = {
    event: {
      subscribe: vi.fn(async () => ({ stream: state.stream.stream })),
    },
    session: {
      create: vi.fn(async () => ({ data: { id: state.sessionId } })),
      promptAsync: vi.fn(
        async (opts: { path: { id: string }; body: { parts: unknown } }) => {
          state.promptCalls.push({
            id: opts.path.id,
            parts: opts.body.parts,
          })
          if (state.promptError) throw state.promptError
          if (state.nextPromptResult) return state.nextPromptResult
          return { data: undefined }
        },
      ),
      abort: vi.fn(async (opts: { path: { id: string } }) => {
        state.abortCalls.push({ id: opts.path.id })
        return { data: true }
      }),
      delete: vi.fn(async (opts: { path: { id: string } }) => {
        state.deleteCalls.push({ id: opts.path.id })
        return { data: true }
      }),
    },
  } as unknown as OpencodeClient

  return { client, state }
}

// ---------- collector ----------

/** Collect engine events until `predicate` returns true or times out. */
async function collectUntil(
  engine: AsyncIterable<EngineEvent>,
  predicate: (event: EngineEvent) => boolean,
  timeoutMs = 2000,
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  const iter = engine[Symbol.asyncIterator]()
  const deadline = Date.now() + timeoutMs

  while (true) {
    const remaining = Math.max(0, deadline - Date.now())
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), remaining)
    })
    const raced = await Promise.race([iter.next(), timeoutPromise])
    if (raced === 'timeout') {
      throw new Error(
        `collectUntil: timed out after ${timeoutMs}ms; collected ${events.length} events: ${JSON.stringify(events)}`,
      )
    }
    if (raced.done) return events
    events.push(raced.value)
    if (predicate(raced.value)) return events
  }
}

/** Base fields every part carries. Tests override the rest inline. */
function partBase(overrides: Partial<Part> = {}): {
  id: string
  sessionID: string
  messageID: string
} {
  return {
    id: overrides.id ?? 'part-1',
    sessionID:
      ('sessionID' in overrides && overrides.sessionID) ||
      'oc-sess-1',
    messageID:
      ('messageID' in overrides && overrides.messageID) || 'msg-1',
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

// ---------- contract tests ----------

describe('OpenCodeEngine — CodingAgentEngine contract', () => {
  it('startSession creates an OpenCode session and subscribes to events', async () => {
    const { client, state } = makeMockClient()
    const engine = new OpenCodeEngine({ client })

    expect(engine.engineId).toBe('opencode')

    await engine.startSession({ workingDir: '/tmp' })

    expect(client.session.create).toHaveBeenCalledTimes(1)
    expect(client.event.subscribe).toHaveBeenCalledTimes(1)
    expect(state.sessionId).toBe('oc-sess-1')

    state.stream.end()
    await engine.dispose()
  })

  it('resumeSessionId skips session creation and reuses the id', async () => {
    const { client } = makeMockClient()
    const engine = new OpenCodeEngine({ client })

    await engine.startSession({
      workingDir: '/tmp',
      resumeSessionId: 'oc-existing',
    })

    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.event.subscribe).toHaveBeenCalledTimes(1)

    // sendPrompt should target the resumed session id.
    await engine.sendPrompt('hi')
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: 'oc-existing' } }),
    )
  })

  it('maps message.part.updated (TextPart) delta to message.delta events', async () => {
    const { client, state } = makeMockClient()
    const engine = new OpenCodeEngine({ client })
    await engine.startSession({ workingDir: '/tmp' })

    const collector = collectUntil(
      engine,
      (ev) => ev.kind === 'session.idle',
    )
    await engine.sendPrompt('say hello')

    state.stream.push(
      sse({
        type: 'message.part.updated',
        properties: {
          part: {
            ...partBase(),
            type: 'text',
            text: 'Hello ',
          },
          delta: 'Hello ',
        },
      }),
    )
    state.stream.push(
      sse({
        type: 'message.part.updated',
        properties: {
          part: {
            ...partBase(),
            type: 'text',
            text: 'Hello world',
          },
          delta: 'world',
        },
      }),
    )
    state.stream.push(
      sse({
        type: 'session.idle',
        properties: { sessionID: 'oc-sess-1' },
      }),
    )

    const events = await collector
    const deltas = events.filter(
      (e): e is MessageDeltaEvent => e.kind === 'message.delta',
    )
    expect(deltas.map((d) => d.text).join('')).toBe('Hello world')

    for (const ev of events) {
      expect(typeof ev.timestamp).toBe('number')
      expect(ev.sessionId).toBe('oc-sess-1')
    }

    await engine.dispose()
  })

  it('emits tool.start once then tool.end with call id, input, and result', async () => {
    const { client, state } = makeMockClient()
    const engine = new OpenCodeEngine({ client })
    await engine.startSession({ workingDir: '/tmp' })

    const collector = collectUntil(
      engine,
      (ev) => ev.kind === 'session.idle',
    )
    await engine.sendPrompt('read /tmp/x.txt')

    // Two running updates exercise the dedupe rule: only one tool.start.
    state.stream.push(
      sse({
        type: 'message.part.updated',
        properties: {
          part: {
            ...partBase({ id: 'part-tool' }),
            type: 'tool',
            callID: 'call-abc',
            tool: 'read',
            state: {
              status: 'running',
              input: { file_path: '/tmp/x.txt' },
              time: { start: 1 },
            },
          },
        },
      }),
    )
    state.stream.push(
      sse({
        type: 'message.part.updated',
        properties: {
          part: {
            ...partBase({ id: 'part-tool' }),
            type: 'tool',
            callID: 'call-abc',
            tool: 'read',
            state: {
              status: 'running',
              input: { file_path: '/tmp/x.txt' },
              time: { start: 1 },
            },
          },
        },
      }),
    )
    state.stream.push(
      sse({
        type: 'message.part.updated',
        properties: {
          part: {
            ...partBase({ id: 'part-tool' }),
            type: 'tool',
            callID: 'call-abc',
            tool: 'read',
            state: {
              status: 'completed',
              input: { file_path: '/tmp/x.txt' },
              output: 'file contents',
              title: 'Read /tmp/x.txt',
              metadata: {},
              time: { start: 1, end: 2 },
            },
          },
        },
      }),
    )
    state.stream.push(
      sse({
        type: 'session.idle',
        properties: { sessionID: 'oc-sess-1' },
      }),
    )

    const events = await collector
    const starts = events.filter(
      (e): e is ToolStartEvent => e.kind === 'tool.start',
    )
    const ends = events.filter(
      (e): e is ToolEndEvent => e.kind === 'tool.end',
    )

    expect(starts).toHaveLength(1)
    expect(ends).toHaveLength(1)
    const start = starts[0]
    const end = ends[0]

    expect(start.toolCallId).toBe('call-abc')
    expect(start.toolName).toBe('read')
    expect(end.toolCallId).toBe('call-abc')
    expect(end.toolName).toBe('read')
    expect(end.input).toEqual({ file_path: '/tmp/x.txt' })
    expect(end.result).toBe('file contents')
    expect(end.isError).toBe(false)
    expect(end.durationMs).toBeGreaterThanOrEqual(0)

    expect(events.indexOf(start)).toBeLessThan(events.indexOf(end))

    await engine.dispose()
  })

  it('maps permission.updated to permission.request events', async () => {
    const { client, state } = makeMockClient()
    const engine = new OpenCodeEngine({ client })
    await engine.startSession({ workingDir: '/tmp' })

    const collector = collectUntil(
      engine,
      (ev) => ev.kind === 'permission.request',
    )

    state.stream.push(
      sse({
        type: 'permission.updated',
        properties: {
          id: 'perm-xyz',
          type: 'bash',
          pattern: 'rm *',
          sessionID: 'oc-sess-1',
          messageID: 'msg-1',
          callID: 'call-abc',
          title: 'Execute shell command',
          metadata: { command: 'rm -rf /tmp/x' },
          time: { created: 123 },
        },
      }),
    )

    const events = await collector
    const perm = events.find(
      (e): e is PermissionRequestEvent => e.kind === 'permission.request',
    )
    expect(perm).toBeDefined()
    if (!perm) throw new Error('expected permission event')
    expect(perm.requestId).toBe('perm-xyz')
    expect(perm.toolName).toBe('bash')
    expect(perm.input).toEqual({ command: 'rm -rf /tmp/x' })

    await engine.dispose()
  })

  it('emits session.idle for OpenCode session.idle events', async () => {
    const { client, state } = makeMockClient()
    const engine = new OpenCodeEngine({ client })
    await engine.startSession({ workingDir: '/tmp' })

    const collector = collectUntil(
      engine,
      (ev) => ev.kind === 'session.idle',
    )
    state.stream.push(
      sse({
        type: 'session.idle',
        properties: { sessionID: 'oc-sess-1' },
      }),
    )

    const events = await collector
    const idle = events.find((e) => e.kind === 'session.idle')
    expect(idle).toBeDefined()
    expect(idle?.sessionId).toBe('oc-sess-1')

    await engine.dispose()
  })

  it('extracts token usage from message parts and keeps getUsage() in sync', async () => {
    const { client, state } = makeMockClient()
    const engine = new OpenCodeEngine({ client })
    await engine.startSession({ workingDir: '/tmp' })

    expect(engine.getUsage()).toEqual(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0 }),
    )

    const collector = collectUntil(
      engine,
      (ev) => ev.kind === 'session.idle',
    )

    // First usage report via StepFinishPart.
    state.stream.push(
      sse({
        type: 'message.part.updated',
        properties: {
          part: {
            ...partBase({ id: 'step-1' }),
            type: 'step-finish',
            reason: 'stop',
            cost: 0,
            tokens: {
              input: 100,
              output: 50,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        },
      }),
    )
    // Second usage report via another StepFinishPart — counters grow.
    state.stream.push(
      sse({
        type: 'message.part.updated',
        properties: {
          part: {
            ...partBase({ id: 'step-2' }),
            type: 'step-finish',
            reason: 'stop',
            cost: 0,
            tokens: {
              input: 120,
              output: 80,
              reasoning: 0,
              cache: { read: 10, write: 5 },
            },
          },
        },
      }),
    )
    state.stream.push(
      sse({
        type: 'session.idle',
        properties: { sessionID: 'oc-sess-1' },
      }),
    )

    const events = await collector
    const usages = events.filter(
      (e): e is UsageUpdateEvent => e.kind === 'usage.update',
    )
    expect(usages).toHaveLength(2)
    expect(usages[0].inputTokens).toBe(100)
    expect(usages[0].outputTokens).toBe(50)
    expect(usages[1].inputTokens).toBe(120)
    expect(usages[1].outputTokens).toBe(80)
    expect(usages[1].cacheReadTokens).toBe(10)
    expect(usages[1].cacheCreationTokens).toBe(5)

    // Monotonic non-decreasing.
    expect(usages[1].inputTokens).toBeGreaterThanOrEqual(
      usages[0].inputTokens,
    )
    expect(usages[1].outputTokens).toBeGreaterThanOrEqual(
      usages[0].outputTokens,
    )

    const snapshot = engine.getUsage()
    expect(snapshot.inputTokens).toBe(120)
    expect(snapshot.outputTokens).toBe(80)

    await engine.dispose()
  })

  it('cancel() calls session.abort on the underlying SDK', async () => {
    const { client, state } = makeMockClient()
    const engine = new OpenCodeEngine({ client })
    await engine.startSession({ workingDir: '/tmp' })
    await engine.sendPrompt('long running')

    await engine.cancel()

    expect(client.session.abort).toHaveBeenCalledTimes(1)
    expect(state.abortCalls).toEqual([{ id: 'oc-sess-1' }])

    await engine.dispose()
  })

  it('dispose() deletes the OpenCode session, stops the pump, and completes the iterator', async () => {
    const { client, state } = makeMockClient()
    const engine = new OpenCodeEngine({ client })
    await engine.startSession({ workingDir: '/tmp' })

    // Start iterating in the background; dispose should complete it.
    const iter = engine[Symbol.asyncIterator]()
    const nextPromise = iter.next()

    await engine.dispose()
    const done = await nextPromise
    expect(done.done).toBe(true)

    expect(client.session.delete).toHaveBeenCalledTimes(1)
    expect(state.deleteCalls).toEqual([{ id: 'oc-sess-1' }])

    // Subsequent dispose is a no-op.
    await engine.dispose()
    expect(client.session.delete).toHaveBeenCalledTimes(1)
  })

  it('sendPrompt is rejected when another prompt is still in flight', async () => {
    const { client, state } = makeMockClient()
    let resolveFirst: ((v: unknown) => void) | undefined
    state.nextPromptResult = new Promise((r) => {
      resolveFirst = r
    })
    const engine = new OpenCodeEngine({ client })
    await engine.startSession({ workingDir: '/tmp' })

    const first = engine.sendPrompt('one')
    await expect(engine.sendPrompt('two')).rejects.toThrow(
      /already in flight/,
    )

    resolveFirst?.({ data: undefined })
    await first
    // After the first resolves, a new prompt is accepted.
    state.nextPromptResult = undefined
    await engine.sendPrompt('two')
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2)

    await engine.dispose()
  })

  it('session.error events surface as non-fatal engine.error', async () => {
    const { client, state } = makeMockClient()
    const engine = new OpenCodeEngine({ client })
    await engine.startSession({ workingDir: '/tmp' })

    const collector = collectUntil(engine, (ev) => ev.kind === 'engine.error')
    state.stream.push(
      sse({
        type: 'session.error',
        properties: {
          sessionID: 'oc-sess-1',
          error: {
            name: 'APIError',
            data: {
              message: 'rate limited',
              isRetryable: true,
            },
          },
        },
      }),
    )

    const events = await collector
    const err = events.find((e) => e.kind === 'engine.error')
    expect(err).toBeDefined()
    if (err?.kind === 'engine.error') {
      expect(err.code).toBe('APIError')
      expect(err.message).toBe('rate limited')
      expect(err.fatal).toBe(false)
    }

    await engine.dispose()
  })

  it('ignores events scoped to other sessions', async () => {
    const { client, state } = makeMockClient()
    const engine = new OpenCodeEngine({ client })
    await engine.startSession({ workingDir: '/tmp' })

    const collector = collectUntil(
      engine,
      (ev) => ev.kind === 'session.idle',
    )

    // Text update for a different session — must be dropped.
    state.stream.push(
      sse({
        type: 'message.part.updated',
        properties: {
          part: {
            ...partBase({ sessionID: 'some-other' }),
            type: 'text',
            text: 'leak',
          },
          delta: 'leak',
        },
      }),
    )
    // Our own idle event.
    state.stream.push(
      sse({
        type: 'session.idle',
        properties: { sessionID: 'oc-sess-1' },
      }),
    )

    const events = await collector
    expect(events.some((e) => e.kind === 'message.delta')).toBe(false)

    await engine.dispose()
  })
})
