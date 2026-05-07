// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Permission-routing contract tests for OpenCodeEngine.
 *
 * Covers IS-014: every `permission.updated` the OpenCode SDK emits must
 * flow through the shared Bouncer (`reviewOperation`) and respond to the
 * server so OpenCode never hangs. The adversarial parity suite drives
 * the *real* `reviewEnginePermission` against pattern-based threats
 * (critical commands, safe operations) to prove OpenCode denies the same
 * things the Claude MCP path does.
 */

import type {
  OpencodeClient,
  Event as SseEvent,
} from '@opencode-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  BouncerDecision,
  EnginePermissionReviewRequest,
} from '../../mcp/bouncer-integration.js'
import {
  formatDenialMessage,
  formatOperationForReview,
  reviewEnginePermission,
} from '../../mcp/bouncer-integration.js'
import type {
  EngineErrorEvent,
  EngineEvent,
  PermissionRequestEvent,
} from '../EngineEvent.js'
import { OpenCodeEngine } from './OpenCodeEngine.js'

// ---------- SSE stream harness (same shape as OpenCodeEngine.test.ts) ----------

interface FakeStream {
  push: (event: SseEvent) => void
  end: () => void
  stream: AsyncGenerator<SseEvent, void, void>
}

function makeFakeStream(): FakeStream {
  const backlog: SseEvent[] = []
  const waiters: Array<(r: IteratorResult<SseEvent, void>) => void> = []
  let closed = false

  const push = (event: SseEvent): void => {
    if (closed) return
    const waiter = waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else backlog.push(event)
  }

  const drain = (): void => {
    while (waiters.length > 0) {
      waiters.shift()?.({ value: undefined, done: true })
    }
  }

  const end = (): void => {
    if (closed) return
    closed = true
    drain()
  }

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
    return(): Promise<IteratorResult<SseEvent, void>> {
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

// ---------- mock client ----------

interface PermissionRespondCall {
  sessionId: string
  permissionId: string
  response: 'once' | 'always' | 'reject'
  directory?: string
}

interface MockClientState {
  sessionId: string
  stream: FakeStream
  permissionCalls: PermissionRespondCall[]
  permissionError?: unknown
}

function makeMockClient(): { client: OpencodeClient; state: MockClientState } {
  const state: MockClientState = {
    sessionId: 'oc-sess-1',
    stream: makeFakeStream(),
    permissionCalls: [],
  }

  const client = {
    event: {
      subscribe: vi.fn(async () => ({ stream: state.stream.stream })),
    },
    session: {
      create: vi.fn(async () => ({ data: { id: state.sessionId } })),
      promptAsync: vi.fn(async () => ({ data: undefined })),
      abort: vi.fn(async () => ({ data: true })),
      delete: vi.fn(async () => ({ data: true })),
    },
    postSessionIdPermissionsPermissionId: vi.fn(
      async (opts: {
        path: { id: string; permissionID: string }
        body: { response: 'once' | 'always' | 'reject' }
        query?: { directory?: string }
      }) => {
        if (state.permissionError) throw state.permissionError
        state.permissionCalls.push({
          sessionId: opts.path.id,
          permissionId: opts.path.permissionID,
          response: opts.body.response,
          directory: opts.query?.directory,
        })
        return { data: true }
      },
    ),
  } as unknown as OpencodeClient

  return { client, state }
}

// ---------- helpers ----------

function permissionEvent(overrides: {
  id?: string
  type: string
  metadata: Record<string, unknown>
  title?: string
  sessionID?: string
}): SseEvent {
  return {
    type: 'permission.updated',
    properties: {
      id: overrides.id ?? 'perm-1',
      type: overrides.type,
      sessionID: overrides.sessionID ?? 'oc-sess-1',
      messageID: 'msg-1',
      callID: 'call-1',
      title: overrides.title ?? `Request to run ${overrides.type}`,
      metadata: overrides.metadata,
      time: { created: Date.now() },
    },
  } as SseEvent
}

/** Collect events until predicate or timeout. */
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
        `collectUntil timed out after ${timeoutMs}ms — collected ${events.length} events: ${JSON.stringify(events)}`,
      )
    }
    if (raced.done) return events
    events.push(raced.value)
    if (predicate(raced.value)) return events
  }
}

// ---------- tests ----------

afterEach(() => {
  vi.clearAllMocks()
})

