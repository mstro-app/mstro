import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('../headless-session-handler.js', () => ({
  handleHeadlessSession: vi.fn().mockResolvedValue({
    ok: true,
    result: {
      sessionId: 'mock-session-1',
      completed: true,
      totalTokens: 200,
      durationMs: 1500,
    },
  }),
  getBoardExecutionStatus: vi.fn(),
}));

vi.mock('../board-execution-handler.js', () => ({
  startBoardExecution: vi.fn().mockReturnValue({
    ok: true,
    jobId: 'board-exec-mock-1',
  }),
  getBoardExecutionStatus: vi.fn().mockReturnValue(null),
}));

import {
  createAiBrokerRoutes,
  getDeployTokenRecord,
  registerDeployToken,
  unregisterDeployToken,
  updateDeployTokenConfig,
} from '../ai-broker.js';
import {
  getBoardExecutionStatus as getBoardExecStatus,
  startBoardExecution,
} from '../board-execution-handler.js';
import { handleHeadlessSession } from '../headless-session-handler.js';

// ── Helpers ──────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const RAW_TOKEN = 'dpt_test_token_abc123';
const TOKEN_HASH = hashToken(RAW_TOKEN);

function makeTokenRecord(overrides: Record<string, unknown> = {}) {
  return {
    deploymentId: 'deploy-1',
    tokenHash: TOKEN_HASH,
    capabilities: ['headless', 'pm-board'] as ('headless' | 'pm-board')[],
    rateLimit: {
      maxRequestsPerMinute: 60,
      maxConcurrentSessions: 5,
    },
    aiConfig: {
      aiEnabled: true,
      defaultSystemPrompt: null,
      defaultModel: 'sonnet',
      maxTokensPerRequest: 10000,
      workingDir: '/tmp/deploy',
      allowedBoardTemplateIds: ['BOARD-001', 'BOARD-002'],
      maxConcurrentBoardExecutions: 3,
      maxBoardExecutionsPerMinute: 10,
    },
    enabled: true,
    ...overrides,
  };
}

function makeInvokeBody(overrides: Record<string, unknown> = {}) {
  return {
    capability: 'headless',
    deploymentId: 'deploy-1',
    endUserId: 'user-1',
    prompt: 'Hello AI',
    ...overrides,
  };
}

