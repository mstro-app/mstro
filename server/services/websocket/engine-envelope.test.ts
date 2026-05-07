// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Engine envelope round-trip tests for IS-005.
 *
 * These verify that `engine?: 'claude-code' | 'opencode'` flows through the
 * WebSocket message envelope on prompt-send, session-state, and tab-state
 * messages — and that missing inbound fields default to 'claude-code'.
 *
 * Sessions and the session registry are faked so we exercise the handler
 * dispatch surface without spawning Claude or touching the filesystem.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// Stub quality-service so session-handlers can be imported without hitting it.
vi.mock('./quality-service.js', () => ({
  runQualityScan: vi.fn(() => Promise.resolve({ totals: { error: 0, warning: 0, info: 0 }, files: [] })),
}));

// Stub skill prompt resolution — treat every prompt as plain text.
vi.mock('./skill-handlers.js', () => ({
  resolveSkillPrompt: vi.fn(() => null),
  handleListSkills: vi.fn(),
}));

// Settings stubs (getModel/getEffortLevel are read by handleSessionMessage).
vi.mock('../settings.js', () => ({
  getModel: vi.fn(() => 'opus'),
  getEffortLevel: vi.fn(() => 'auto'),
  handleGetSettings: vi.fn(),
  handleUpdateSettings: vi.fn(),
  generateNotificationSummary: vi.fn(),
}));

import type { ImprovisationSessionManager } from '../../cli/improvisation-session-manager.js';
import { MsgIdTracker } from './msg-id-tracker.js';
import { handleSessionMessage, resolveEngineForSession, setupSessionListeners } from './session-handlers.js';
import { TabEventBufferRegistry } from './tab-event-buffer.js';
import { DEFAULT_ENGINE_ID, type EngineId, normalizeEngineId, type WebSocketResponse } from './types.js';

interface FakeSessionInfo {
  sessionId: string;
  startTime: string;
  workingDir: string;
  totalTokens: number;
  tokenBudgetThreshold: number;
  movementCount: number;
}

/**
 * Minimal EventEmitter-based stand-in for ImprovisationSessionManager. Exposes
 * the subset of the real manager's surface that setupSessionListeners/
 * handleSessionMessage touch.
 */
class FakeSession extends EventEmitter {
  readonly engine: string;
  readonly executionStartTimestamp: number | undefined = undefined;
  readonly isExecuting = false;
  public executePromptArgs: unknown[] = [];
  private sessionId: string;

  constructor(engine: string, sessionId = 'improv-fake') {
    super();
    this.engine = engine;
    this.sessionId = sessionId;
  }

  getSessionInfo(): FakeSessionInfo {
    return {
      sessionId: this.sessionId,
      startTime: new Date(0).toISOString(),
      workingDir: '/tmp/fake',
      totalTokens: 0,
      tokenBudgetThreshold: 170000,
      movementCount: 0,
    };
  }

  getHistory(): Record<string, unknown> {
    return { sessionId: this.sessionId, engine: this.engine, movements: [] };
  }

  getExecutionEventLog(): Array<Record<string, unknown>> {
    return [];
  }

  // Captures prompt arguments so tests can assert the engine envelope was
  // accepted (execute doesn't produce an immediate response — the listener
  // events do).
  executePrompt(...args: unknown[]): Promise<void> {
    this.executePromptArgs.push(args);
    return Promise.resolve();
  }

  destroy(): void {
    // no-op
  }
}