describe('OpenCodeEngine — permission.requested routing to reviewOperation', () => {
  it('every permission.updated invokes the shared bouncer exactly once', async () => {
    const { client, state } = makeMockClient()
    const reviewPermission = vi.fn(
      async (_req: EnginePermissionReviewRequest): Promise<BouncerDecision> => ({
        decision: 'allow',
        confidence: 95,
        reasoning: 'Safe read operation.',
        threatLevel: 'low',
      }),
    )

    const engine = new OpenCodeEngine({ client, reviewPermission })
    await engine.startSession({ workingDir: '/tmp/workspace' })

    const collector = collectUntil(
      engine,
      (e) => e.kind === 'permission.request',
    )

    state.stream.push(
      permissionEvent({
        id: 'perm-read-1',
        type: 'read',
        metadata: { file_path: '/tmp/workspace/file.txt' },
      }),
    )

    await collector
    // Wait for fire-and-forget respond to complete.
    await vi.waitFor(() =>
      expect(state.permissionCalls).toHaveLength(1),
    )

    expect(reviewPermission).toHaveBeenCalledTimes(1)
    const request = reviewPermission.mock.calls[0][0]
    expect(request.toolName).toBe('read')
    expect(request.input).toEqual({ file_path: '/tmp/workspace/file.txt' })
    expect(request.context?.sessionId).toBe('oc-sess-1')
    expect(request.context?.workingDirectory).toBe('/tmp/workspace')

    await engine.dispose()
  })

  it('approval → responds once and does NOT emit a denial event', async () => {
    const { client, state } = makeMockClient()
    const reviewPermission = vi.fn(async (): Promise<BouncerDecision> => ({
      decision: 'allow',
      confidence: 95,
      reasoning: 'Safe operation.',
      threatLevel: 'low',
    }))

    const engine = new OpenCodeEngine({ client, reviewPermission })
    await engine.startSession({ workingDir: '/tmp/workspace' })

    const events: EngineEvent[] = []
    const done = (async () => {
      for await (const ev of engine) events.push(ev)
    })()

    state.stream.push(
      permissionEvent({
        id: 'perm-ok',
        type: 'bash',
        metadata: { command: 'npm test' },
      }),
    )

    await vi.waitFor(() => expect(state.permissionCalls).toHaveLength(1))

    expect(state.permissionCalls[0]).toEqual({
      sessionId: 'oc-sess-1',
      permissionId: 'perm-ok',
      response: 'once',
      directory: undefined,
    })

    const permRequest = events.find((e) => e.kind === 'permission.request')
    expect(permRequest).toBeDefined()
    const denial = events.find(
      (e): e is EngineErrorEvent =>
        e.kind === 'engine.error' && e.code === 'BOUNCER_DENIED',
    )
    expect(denial).toBeUndefined()

    await engine.dispose()
    await done
  })

  it('warn_allow → responds once (approval path)', async () => {
    const { client, state } = makeMockClient()
    const reviewPermission = vi.fn(async (): Promise<BouncerDecision> => ({
      decision: 'warn_allow',
      confidence: 70,
      reasoning: 'Allowed with caution.',
      threatLevel: 'medium',
    }))

    const engine = new OpenCodeEngine({ client, reviewPermission })
    await engine.startSession({ workingDir: '/tmp/workspace' })

    state.stream.push(
      permissionEvent({
        id: 'perm-warn',
        type: 'bash',
        metadata: { command: 'curl https://example.com' },
      }),
    )

    await vi.waitFor(() => expect(state.permissionCalls).toHaveLength(1))
    expect(state.permissionCalls[0].response).toBe('once')

    await engine.dispose()
  })

  it('denial → responds reject AND emits a user-visible BOUNCER_DENIED engine.error', async () => {
    const { client, state } = makeMockClient()
    const decision: BouncerDecision = {
      decision: 'deny',
      confidence: 99,
      reasoning: 'Critical threat: attempted to delete root.',
      threatLevel: 'critical',
      alternative: 'Specify a narrower target path.',
    }
    const reviewPermission = vi.fn(async (): Promise<BouncerDecision> => decision)

    const engine = new OpenCodeEngine({ client, reviewPermission })
    await engine.startSession({ workingDir: '/tmp/workspace' })

    const events: EngineEvent[] = []
    const done = (async () => {
      for await (const ev of engine) events.push(ev)
    })()

    state.stream.push(
      permissionEvent({
        id: 'perm-deny',
        type: 'bash',
        metadata: { command: 'rm -rf /' },
      }),
    )

    await vi.waitFor(() => expect(state.permissionCalls).toHaveLength(1))

    expect(state.permissionCalls[0]).toEqual(
      expect.objectContaining({
        sessionId: 'oc-sess-1',
        permissionId: 'perm-deny',
        response: 'reject',
      }),
    )

    const denial = await vi.waitFor(() => {
      const d = events.find(
        (e): e is EngineErrorEvent =>
          e.kind === 'engine.error' && e.code === 'BOUNCER_DENIED',
      )
      if (!d) throw new Error('denial event not emitted yet')
      return d
    })

    // Shape parity with Claude MCP denial: "🚫 <reasoning>\n\nAlternative: <alt>"
    const expectedMessage = formatDenialMessage(decision)
    expect(denial.message).toBe(expectedMessage)
    expect(denial.message).toContain('🚫')
    expect(denial.message).toContain(decision.reasoning)
    expect(denial.message).toContain(decision.alternative)
    expect(denial.fatal).toBe(false)

    await engine.dispose()
    await done
  })

  it('bouncer throw is treated as a deny (fail-safe)', async () => {
    const { client, state } = makeMockClient()
    const reviewPermission = vi.fn(async () => {
      throw new Error('bouncer offline')
    })

    const engine = new OpenCodeEngine({ client, reviewPermission })
    await engine.startSession({ workingDir: '/tmp/workspace' })

    const events: EngineEvent[] = []
    const done = (async () => {
      for await (const ev of engine) events.push(ev)
    })()

    state.stream.push(
      permissionEvent({
        id: 'perm-err',
        type: 'bash',
        metadata: { command: 'ls' },
      }),
    )

    await vi.waitFor(() => expect(state.permissionCalls).toHaveLength(1))
    expect(state.permissionCalls[0].response).toBe('reject')

    await vi.waitFor(() => {
      const d = events.find(
        (e): e is EngineErrorEvent =>
          e.kind === 'engine.error' && e.code === 'BOUNCER_DENIED',
      )
      if (!d) throw new Error('denial not emitted')
      expect(d.message).toContain('bouncer offline')
    })

    await engine.dispose()
    await done
  })

  it('passes the `directory` query param when configured', async () => {
    const { client, state } = makeMockClient()
    const reviewPermission = vi.fn(async (): Promise<BouncerDecision> => ({
      decision: 'allow',
      confidence: 95,
      reasoning: 'ok',
      threatLevel: 'low',
    }))

    const engine = new OpenCodeEngine({
      client,
      directory: '/workspace',
      reviewPermission,
    })
    await engine.startSession({ workingDir: '/workspace' })

    state.stream.push(
      permissionEvent({
        id: 'perm-dir',
        type: 'read',
        metadata: { file_path: '/workspace/a.txt' },
      }),
    )

    await vi.waitFor(() => expect(state.permissionCalls).toHaveLength(1))
    expect(state.permissionCalls[0].directory).toBe('/workspace')

    await engine.dispose()
  })

  it('permission.request event is still emitted alongside bouncer work', async () => {
    const { client, state } = makeMockClient()
    const reviewPermission = vi.fn(async (): Promise<BouncerDecision> => ({
      decision: 'allow',
      confidence: 95,
      reasoning: 'ok',
      threatLevel: 'low',
    }))

    const engine = new OpenCodeEngine({ client, reviewPermission })
    await engine.startSession({ workingDir: '/tmp' })

    const collector = collectUntil(
      engine,
      (e) => e.kind === 'permission.request',
    )

    state.stream.push(
      permissionEvent({
        id: 'perm-obs',
        type: 'bash',
        metadata: { command: 'npm test' },
      }),
    )

    const events = await collector
    const req = events.find(
      (e): e is PermissionRequestEvent => e.kind === 'permission.request',
    )
    expect(req).toBeDefined()
    expect(req?.requestId).toBe('perm-obs')
    expect(req?.toolName).toBe('bash')
    expect(req?.input).toEqual({ command: 'npm test' })

    await engine.dispose()
  })

  it('respond-failure emits OPENCODE_PERMISSION_RESPOND_ERROR but session stays alive', async () => {
    const { client, state } = makeMockClient()
    state.permissionError = new Error('server unreachable')
    const reviewPermission = vi.fn(async (): Promise<BouncerDecision> => ({
      decision: 'allow',
      confidence: 95,
      reasoning: 'ok',
      threatLevel: 'low',
    }))

    const engine = new OpenCodeEngine({ client, reviewPermission })
    await engine.startSession({ workingDir: '/tmp' })

    const events: EngineEvent[] = []
    const done = (async () => {
      for await (const ev of engine) events.push(ev)
    })()

    state.stream.push(
      permissionEvent({
        id: 'perm-net',
        type: 'bash',
        metadata: { command: 'ls' },
      }),
    )

    await vi.waitFor(() => {
      const err = events.find(
        (e): e is EngineErrorEvent =>
          e.kind === 'engine.error' &&
          e.code === 'OPENCODE_PERMISSION_RESPOND_ERROR',
      )
      if (!err) throw new Error('respond error not emitted yet')
      expect(err.fatal).toBe(false)
      expect(err.message).toContain('server unreachable')
    })

    await engine.dispose()
    await done
  })
})

