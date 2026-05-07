// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Engine contract tests — validate that the concrete ClaudeCodeEngine
 * satisfies the CodingAgentEngine interface for the four scenarios called
 * out by IS-002: simple prompt, tool call, cancel, and usage.
 *
 * The tests mock `executeClaudeCommand` so no real Claude CLI subprocess is
 * spawned — we simulate the stream by invoking the HeadlessRunner callbacks
 * the mock receives.
 */

import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeInvokerOptions } from '../cli/headless/claude-invoker.js';
import type { ExecutionResult } from '../cli/headless/types.js';
import { ClaudeCodeEngine } from './claude/ClaudeCodeEngine.js';
import type { EngineEvent, MessageDeltaEvent, ToolEndEvent, ToolStartEvent, UsageUpdateEvent } from './EngineEvent.js';
import { createEngine } from './factory.js';

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

// enrichPromptWithContext calls detectApproval → may spawn a real `claude`
// binary for short prompts. Stub it out so tests stay hermetic.
vi.mock('../cli/headless/prompt-utils.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../cli/headless/prompt-utils.js')>();
  return {
    ...orig,
    enrichPromptWithContext: async (prompt: string) => prompt,
  };
});

// HeadlessRunner.cleanup() ultimately calls process.kill(-pid, signal). Without
// this spy, a real SIGTERM could be delivered to the test process group.
const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(
  // biome-ignore lint/suspicious/noExplicitAny: match process.kill return
  () => true as any,
);

afterEach(() => {
  processKillSpy.mockClear();
  invokerState.impl = async () => ({ output: '', exitCode: 0 });
});

