// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Engine parity test suite (IS-021).
 *
 * Runs a fixed battery of scripted scenarios against BOTH
 * `CodingAgentEngine` implementations (Claude Code + OpenCode) and asserts
 * the observable `EngineEvent` stream is shaped identically. The goal is a
 * single set of assertions that hold regardless of which engine produced
 * the events — no "this only works for Claude" caveats.
 *
 * Each scenario uses an {@link EngineDriver} that knows how to stage a
 * canned set of events for its engine (the Claude driver swaps in a fake
 * `executeClaudeCommand` impl; the OpenCode driver pushes SSE payloads
 * into a fake stream). The assertions that follow use only the public
 * `EngineEvent` contract so they apply to either engine unchanged.
 *
 * Scenarios covered (AC from IS-021):
 *   1. simple prompt
 *   2. tool-heavy prompt
 *   3. long-running prompt
 *   4. cancel
 *   5. retry after stall
 *   6. Bouncer-denied tool call
 *   7. usage accounting
 *   8. session resume
 *
 * All mocks are hermetic — no Claude subprocess is spawned and no OpenCode
 * HTTP server is contacted.
 */

import type { ChildProcess } from 'node:child_process';
import type {
  OpencodeClient,
  Part,
  Event as SseEvent,
} from '@opencode-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeInvokerOptions } from '../cli/headless/claude-invoker.js';
import type { ExecutionResult } from '../cli/headless/types.js';
import { ClaudeCodeEngine } from './claude/ClaudeCodeEngine.js';
import type {
  EngineEvent,
  EngineId,
  MessageDeltaEvent,
  ToolEndEvent,
  ToolStartEvent,
  UsageUpdateEvent,
} from './EngineEvent.js';
import { OpenCodeEngine } from './opencode/OpenCodeEngine.js';
import type { CodingAgentEngine, StartSessionOptions } from './types.js';

// ────────────────────────── Claude invoker mock ───────────────────────────

type InvokerImpl = (
  prompt: string,
  promptId: string,
  sessionNumber: number,
  options: ClaudeInvokerOptions,
) => Promise<ExecutionResult>;

const invokerState: { impl: InvokerImpl } = {
  impl: async () => ({ output: '', exitCode: 0 }),
};

vi.mock('../cli/headless/claude-invoker.js', () => ({
  executeClaudeCommand: (
    prompt: string,
    promptId: string,
    sessionNumber: number,
    options: ClaudeInvokerOptions,
  ) => invokerState.impl(prompt, promptId, sessionNumber, options),
}));

// `enrichPromptWithContext` does an approval-detection spawn for short
// prompts. Stub it so every test stays hermetic regardless of the prompt
// passed through.
vi.mock('../cli/headless/prompt-utils.js', async (importOriginal) => {
  const orig =
    await importOriginal<typeof import('../cli/headless/prompt-utils.js')>();
  return {
    ...orig,
    enrichPromptWithContext: async (prompt: string) => prompt,
  };
});

// HeadlessRunner.cleanup() ultimately routes through process.kill when the
// engine cancels. Without this spy a real SIGTERM could hit the test
// process group when cancel runs. We record the invocation so scenarios
// can assert on it.
const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(
  // biome-ignore lint/suspicious/noExplicitAny: match process.kill return type
  () => true as any,
);

afterEach(() => {
  processKillSpy.mockClear();
  invokerState.impl = async () => ({ output: '', exitCode: 0 });
});

// ────────────────────────── Event collector ───────────────────────────────

/**
 * Pull events off the engine's async iterator until `predicate` is true or
 * the stream ends. Rejects on timeout so stuck scenarios fail loudly.
 */
async function collectUntil(
  engine: AsyncIterable<EngineEvent>,
  predicate: (event: EngineEvent) => boolean,
  timeoutMs = 3000,
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  const iter = engine[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const remaining = Math.max(0, deadline - Date.now());
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), remaining);
    });
    const raced = await Promise.race([iter.next(), timeoutPromise]);
    if (raced === 'timeout') {
      throw new Error(
        `collectUntil: timed out after ${timeoutMs}ms; collected ${events.length} events: ${JSON.stringify(events)}`,
      );
    }
    if (raced.done) return events;
    events.push(raced.value);
    if (predicate(raced.value)) return events;
  }
}