// ---------- adversarial parity suite ----------

/**
 * Adversarial parity: drive the REAL `reviewEnginePermission` against the
 * kinds of operations the Claude MCP path denies. Every one of these must
 * deny through the unified Bouncer so OpenCode matches Claude's posture.
 *
 * Note: these cases use pattern-based fast-path denials (Layer 1), so they
 * do not require network/Haiku and are deterministic under `npm test`.
 */
describe('OpenCodeEngine — adversarial parity with Claude MCP bouncer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  type Scenario = {
    name: string
    toolName: string
    input: Record<string, unknown>
  }

  const denyScenarios: Scenario[] = [
    {
      name: 'rm -rf / (destroy-root)',
      toolName: 'bash',
      input: { command: 'rm -rf /' },
    },
    {
      name: 'rm -rf ~ (destroy-home)',
      toolName: 'bash',
      input: { command: 'rm -rf ~' },
    },
    {
      name: 'fork bomb',
      toolName: 'bash',
      input: { command: ':(){ :|:& };:' },
    },
    {
      name: 'dd-overwrite-disk',
      toolName: 'bash',
      input: { command: 'dd if=/dev/zero of=/dev/sda' },
    },
    {
      name: 'mkfs-filesystem-format',
      toolName: 'bash',
      input: { command: 'mkfs.ext4 /dev/sda1' },
    },
  ]

  for (const scenario of denyScenarios) {
    it(`denies ${scenario.name} and responds reject to SDK`, async () => {
      const { client, state } = makeMockClient()
      // Use the real reviewEnginePermission — this is the parity assertion.
      const engine = new OpenCodeEngine({
        client,
        reviewPermission: reviewEnginePermission,
      })
      await engine.startSession({ workingDir: '/tmp/workspace' })

      const events: EngineEvent[] = []
      const done = (async () => {
        for await (const ev of engine) events.push(ev)
      })()

      state.stream.push(
        permissionEvent({
          id: `perm-${scenario.name}`,
          type: scenario.toolName,
          metadata: scenario.input,
        }),
      )

      await vi.waitFor(() => {
        expect(state.permissionCalls).toHaveLength(1)
      })
      expect(state.permissionCalls[0].response).toBe('reject')

      await vi.waitFor(() => {
        const denial = events.find(
          (e): e is EngineErrorEvent =>
            e.kind === 'engine.error' && e.code === 'BOUNCER_DENIED',
        )
        if (!denial) throw new Error('no BOUNCER_DENIED emitted')
        expect(denial.message).toContain('🚫')
      })

      await engine.dispose()
      await done
    })
  }

  const allowScenarios: Scenario[] = [
    {
      name: 'npm test (known-safe bash)',
      toolName: 'bash',
      input: { command: 'npm test' },
    },
    {
      name: 'read (inside workspace)',
      toolName: 'read',
      input: { file_path: '/home/user/project/src/index.ts' },
    },
    {
      name: 'grep (pattern search)',
      toolName: 'grep',
      input: { pattern: 'function' },
    },
  ]

  for (const scenario of allowScenarios) {
    it(`allows ${scenario.name} and responds once to SDK`, async () => {
      const { client, state } = makeMockClient()
      const engine = new OpenCodeEngine({
        client,
        reviewPermission: reviewEnginePermission,
      })
      await engine.startSession({ workingDir: '/tmp/workspace' })

      state.stream.push(
        permissionEvent({
          id: `perm-${scenario.name}`,
          type: scenario.toolName,
          metadata: scenario.input,
        }),
      )

      await vi.waitFor(() => {
        expect(state.permissionCalls).toHaveLength(1)
      })
      expect(state.permissionCalls[0].response).toBe('once')

      await engine.dispose()
    })
  }
})

// ---------- helper: operation formatter parity ----------

describe('formatOperationForReview — engine parity with MCP server', () => {
  it('bash commands include the command string', () => {
    expect(
      formatOperationForReview('bash', { command: 'npm test' }),
    ).toBe('bash: npm test')
  })

  it('write/edit/read use the file path', () => {
    expect(
      formatOperationForReview('write', { file_path: '/tmp/a.txt' }),
    ).toBe('write: /tmp/a.txt')
    expect(
      formatOperationForReview('edit', { filePath: '/tmp/b.txt' }),
    ).toBe('edit: /tmp/b.txt')
    expect(formatOperationForReview('read', { path: '/tmp/c.txt' })).toBe(
      'read: /tmp/c.txt',
    )
  })

  it('unknown tools serialize the full input', () => {
    expect(
      formatOperationForReview('weirdtool', { foo: 'bar' }),
    ).toBe('weirdtool: {"foo":"bar"}')
  })

  it('is case-insensitive on the tool name for format decisions', () => {
    expect(formatOperationForReview('Bash', { command: 'ls' })).toBe(
      'Bash: ls',
    )
    expect(
      formatOperationForReview('READ', { file_path: '/tmp/a' }),
    ).toBe('READ: /tmp/a')
  })
})