/** A minimal HandlerContext that captures all sent/broadcast responses. */
function createFakeContext() {
  const sent: Array<{ ws: object; response: WebSocketResponse }> = [];
  const broadcastAll: WebSocketResponse[] = [];
  const ws = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  const tabMap = new Map<string, string>();
  const sessions = new Map<string, ImprovisationSessionManager>();
  const connections = new Map<object, Map<string, string>>([[ws, tabMap]]);

  const ctx = {
    sessions,
    connections,
    allConnections: new Set([ws]),
    gitDirectories: new Map<string, string>(),
    gitBranches: new Map<string, string>(),
    activeSearches: new Map(),
    terminalSubscribers: new Map(),
    terminalListenerCleanups: new Map(),
    autocompleteService: {} as unknown,
    usageReporter: null,
    fileUploadHandler: null,
    gitHeadWatcher: null,
    skillsWatcher: null,
    tabEventBuffers: new TabEventBufferRegistry(),
    msgIdTracker: new MsgIdTracker(),
    getRegistry: vi.fn(() => ({
      markTabUnviewed: vi.fn(),
      markTabViewed: vi.fn(),
      markTabPersisted: vi.fn(),
      updateTabSession: vi.fn(),
    })),
    send: (target: object, response: WebSocketResponse) => {
      sent.push({ ws: target, response });
    },
    broadcastToOthers: vi.fn(),
    broadcastToAll: (response: WebSocketResponse) => {
      broadcastAll.push(response);
    },
    recordFileSelection: vi.fn(),
  };

  return { ctx, ws, sent, broadcastAll, tabMap, sessions };
}

describe('normalizeEngineId', () => {
  it('returns opencode when the input is exactly "opencode"', () => {
    expect(normalizeEngineId('opencode')).toBe('opencode');
  });

  it('returns claude-code for the claude-code input', () => {
    expect(normalizeEngineId('claude-code')).toBe('claude-code');
  });

  it('defaults to claude-code for undefined, null, empty, and unknown strings', () => {
    expect(normalizeEngineId(undefined)).toBe(DEFAULT_ENGINE_ID);
    expect(normalizeEngineId(null)).toBe(DEFAULT_ENGINE_ID);
    expect(normalizeEngineId('')).toBe(DEFAULT_ENGINE_ID);
    expect(normalizeEngineId('something-else')).toBe(DEFAULT_ENGINE_ID);
    expect(normalizeEngineId(42)).toBe(DEFAULT_ENGINE_ID);
  });
});

describe('resolveEngineForSession', () => {
  it('reads engine from the session', () => {
    const session = new FakeSession('opencode') as unknown as ImprovisationSessionManager;
    expect(resolveEngineForSession(session)).toBe('opencode');
  });

  it('defaults to claude-code for undefined session or unknown engine', () => {
    expect(resolveEngineForSession(undefined)).toBe('claude-code');
    const session = new FakeSession('bogus') as unknown as ImprovisationSessionManager;
    expect(resolveEngineForSession(session)).toBe('claude-code');
  });
});