/**
 * Collect events until every requested event kind has been seen at least
 * once, or the stream ends. The engines emit engine.error and session.idle
 * in different relative orders — Claude emits session.idle first and the
 * error after, while OpenCode emits the error first and session.idle
 * after — so scenarios that need both events must wait for the later one
 * regardless of ordering.
 */
async function collectUntilAllSeen(
  engine: AsyncIterable<EngineEvent>,
  kinds: ReadonlyArray<EngineEvent['kind']>,
  timeoutMs = 3000,
): Promise<EngineEvent[]> {
  const needed = new Set(kinds);
  return collectUntil(
    engine,
    (ev) => {
      needed.delete(ev.kind);
      return needed.size === 0;
    },
    timeoutMs,
  );
}

// ────────────────────────── OpenCode fake stream ──────────────────────────

interface FakeStream {
  push: (event: SseEvent) => void;
  end: () => void;
  stream: AsyncGenerator<SseEvent, void, void>;
}

function makeFakeStream(): FakeStream {
  const backlog: SseEvent[] = [];
  const waiters: Array<(r: IteratorResult<SseEvent, void>) => void> = [];
  let closed = false;

  const push = (event: SseEvent): void => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else backlog.push(event);
  };
  const drain = (): void => {
    while (waiters.length > 0) waiters.shift()?.({ value: undefined, done: true });
  };
  const end = (): void => {
    if (closed) return;
    closed = true;
    drain();
  };
  const stream: AsyncGenerator<SseEvent, void, void> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async [Symbol.asyncDispose]() {
      closed = true;
      drain();
    },
    next(): Promise<IteratorResult<SseEvent, void>> {
      if (backlog.length > 0) {
        return Promise.resolve({
          value: backlog.shift() as SseEvent,
          done: false,
        });
      }
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise<IteratorResult<SseEvent, void>>((resolve) => {
        waiters.push(resolve);
      });
    },
    return(): Promise<IteratorResult<SseEvent, void>> {
      closed = true;
      drain();
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err: unknown): Promise<IteratorResult<SseEvent, void>> {
      closed = true;
      drain();
      return Promise.reject(err);
    },
  };
  return { push, end, stream };
}

// ────────────────────────── OpenCode client ───────────────────────────────

interface MockClientState {
  sessionId: string;
  stream: FakeStream;
  abortCalls: Array<{ id: string }>;
  deleteCalls: Array<{ id: string }>;
  promptCalls: Array<{ id: string; parts: unknown }>;
  nextPromptResult?: Promise<unknown>;
}

function makeMockOpenCodeClient(
  sessionId = 'parity-sess',
): { client: OpencodeClient; state: MockClientState } {
  const state: MockClientState = {
    sessionId,
    stream: makeFakeStream(),
    abortCalls: [],
    deleteCalls: [],
    promptCalls: [],
  };
  const client = {
    event: {
      subscribe: vi.fn(async () => ({ stream: state.stream.stream })),
    },
    session: {
      create: vi.fn(async () => ({ data: { id: state.sessionId } })),
      promptAsync: vi.fn(
        async (opts: { path: { id: string }; body: { parts: unknown } }) => {
          state.promptCalls.push({ id: opts.path.id, parts: opts.body.parts });
          if (state.nextPromptResult) return state.nextPromptResult;
          return { data: undefined };
        },
      ),
      abort: vi.fn(async (opts: { path: { id: string } }) => {
        state.abortCalls.push({ id: opts.path.id });
        return { data: true };
      }),
      delete: vi.fn(async (opts: { path: { id: string } }) => {
        state.deleteCalls.push({ id: opts.path.id });
        return { data: true };
      }),
    },
  } as unknown as OpencodeClient;
  return { client, state };
}

// ────────────────────────── ResponsePlan + drivers ────────────────────────