/** Collect engine events until `predicate` returns true or `timeoutMs` elapses. */
async function collectUntil(
  engine: AsyncIterable<EngineEvent>,
  predicate: (event: EngineEvent) => boolean,
  timeoutMs = 2000,
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

describe('ClaudeCodeEngine — CodingAgentEngine contract', () => {
  it('factory returns ClaudeCodeEngine for engineId "claude-code"', () => {
    const engine = createEngine('claude-code');
    expect(engine).toBeInstanceOf(ClaudeCodeEngine);
    expect(engine.engineId).toBe('claude-code');
  });

  it('factory returns a LazyOpenCodeEngine adapter for engineId "opencode"', () => {
    // The opencode branch is backed by a shared OpenCodeServerManager that
    // only spawns the subprocess when startSession runs. Construction must
    // remain side-effect-free so factory wiring stays safe in tests.
    // IS-020: OpenCode paths are feature-flagged — opt in explicitly here
    // so this contract check keeps testing the opencode branch regardless
    // of the caller's environment defaults.
    const prevFlag = process.env.MSTRO_ENABLE_ENGINE_SWAP;
    process.env.MSTRO_ENABLE_ENGINE_SWAP = 'true';
    try {
      const engine = createEngine('opencode');
      expect(engine.engineId).toBe('opencode');
    } finally {
      if (prevFlag === undefined) delete process.env.MSTRO_ENABLE_ENGINE_SWAP;
      else process.env.MSTRO_ENABLE_ENGINE_SWAP = prevFlag;
    }
  });

  it('streams a simple prompt as message.delta events followed by session.idle', async () => {
    invokerState.impl = async (_prompt, _promptId, _sessionNumber, { config }) => {
      config.outputCallback?.('Hello ');
      config.outputCallback?.('world');
      return {
        output: '',
        exitCode: 0,
        assistantResponse: 'Hello world',
        claudeSessionId: 'sess-simple',
        stopReason: 'end_turn',
      };
    };

    const engine = createEngine('claude-code');
    await engine.startSession({ workingDir: '/tmp' });
    const collector = collectUntil(engine, (ev) => ev.kind === 'session.idle');
    await engine.sendPrompt('please do the thing that is long enough to skip approval detection path');
    const events = await collector;

    const deltas = events.filter((e): e is MessageDeltaEvent => e.kind === 'message.delta');
    expect(deltas.map((e) => e.text).join('')).toBe('Hello world');

    const idle = events.find((e) => e.kind === 'session.idle');
    expect(idle).toBeDefined();
    if (idle && idle.kind === 'session.idle') {
      expect(idle.stopReason).toBe('end_turn');
      expect(idle.sessionId).toBe('sess-simple');
    }
    for (const ev of events) {
      expect(typeof ev.timestamp).toBe('number');
    }

    await engine.dispose();
  });

  it('emits tool.start then tool.end with engine-agnostic id and captured input/result', async () => {
    invokerState.impl = async (_prompt, _promptId, _sessionNumber, { config }) => {
      config.toolUseCallback?.({
        type: 'tool_start', toolName: 'Read', toolId: 'tu_abc', index: 0,
      });
      config.toolUseCallback?.({
        type: 'tool_complete', toolName: 'Read', toolId: 'tu_abc',
        index: 0, completeInput: { file_path: '/tmp/x.txt' },
      });
      config.toolUseCallback?.({
        type: 'tool_result', toolId: 'tu_abc', result: 'file contents', isError: false,
      });
      return {
        output: '',
        exitCode: 0,
        claudeSessionId: 'sess-tool',
      };
    };

    const engine = createEngine('claude-code');
    await engine.startSession({ workingDir: '/tmp' });
    const collector = collectUntil(engine, (ev) => ev.kind === 'session.idle');
    await engine.sendPrompt('read the file at /tmp/x.txt please please please please');
    const events = await collector;

    const start = events.find((e): e is ToolStartEvent => e.kind === 'tool.start');
    const end = events.find((e): e is ToolEndEvent => e.kind === 'tool.end');
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    if (!start || !end) throw new Error('expected tool events');

    expect(start.toolCallId).toBe('tu_abc');
    expect(start.toolName).toBe('Read');
    expect(end.toolCallId).toBe('tu_abc');
    expect(end.toolName).toBe('Read');
    expect(end.input).toEqual({ file_path: '/tmp/x.txt' });
    expect(end.result).toBe('file contents');
    expect(end.isError).toBe(false);
    expect(end.durationMs).toBeGreaterThanOrEqual(0);

    // Ordering invariant: tool.start must precede tool.end.
    const startIdx = events.indexOf(start);
    const endIdx = events.indexOf(end);
    expect(startIdx).toBeLessThan(endIdx);

    await engine.dispose();
  });

  it('surfaces token usage as usage.update events and keeps getUsage() in sync', async () => {
    invokerState.impl = async (_prompt, _promptId, _sessionNumber, { config }) => {
      config.tokenUsageCallback?.({ inputTokens: 100, outputTokens: 50 });
      config.tokenUsageCallback?.({ inputTokens: 120, outputTokens: 80 });
      return {
        output: '',
        exitCode: 0,
        claudeSessionId: 'sess-usage',
        apiTokenUsage: { inputTokens: 120, outputTokens: 80 },
      };
    };

    const engine = createEngine('claude-code');
    await engine.startSession({ workingDir: '/tmp' });

    expect(engine.getUsage()).toEqual(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0 }),
    );

    const collector = collectUntil(engine, (ev) => ev.kind === 'session.idle');
    await engine.sendPrompt('count tokens for me please please please please please please');
    const events = await collector;

    const usages = events.filter((e): e is UsageUpdateEvent => e.kind === 'usage.update');
    expect(usages).toHaveLength(2);
    expect(usages[0].inputTokens).toBe(100);
    expect(usages[0].outputTokens).toBe(50);
    expect(usages[1].inputTokens).toBe(120);
    expect(usages[1].outputTokens).toBe(80);

    // Monotonic non-decreasing — contract guarantee.
    expect(usages[1].inputTokens).toBeGreaterThanOrEqual(usages[0].inputTokens);
    expect(usages[1].outputTokens).toBeGreaterThanOrEqual(usages[0].outputTokens);

    const snapshot = engine.getUsage();
    expect(snapshot.inputTokens).toBe(120);
    expect(snapshot.outputTokens).toBe(80);

    await engine.dispose();
  });

  it('cancel() propagates SIGTERM to the tracked child process group', async () => {
    let resolveRun: ((r: ExecutionResult) => void) | undefined;
    let registeredPid: number | undefined;

    invokerState.impl = (_prompt, _promptId, _sessionNumber, { runningProcesses }) => {
      registeredPid = 99_001;
      const fakeProc = { kill: vi.fn(), killed: false, exitCode: null } as unknown as ChildProcess;
      runningProcesses.set(registeredPid, fakeProc);
      return new Promise<ExecutionResult>((resolve) => {
        resolveRun = resolve;
      });
    };

    const engine = createEngine('claude-code');
    await engine.startSession({ workingDir: '/tmp' });
    await engine.sendPrompt('long running task long enough to skip fast approval detection path');

    // Let the mocked invoker run far enough to register the fake child.
    await new Promise((r) => setTimeout(r, 0));
    expect(registeredPid).toBe(99_001);

    const cancelPromise = engine.cancel();
    // Unblock the mock so cancel's internal await on the run promise can resolve.
    resolveRun?.({ output: '', exitCode: 143, signalName: 'SIGTERM' });
    await cancelPromise;

    expect(processKillSpy).toHaveBeenCalledWith(-99_001, 'SIGTERM');

    await engine.dispose();
  });
});