describe('setupSessionListeners — outbound engine on session-state messages', () => {
  it('tags movementStart / tabStateChanged with the session engine', () => {
    const { ctx, ws, broadcastAll, tabMap, sessions } = createFakeContext();
    const session = new FakeSession('opencode');
    const tabId = 'tab-1';
    tabMap.set(tabId, 'improv-fake');
    sessions.set('improv-fake', session as unknown as ImprovisationSessionManager);

    setupSessionListeners(ctx as never, session as unknown as ImprovisationSessionManager, ws as never, tabId);

    session.emit('onMovementStart', 1, 'hello world', false);

    // Tab-scoped events go through broadcastTabEvent → broadcastToAll, with engine
    // attached to the wire envelope when supplied by setupSessionListeners.
    const movementStart = broadcastAll.find((r) => r.type === 'movementStart');
    expect(movementStart?.engine).toBe('opencode');

    const tabStateStart = broadcastAll.find((r) => r.type === 'tabStateChanged');
    expect(tabStateStart?.engine).toBe('opencode');
  });

  it('tags movementComplete, sessionUpdate, movementError with the session engine', () => {
    const { ctx, ws, broadcastAll } = createFakeContext();
    const session = new FakeSession('opencode');
    const tabId = 'tab-2';

    setupSessionListeners(ctx as never, session as unknown as ImprovisationSessionManager, ws as never, tabId);

    session.emit('onMovementComplete', { sequenceNumber: 1, tokensUsed: 0 });
    session.emit('onSessionUpdate', { sessionId: 'improv-fake', engine: 'opencode' });
    session.emit('onMovementError', new Error('boom'));

    const byType = (t: string) => broadcastAll.find((r) => r.type === t);
    expect(byType('movementComplete')?.engine).toBe('opencode');
    expect(byType('sessionUpdate')?.engine).toBe('opencode');
    expect(byType('movementError')?.engine).toBe('opencode');

    const tabStates = broadcastAll.filter((r) => r.type === 'tabStateChanged');
    expect(tabStates.length).toBeGreaterThanOrEqual(2);
    for (const r of tabStates) expect(r.engine).toBe('opencode');
  });

  it('defaults session engine to claude-code on outbound when session has no engine set', () => {
    const { ctx, ws, broadcastAll } = createFakeContext();
    const session = new FakeSession('' as string); // forces fallback
    setupSessionListeners(ctx as never, session as unknown as ImprovisationSessionManager, ws as never, 'tab-default');

    session.emit('onMovementStart', 1, 'prompt', false);
    const tabStateStart = broadcastAll.find((r) => r.type === 'tabStateChanged');
    expect(tabStateStart?.engine).toBe('claude-code');
  });
});

describe('handleSessionMessage — inbound execute envelope', () => {
  function setup(engine: string) {
    const { ctx, ws, tabMap, sessions } = createFakeContext();
    const session = new FakeSession(engine);
    const tabId = 'tab-exec';
    tabMap.set(tabId, 'improv-fake');
    sessions.set('improv-fake', session as unknown as ImprovisationSessionManager);
    return { ctx, ws, session, tabId };
  }

  it('accepts execute with explicit engine and forwards the prompt', () => {
    const { ctx, ws, session, tabId } = setup('opencode');
    handleSessionMessage(
      ctx as never,
      ws as never,
      { type: 'execute', tabId, engine: 'opencode', data: { prompt: 'hi' } },
      tabId,
    );
    expect(session.executePromptArgs.length).toBe(1);
  });

  it('accepts execute when engine field is missing (treat as claude-code)', () => {
    const { ctx, ws, session, tabId } = setup('claude-code');
    handleSessionMessage(
      ctx as never,
      ws as never,
      { type: 'execute', tabId, data: { prompt: 'hi' } },
      tabId,
    );
    expect(session.executePromptArgs.length).toBe(1);
  });

  it('accepts execute even when engine is an unknown value (defaults silently)', () => {
    const { ctx, ws, session, tabId } = setup('claude-code');
    handleSessionMessage(
      ctx as never,
      ws as never,
      // biome-ignore lint/suspicious/noExplicitAny: exercising the default path for invalid input
      { type: 'execute', tabId, engine: 'bogus' as any, data: { prompt: 'hi' } },
      tabId,
    );
    expect(session.executePromptArgs.length).toBe(1);
  });

  it('emits newSession response carrying the resolved engine', () => {
    const { ctx, ws, session, tabId } = setup('opencode');
    const sent: Array<{ response: WebSocketResponse }> = [];
    const ctx2 = {
      ...ctx,
      send: (_target: unknown, response: WebSocketResponse) => { sent.push({ response }); },
    };
    // stub startNewSession to return another FakeSession with the same engine
    (session as unknown as { startNewSession: () => FakeSession }).startNewSession = () => new FakeSession('opencode', 'improv-new');

    handleSessionMessage(
      ctx2 as never,
      ws as never,
      { type: 'new', tabId, engine: 'opencode', data: {} },
      tabId,
    );

    const ns = sent.find((e) => e.response.type === 'newSession')?.response;
    const engine: EngineId | undefined = ns?.engine;
    expect(engine).toBe('opencode');
  });
});