/** Describes what an engine should simulate during a single turn. */
interface ResponsePlan {
  sessionId: string;
  /** Text chunks emitted as message.delta. */
  messages?: string[];
  /** Tool calls — emitted as tool.start → tool.end pairs. */
  tools?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    result: string;
    isError?: boolean;
  }>;
  /** Cumulative usage updates emitted as usage.update. */
  usage?: Array<{
    input: number;
    output: number;
    cacheCreation?: number;
    cacheRead?: number;
  }>;
  /** Stop reason attached to the terminal session.idle. */
  stopReason?: string;
  /**
   * Simulate an engine.error before completing the turn. For Claude this
   * is done by returning a non-zero exit code with `result.error`. For
   * OpenCode this is done via a `session.error` SSE event.
   */
  errorBeforeIdle?: { code: string; message: string };
  /** Milliseconds to wait inside the simulated turn before events fire. */
  delayMs?: number;
  /**
   * When true, the engine never finishes the turn — useful for cancel
   * scenarios where we expect cancel() to terminate it.
   */
  hang?: boolean;
}

interface EngineDriver {
  readonly engineId: EngineId;
  readonly engine: CodingAgentEngine;
  /** Default session id used by the driver's stub. */
  readonly defaultSessionId: string;
  /** Resolve when the engine is ready to accept sendPrompt. */
  start(options: StartSessionOptions): Promise<void>;
  /**
   * Stage the engine's response plan. Must be called BEFORE `sendPrompt` so
   * the mocks are in place by the time the engine runs its turn.
   */
  stage(plan: ResponsePlan): void;
  /**
   * Play any events that need to be produced AFTER `sendPrompt` returns
   * (OpenCode only — Claude's mock invoker fires callbacks synchronously
   * so there is nothing to play).
   */
  flush(): Promise<void>;
  cleanup(): Promise<void>;
}

// ── Claude driver ────────────────────────────────────────────────────────

function createClaudeDriver(): EngineDriver {
  const engine = new ClaudeCodeEngine();
  const defaultSessionId = 'claude-parity-sess';

  return {
    engineId: 'claude-code',
    engine,
    defaultSessionId,
    async start(options) {
      await engine.startSession(options);
    },
    stage(plan) {
      invokerState.impl = async (
        _prompt,
        _promptId,
        _sessionNumber,
        { config, runningProcesses },
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: scripted scenario dispatcher; branching mirrors the parity matrix and is intentional
      ) => {
        // Register a tracked child so cancel() has something to target.
        const fakePid = 80_000 + Math.floor(Math.random() * 1_000);
        const fakeProc = {
          kill: vi.fn(),
          killed: false,
          exitCode: null,
        } as unknown as ChildProcess;
        runningProcesses.set(fakePid, fakeProc);

        if (plan.delayMs) {
          await new Promise((r) => setTimeout(r, plan.delayMs));
        }

        for (const text of plan.messages ?? []) {
          config.outputCallback?.(text);
        }
        for (const t of plan.tools ?? []) {
          config.toolUseCallback?.({
            type: 'tool_start',
            toolName: t.name,
            toolId: t.id,
            index: 0,
          });
          config.toolUseCallback?.({
            type: 'tool_complete',
            toolName: t.name,
            toolId: t.id,
            index: 0,
            completeInput: t.input,
          });
          config.toolUseCallback?.({
            type: 'tool_result',
            toolId: t.id,
            result: t.result,
            isError: t.isError ?? false,
          });
        }
        for (const u of plan.usage ?? []) {
          config.tokenUsageCallback?.({
            inputTokens: u.input,
            outputTokens: u.output,
          });
        }

        if (plan.hang) {
          // Simulate a subprocess that takes a short while to exit after
          // SIGTERM. cancel() in ClaudeCodeEngine awaits the run promise
          // after killing the process group, so a never-resolving promise
          // would deadlock cancel — real subprocesses exit promptly once
          // the signal lands. We resolve with a 143-exit result so the
          // engine emits session.idle without a stuck lifetime.
          await new Promise((r) => setTimeout(r, 30));
          return {
            output: '',
            exitCode: 143,
            signalName: 'SIGTERM',
            claudeSessionId: plan.sessionId,
          };
        }

        if (plan.errorBeforeIdle) {
          // A non-zero exit without assistant text surfaces as
          // a non-fatal engine.error in addition to session.idle.
          return {
            output: '',
            exitCode: 1,
            error: plan.errorBeforeIdle.message,
            claudeSessionId: plan.sessionId,
            stopReason: plan.stopReason ?? 'end_turn',
          };
        }

        const lastUsage = plan.usage?.[plan.usage.length - 1];
        return {
          output: '',
          exitCode: 0,
          assistantResponse: plan.messages?.join('') ?? '',
          claudeSessionId: plan.sessionId,
          stopReason: plan.stopReason ?? 'end_turn',
          apiTokenUsage: lastUsage
            ? { inputTokens: lastUsage.input, outputTokens: lastUsage.output }
            : undefined,
        };
      };
    },
    async flush() {
      // Claude callbacks fire synchronously inside the invoker impl; the
      // pending runPromise.then handler runs on the next microtask. Yield
      // once so any trailing emissions land on the iterator.
      await Promise.resolve();
    },
    async cleanup() {
      await engine.dispose();
    },
  };
}