// Hono test helper — creates a request and runs it through the routes
async function invokeRoute(
  method: 'POST' | 'GET',
  path: string,
  options: {
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const app = createAiBrokerRoutes();
  const url = `http://localhost${path}`;

  const init: RequestInit = { method, headers: options.headers ?? {} };
  if (options.body) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const req = new Request(url, init);
  return app.fetch(req);
}

// ── Tests ────────────────────────────────────────────────────────

describe('Token Store', () => {
  afterEach(() => {
    unregisterDeployToken('deploy-1');
    unregisterDeployToken('deploy-2');
  });

  it('registers and retrieves a deploy token record', () => {
    const record = makeTokenRecord();
    registerDeployToken(record);

    const retrieved = getDeployTokenRecord('deploy-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.tokenHash).toBe(TOKEN_HASH);
    expect(retrieved!.capabilities).toContain('headless');
  });

  it('unregisters a deploy token', () => {
    registerDeployToken(makeTokenRecord());
    unregisterDeployToken('deploy-1');

    expect(getDeployTokenRecord('deploy-1')).toBeUndefined();
  });

  it('returns undefined for non-existent deployment', () => {
    expect(getDeployTokenRecord('nonexistent')).toBeUndefined();
  });
});

describe('updateDeployTokenConfig', () => {
  afterEach(() => {
    unregisterDeployToken('deploy-1');
  });

  it('updates rate limit fields on existing record', () => {
    registerDeployToken(makeTokenRecord());

    const updated = updateDeployTokenConfig('deploy-1', {
      maxRequestsPerMinute: 30,
      maxConcurrentSessions: 2,
    });

    expect(updated).toBe(true);
    const record = getDeployTokenRecord('deploy-1');
    expect(record!.rateLimit.maxRequestsPerMinute).toBe(30);
    expect(record!.rateLimit.maxConcurrentSessions).toBe(2);
  });

  it('updates AI config fields', () => {
    registerDeployToken(makeTokenRecord());

    updateDeployTokenConfig('deploy-1', {
      maxTokensPerRequest: 5000,
      aiEnabled: false,
    });

    const record = getDeployTokenRecord('deploy-1');
    expect(record!.aiConfig.maxTokensPerRequest).toBe(5000);
    expect(record!.aiConfig.aiEnabled).toBe(false);
  });

  it('returns false for non-existent deployment', () => {
    expect(updateDeployTokenConfig('nonexistent', {})).toBe(false);
  });
});

describe('Deploy Token Validation (SHA-256)', () => {
  afterEach(() => {
    unregisterDeployToken('deploy-1');
  });

  it('accepts a valid token (SHA-256 hash matches)', async () => {
    registerDeployToken(makeTokenRecord());

    const res = await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody(),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    // Should NOT be 401 — token is valid
    expect(res.status).not.toBe(401);
  });

  it('rejects an invalid token (hash mismatch)', async () => {
    registerDeployToken(makeTokenRecord());

    const res = await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody(),
      headers: { Authorization: 'Bearer wrong_token_value' },
    });

    expect(res.status).toBe(401);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Invalid deploy token/i);
  });

  it('rejects missing Authorization header', async () => {
    registerDeployToken(makeTokenRecord());

    const res = await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody(),
    });

    expect(res.status).toBe(401);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Missing or malformed Authorization/i);
  });

  it('rejects malformed Authorization header (no Bearer prefix)', async () => {
    registerDeployToken(makeTokenRecord());

    const res = await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody(),
      headers: { Authorization: `Basic ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(401);
  });

  it('rejects when deployment is disabled', async () => {
    registerDeployToken(makeTokenRecord({ enabled: false }));

    const res = await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody(),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(403);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/disabled/i);
  });

  it('rejects when AI is not enabled', async () => {
    registerDeployToken(makeTokenRecord({
      aiConfig: {
        ...makeTokenRecord().aiConfig,
        aiEnabled: false,
      },
    }));

    const res = await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody(),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(403);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/AI features are not enabled/i);
  });
});

describe('Capability Dispatch Routing', () => {
  afterEach(() => {
    unregisterDeployToken('deploy-1');
    vi.mocked(handleHeadlessSession).mockClear();
    vi.mocked(startBoardExecution).mockClear();
  });

  it('routes headless capability to handleHeadlessSession', async () => {
    registerDeployToken(makeTokenRecord());

    const res = await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody({ capability: 'headless' }),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    // Headless returns SSE stream — status should be 200
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  });

  it('routes pm-board capability to startBoardExecution', async () => {
    registerDeployToken(makeTokenRecord());

    const res = await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody({
        capability: 'pm-board',
        boardTemplateId: 'BOARD-001',
      }),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(202);
    const json = await res.json() as Record<string, unknown>;
    expect(json.jobId).toBeDefined();
    expect(json.statusUrl).toMatch(/\/api\/deploy\/ai\/jobs\//);
  });

  it('rejects invalid capability', async () => {
    registerDeployToken(makeTokenRecord());

    const res = await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody({ capability: 'invalid' }),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(400);
  });

  it('rejects capability not enabled for deployment', async () => {
    registerDeployToken(makeTokenRecord({
      capabilities: ['headless'], // pm-board not included
    }));

    const res = await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody({
        capability: 'pm-board',
        boardTemplateId: 'BOARD-001',
      }),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(403);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/not enabled/i);
  });

  it('requires boardTemplateId for pm-board capability', async () => {
    registerDeployToken(makeTokenRecord());

    const res = await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody({
        capability: 'pm-board',
        // no boardTemplateId
      }),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/boardTemplateId.*required/i);
  });
});

describe('Request Body Validation', () => {
  afterEach(() => {
    unregisterDeployToken('deploy-1');
  });

  it('rejects missing required fields', async () => {
    registerDeployToken(makeTokenRecord());

    const res = await invokeRoute('POST', '/invoke', {
      body: { capability: 'headless' }, // missing deploymentId, endUserId, prompt
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Missing required fields/i);
  });

  it('rejects invalid JSON body', async () => {
    registerDeployToken(makeTokenRecord());

    const app = createAiBrokerRoutes();
    const req = new Request('http://localhost/invoke', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RAW_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: 'not valid json{{{',
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });
});

describe('Rate Limiting', () => {
  beforeEach(() => {
    // Register a token with tight rate limits for testing
    registerDeployToken(makeTokenRecord({
      rateLimit: {
        maxRequestsPerMinute: 2,
        maxConcurrentSessions: 1,
      },
    }));
  });

  afterEach(() => {
    unregisterDeployToken('deploy-1');
  });

  it('returns 429 when concurrent session limit is exceeded', async () => {
    // First request — make handleHeadlessSession hang to hold the session open
    let resolveSession: (v: unknown) => void;
    const sessionPromise = new Promise((r) => { resolveSession = r; });

    vi.mocked(handleHeadlessSession).mockImplementationOnce(
      () => sessionPromise as ReturnType<typeof handleHeadlessSession>,
    );

    // First request starts (holds the only concurrent slot)
    const firstReq = invokeRoute('POST', '/invoke', {
      body: makeInvokeBody(),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    // Give Hono a tick to process the first request
    await new Promise((r) => setTimeout(r, 10));

    // Second request should be rate limited (concurrent sessions = 1)
    const secondRes = await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody(),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(secondRes.status).toBe(429);
    const json = await secondRes.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Rate limit/i);

    // Cleanup: resolve the hanging session
    resolveSession!({
      ok: true,
      result: { sessionId: 's', completed: true, totalTokens: 0, durationMs: 0 },
    });
    await firstReq;
  });

  it('returns 429 with Retry-After header when requests per minute exceeded', async () => {
    // Exhaust the 2 requests/minute limit
    vi.mocked(handleHeadlessSession).mockResolvedValue({
      ok: true,
      result: { sessionId: 's', completed: true, totalTokens: 0, durationMs: 0 },
    });

    // Use a fresh token record with higher concurrent limit but low RPM
    unregisterDeployToken('deploy-1');
    registerDeployToken(makeTokenRecord({
      rateLimit: {
        maxRequestsPerMinute: 2,
        maxConcurrentSessions: 10,
      },
    }));

    // Send 2 requests to fill the RPM bucket
    await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody(),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });
    await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody(),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    // Third request should hit RPM limit
    const res = await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody(),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeDefined();
  });
});

describe('Board Template Validation', () => {
  afterEach(() => {
    unregisterDeployToken('deploy-1');
    vi.mocked(startBoardExecution).mockClear();
  });

  it('passes allowed board template ID to startBoardExecution', async () => {
    registerDeployToken(makeTokenRecord());

    await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody({
        capability: 'pm-board',
        boardTemplateId: 'BOARD-001',
      }),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(startBoardExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        boardTemplateId: 'BOARD-001',
      }),
      expect.objectContaining({
        allowedBoardTemplateIds: ['BOARD-001', 'BOARD-002'],
      }),
    );
  });

  it('passes the config with allowedBoardTemplateIds from token record', async () => {
    registerDeployToken(makeTokenRecord({
      aiConfig: {
        ...makeTokenRecord().aiConfig,
        allowedBoardTemplateIds: ['ONLY-THIS-ONE'],
      },
    }));

    await invokeRoute('POST', '/invoke', {
      body: makeInvokeBody({
        capability: 'pm-board',
        boardTemplateId: 'ONLY-THIS-ONE',
      }),
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(startBoardExecution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        allowedBoardTemplateIds: ['ONLY-THIS-ONE'],
      }),
    );
  });
});

describe('Jobs Polling Endpoint', () => {
  afterEach(() => {
    vi.mocked(getBoardExecStatus).mockClear();
  });

  it('returns 404 for non-existent job', async () => {
    vi.mocked(getBoardExecStatus).mockReturnValue(null);

    const res = await invokeRoute('GET', '/jobs/nonexistent-job-id');
    expect(res.status).toBe(404);
  });

  it('returns job status when found', async () => {
    vi.mocked(getBoardExecStatus).mockReturnValue({
      jobId: 'board-exec-1',
      status: 'executing',
      progress: {
        phase: 'executing',
        issuesTotal: 5,
        issuesCompleted: 2,
        currentWaveIds: ['IS-003'],
      },
      result: null,
      error: null,
    });

    const res = await invokeRoute('GET', '/jobs/board-exec-1');
    expect(res.status).toBe(200);

    const json = await res.json() as Record<string, unknown>;
    expect(json.jobId).toBe('board-exec-1');
    expect(json.status).toBe('executing');
    expect((json.progress as Record<string, unknown>).issuesCompleted).toBe(2);
  });
});