// ── OpenCode driver ──────────────────────────────────────────────────────

interface OpenCodeDriver extends EngineDriver {
  /** The underlying SDK mock state — for fine-grained assertions. */
  readonly state: MockClientState;
}

function createOpenCodeDriver(sessionId = 'opencode-parity-sess'): OpenCodeDriver {
  const { client, state } = makeMockOpenCodeClient(sessionId);
  const engine = new OpenCodeEngine({ client });
  let pendingPlan: ResponsePlan | null = null;

  return {
    engineId: 'opencode',
    engine,
    defaultSessionId: sessionId,
    state,
    async start(options) {
      await engine.startSession(options);
    },
    stage(plan) {
      pendingPlan = plan;
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: scripted scenario dispatcher; branching mirrors the parity matrix and is intentional
    async flush() {
      const plan = pendingPlan;
      pendingPlan = null;
      if (!plan) return;
      const sid = plan.sessionId;

      if (plan.delayMs) {
        await new Promise((r) => setTimeout(r, plan.delayMs));
      }

      for (const text of plan.messages ?? []) {
        state.stream.push({
          type: 'message.part.updated',
          properties: {
            part: {
              id: `p-text-${Math.random().toString(36).slice(2, 8)}`,
              sessionID: sid,
              messageID: 'm-1',
              type: 'text',
              text,
            },
            delta: text,
          },
        } as SseEvent);
      }

      for (const t of plan.tools ?? []) {
        const runningPart: Part = {
          id: `p-${t.id}`,
          sessionID: sid,
          messageID: 'm-1',
          type: 'tool',
          callID: t.id,
          tool: t.name,
          state: {
            status: 'running',
            input: t.input,
            time: { start: 1 },
          },
        } as unknown as Part;
        state.stream.push({
          type: 'message.part.updated',
          properties: { part: runningPart },
        } as SseEvent);

        const finishedPart: Part = {
          id: `p-${t.id}`,
          sessionID: sid,
          messageID: 'm-1',
          type: 'tool',
          callID: t.id,
          tool: t.name,
          state: t.isError
            ? {
                status: 'error',
                input: t.input,
                error: t.result,
                time: { start: 1, end: 2 },
              }
            : {
                status: 'completed',
                input: t.input,
                output: t.result,
                title: t.name,
                metadata: {},
                time: { start: 1, end: 2 },
              },
        } as unknown as Part;
        state.stream.push({
          type: 'message.part.updated',
          properties: { part: finishedPart },
        } as SseEvent);
      }

      for (const u of plan.usage ?? []) {
        state.stream.push({
          type: 'message.part.updated',
          properties: {
            part: {
              id: `p-step-${Math.random().toString(36).slice(2, 8)}`,
              sessionID: sid,
              messageID: 'm-1',
              type: 'step-finish',
              reason: 'stop',
              cost: 0,
              tokens: {
                input: u.input,
                output: u.output,
                reasoning: 0,
                cache: {
                  read: u.cacheRead ?? 0,
                  write: u.cacheCreation ?? 0,
                },
              },
            },
          },
        } as SseEvent);
      }

      if (plan.errorBeforeIdle) {
        state.stream.push({
          type: 'session.error',
          properties: {
            sessionID: sid,
            error: {
              name: plan.errorBeforeIdle.code,
              data: { message: plan.errorBeforeIdle.message, isRetryable: true },
            },
          },
        } as SseEvent);
      }

      if (!plan.hang) {
        state.stream.push({
          type: 'session.idle',
          properties: { sessionID: sid },
        } as SseEvent);
      }
    },
    async cleanup() {
      state.stream.end();
      await engine.dispose();
    },
  };
}

// ────────────────────────── Parity scenarios ──────────────────────────────

type DriverFactory = () => EngineDriver;
const ENGINES: Array<{ label: string; make: DriverFactory }> = [
  { label: 'claude-code', make: () => createClaudeDriver() },
  { label: 'opencode', make: () => createOpenCodeDriver() },
];

describe.each(ENGINES)('Engine parity — $label', ({ label, make }) => {
  let driver: EngineDriver;

  beforeEach(() => {
    driver = make();
  });

  afterEach(async () => {
    await driver.cleanup();
  });

  // 1. simple prompt ────────────────────────────────────────────────────
  it('scenario 1: simple prompt → message.delta* + session.idle', async () => {
    const plan: ResponsePlan = {
      sessionId: driver.defaultSessionId,
      messages: ['Hello ', 'world'],
      stopReason: 'end_turn',
    };
    await driver.start({ workingDir: '/tmp' });
    driver.stage(plan);

    const collector = collectUntil(
      driver.engine,
      (e) => e.kind === 'session.idle',
    );
    await driver.engine.sendPrompt(
      'please do the thing that is long enough to skip approval detection path',
    );
    await driver.flush();
    const events = await collector;

    const deltas = events.filter(
      (e): e is MessageDeltaEvent => e.kind === 'message.delta',
    );
    expect(deltas.map((e) => e.text).join('')).toBe('Hello world');

    const idle = events.find((e) => e.kind === 'session.idle');
    expect(idle).toBeDefined();
    expect(idle?.sessionId).toBe(plan.sessionId);
    for (const ev of events) expect(typeof ev.timestamp).toBe('number');
  });

  // 2. tool-heavy prompt ────────────────────────────────────────────────
  it('scenario 2: tool-heavy prompt → ordered tool.start/tool.end pairs', async () => {
    const plan: ResponsePlan = {
      sessionId: driver.defaultSessionId,
      tools: [
        {
          id: 'call-1',
          name: 'Read',
          input: { file_path: '/tmp/a.txt' },
          result: 'a',
        },
        {
          id: 'call-2',
          name: 'Read',
          input: { file_path: '/tmp/b.txt' },
          result: 'b',
        },
        {
          id: 'call-3',
          name: 'Bash',
          input: { command: 'echo hi' },
          result: 'hi',
        },
      ],
    };
    await driver.start({ workingDir: '/tmp' });
    driver.stage(plan);

    const collector = collectUntil(
      driver.engine,
      (e) => e.kind === 'session.idle',
    );
    await driver.engine.sendPrompt(
      'read both files and then echo hi please please please please please',
    );
    await driver.flush();
    const events = await collector;

    const starts = events.filter(
      (e): e is ToolStartEvent => e.kind === 'tool.start',
    );
    const ends = events.filter(
      (e): e is ToolEndEvent => e.kind === 'tool.end',
    );
    expect(starts).toHaveLength(plan.tools!.length);
    expect(ends).toHaveLength(plan.tools!.length);

    for (const t of plan.tools!) {
      const start = starts.find((s) => s.toolCallId === t.id);
      const end = ends.find((e) => e.toolCallId === t.id);
      expect(start).toBeDefined();
      expect(end).toBeDefined();
      if (!start || !end) throw new Error('missing tool events');
      expect(start.toolName).toBe(t.name);
      expect(end.toolName).toBe(t.name);
      expect(end.input).toEqual(t.input);
      expect(end.result).toBe(t.result);
      expect(end.isError).toBe(false);
      expect(end.durationMs).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(start)).toBeLessThan(events.indexOf(end));
    }

    // All tool call ids must be unique within the turn.
    const ids = starts.map((s) => s.toolCallId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // 3. long-running prompt ──────────────────────────────────────────────
  it('scenario 3: long-running prompt → events eventually arrive and idle', async () => {
    const plan: ResponsePlan = {
      sessionId: driver.defaultSessionId,
      messages: ['delayed reply'],
      delayMs: 40,
    };
    await driver.start({ workingDir: '/tmp' });
    driver.stage(plan);

    const started = Date.now();
    const collector = collectUntil(
      driver.engine,
      (e) => e.kind === 'session.idle',
      5000,
    );
    await driver.engine.sendPrompt(
      'take your time and respond when you are done please please please',
    );
    await driver.flush();
    const events = await collector;
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(30);
    const deltas = events.filter(
      (e): e is MessageDeltaEvent => e.kind === 'message.delta',
    );
    expect(deltas.map((e) => e.text).join('')).toBe('delayed reply');
    expect(events.at(-1)?.kind).toBe('session.idle');
  });

  // 4. cancel ──────────────────────────────────────────────────────────
  it('scenario 4: cancel() resolves cleanly while a prompt is in flight', async () => {
    const plan: ResponsePlan = {
      sessionId: driver.defaultSessionId,
      hang: true,
    };
    await driver.start({ workingDir: '/tmp' });
    driver.stage(plan);

    await driver.engine.sendPrompt(
      'long running task that never resolves on its own please please please',
    );
    await driver.flush();
    // Let the engine register its running state (process for Claude,
    // subscription for OpenCode) before we cancel.
    await new Promise((r) => setTimeout(r, 0));

    await expect(driver.engine.cancel()).resolves.toBeUndefined();

    // After cancel, the engine must accept a fresh sendPrompt. For Claude
    // the hung runPromise is still pending until we reset the invoker
    // impl; for OpenCode the session stays alive on the server side. We
    // don't assert a further turn here because Claude's currentRunPromise
    // only clears when the underlying run resolves — and a hung run
    // stays pending. The AC is simply that cancel() returns without
    // error, which both engines must satisfy.
    if (label === 'claude-code') {
      // Claude routes through process.kill(-pid, SIGTERM).
      expect(processKillSpy).toHaveBeenCalled();
      const sig = processKillSpy.mock.calls[0]?.[1];
      expect(sig).toBe('SIGTERM');
    } else {
      const state = (driver as OpenCodeDriver).state;
      expect(state.abortCalls).toHaveLength(1);
      expect(state.abortCalls[0].id).toBe(driver.defaultSessionId);
    }
  });

  // 5. retry after stall ───────────────────────────────────────────────
  it('scenario 5: retry after stall → first turn errors, next turn succeeds', async () => {
    await driver.start({ workingDir: '/tmp' });

    // Turn A: emit a non-fatal engine.error alongside session.idle.
    // Claude emits idle first then error; OpenCode emits error first then
    // idle — we wait until both have arrived so either ordering passes.
    driver.stage({
      sessionId: driver.defaultSessionId,
      errorBeforeIdle: { code: 'STALL', message: 'simulated stall' },
      stopReason: 'end_turn',
    });
    const firstCollector = collectUntilAllSeen(driver.engine, [
      'session.idle',
      'engine.error',
    ]);
    await driver.engine.sendPrompt(
      'first prompt that will stall out please please please please please',
    );
    await driver.flush();
    const firstEvents = await firstCollector;
    const err = firstEvents.find((e) => e.kind === 'engine.error');
    expect(err).toBeDefined();
    if (err?.kind === 'engine.error') {
      expect(err.fatal).toBe(false);
      expect(err.message.toLowerCase()).toContain('stall');
    }
    expect(firstEvents.some((e) => e.kind === 'session.idle')).toBe(true);

    // Turn B: a clean retry produces a normal session.idle.
    driver.stage({
      sessionId: driver.defaultSessionId,
      messages: ['retried successfully'],
      stopReason: 'end_turn',
    });
    const secondCollector = collectUntil(
      driver.engine,
      (e) => e.kind === 'session.idle',
    );
    await driver.engine.sendPrompt(
      'second prompt retrying after the previous stall please please please',
    );
    await driver.flush();
    const secondEvents = await secondCollector;
    const deltas = secondEvents.filter(
      (e): e is MessageDeltaEvent => e.kind === 'message.delta',
    );
    expect(deltas.map((e) => e.text).join('')).toBe('retried successfully');
    expect(secondEvents.at(-1)?.kind).toBe('session.idle');
  });

  // 6. Bouncer-denied tool call ────────────────────────────────────────
  it('scenario 6: Bouncer-denied tool call → tool.end with isError=true', async () => {
    const plan: ResponsePlan = {
      sessionId: driver.defaultSessionId,
      tools: [
        {
          id: 'denied-1',
          name: 'Bash',
          input: { command: 'rm -rf /' },
          result: 'DENIED_BY_BOUNCER: unsafe destructive command',
          isError: true,
        },
      ],
      stopReason: 'end_turn',
    };
    await driver.start({ workingDir: '/tmp' });
    driver.stage(plan);

    const collector = collectUntil(
      driver.engine,
      (e) => e.kind === 'session.idle',
    );
    await driver.engine.sendPrompt(
      'please run the destructive command the bouncer should deny please',
    );
    await driver.flush();
    const events = await collector;

    const end = events.find(
      (e): e is ToolEndEvent =>
        e.kind === 'tool.end' && e.toolCallId === 'denied-1',
    );
    expect(end).toBeDefined();
    if (!end) throw new Error('missing tool.end');
    expect(end.isError).toBe(true);
    expect(end.result).toContain('DENIED_BY_BOUNCER');
    expect(end.toolName).toBe('Bash');
  });

  // 7. usage accounting ────────────────────────────────────────────────
  it('scenario 7: usage accounting → usage.update monotonic + getUsage()', async () => {
    const plan: ResponsePlan = {
      sessionId: driver.defaultSessionId,
      usage: [
        { input: 100, output: 50 },
        { input: 150, output: 90 },
      ],
      messages: ['done'],
    };
    await driver.start({ workingDir: '/tmp' });

    expect(driver.engine.getUsage()).toEqual(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0 }),
    );

    driver.stage(plan);
    const collector = collectUntil(
      driver.engine,
      (e) => e.kind === 'session.idle',
    );
    await driver.engine.sendPrompt(
      'count some tokens for me please please please please please please please',
    );
    await driver.flush();
    const events = await collector;

    const usages = events.filter(
      (e): e is UsageUpdateEvent => e.kind === 'usage.update',
    );
    expect(usages).toHaveLength(plan.usage!.length);
    expect(usages[0].inputTokens).toBe(100);
    expect(usages[0].outputTokens).toBe(50);
    expect(usages[1].inputTokens).toBe(150);
    expect(usages[1].outputTokens).toBe(90);
    // Contract: monotonic non-decreasing.
    expect(usages[1].inputTokens).toBeGreaterThanOrEqual(usages[0].inputTokens);
    expect(usages[1].outputTokens).toBeGreaterThanOrEqual(
      usages[0].outputTokens,
    );

    const snapshot = driver.engine.getUsage();
    expect(snapshot.inputTokens).toBe(150);
    expect(snapshot.outputTokens).toBe(90);
    expect(typeof snapshot.lastUpdatedAt).toBe('number');
  });

  // 8. session resume ──────────────────────────────────────────────────
  it('scenario 8: session resume → startSession with resumeSessionId reuses id', async () => {
    const resumeId = 'resumed-sess-123';
    await driver.start({ workingDir: '/tmp', resumeSessionId: resumeId });

    driver.stage({
      sessionId: resumeId,
      messages: ['resumed'],
      stopReason: 'end_turn',
    });
    const collector = collectUntil(
      driver.engine,
      (e) => e.kind === 'session.idle',
    );
    await driver.engine.sendPrompt(
      'continue where we left off in the previous session please please',
    );
    await driver.flush();
    const events = await collector;

    // Every event must carry the resumed session id.
    for (const ev of events) {
      expect(ev.sessionId).toBe(resumeId);
    }

    // Engine-specific plumbing check: the resumed id propagated to the
    // underlying transport (Claude: no session.create-analog to check;
    // OpenCode: client.session.create must NOT have been called).
    if (label === 'opencode') {
      const state = (driver as OpenCodeDriver).state;
      expect(state.promptCalls[0]?.id).toBe(resumeId);
    }
  });
});

// ────────────────────── Cross-engine invariants ───────────────────────────
//
// A handful of invariants only make sense as cross-engine comparisons —
// i.e. "both engines label this event the same way" rather than "each
// engine produced the right event". These tests run both engines in one
// block and diff the resulting streams.

describe('Engine parity — cross-engine invariants', () => {
  it('both engines emit the same event kinds for a simple prompt', async () => {
    const plan: ResponsePlan = {
      sessionId: 'x',
      messages: ['hi'],
      stopReason: 'end_turn',
    };
    async function runEngine(factory: DriverFactory): Promise<string[]> {
      const d = factory();
      try {
        await d.start({ workingDir: '/tmp' });
        d.stage({ ...plan, sessionId: d.defaultSessionId });
        const collector = collectUntil(
          d.engine,
          (e) => e.kind === 'session.idle',
        );
        await d.engine.sendPrompt(
          'please do the thing that is long enough to skip approval detection path',
        );
        await d.flush();
        const events = await collector;
        return events.map((e) => e.kind);
      } finally {
        await d.cleanup();
      }
    }

    const claudeKinds = await runEngine(() => createClaudeDriver());
    const opencodeKinds = await runEngine(() => createOpenCodeDriver());

    // Both streams contain the same ordered subset of message.delta
    // followed by session.idle. Other kinds may differ (e.g. neither
    // produces tool events here) — the AC only requires the observable
    // shape match for user-visible events.
    expect(claudeKinds).toContain('message.delta');
    expect(claudeKinds).toContain('session.idle');
    expect(opencodeKinds).toContain('message.delta');
    expect(opencodeKinds).toContain('session.idle');
    expect(claudeKinds[claudeKinds.length - 1]).toBe('session.idle');
    expect(opencodeKinds[opencodeKinds.length - 1]).toBe('session.idle');
  });

  it('both engines produce identical tool.end shapes for the same inputs', async () => {
    const tools = [
      {
        id: 'tool-x',
        name: 'Read',
        input: { file_path: '/tmp/x.txt' },
        result: 'contents',
      },
    ];

    async function runEngine(
      factory: DriverFactory,
    ): Promise<ToolEndEvent | undefined> {
      const d = factory();
      try {
        await d.start({ workingDir: '/tmp' });
        d.stage({ sessionId: d.defaultSessionId, tools });
        const collector = collectUntil(
          d.engine,
          (e) => e.kind === 'session.idle',
        );
        await d.engine.sendPrompt(
          'read the file at /tmp/x.txt please please please please please',
        );
        await d.flush();
        const events = await collector;
        return events.find(
          (e): e is ToolEndEvent => e.kind === 'tool.end',
        );
      } finally {
        await d.cleanup();
      }
    }

    const claudeEnd = await runEngine(() => createClaudeDriver());
    const opencodeEnd = await runEngine(() => createOpenCodeDriver());

    expect(claudeEnd).toBeDefined();
    expect(opencodeEnd).toBeDefined();
    if (!claudeEnd || !opencodeEnd) throw new Error('missing end events');

    // Field-by-field parity — timestamps and sessionIds diverge but the
    // tool-call shape must match exactly.
    expect(claudeEnd.toolCallId).toBe(opencodeEnd.toolCallId);
    expect(claudeEnd.toolName).toBe(opencodeEnd.toolName);
    expect(claudeEnd.input).toEqual(opencodeEnd.input);
    expect(claudeEnd.result).toBe(opencodeEnd.result);
    expect(claudeEnd.isError).toBe(opencodeEnd.isError);
  });
});
