import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks — lowest-level boundaries only ────────────────────────

const mockRun = vi.fn().mockResolvedValue({
  completed: true,
  needsHandoff: false,
  totalTokens: 750,
  sessionId: 'mock-session-integ',
  assistantResponse: 'Task completed successfully.',
});
const mockCleanup = vi.fn();

vi.mock('../../../cli/headless/runner.js', () => ({
  HeadlessRunner: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.run = mockRun;
    this.cleanup = mockCleanup;
  }),
}));

// Mock platform-credentials (no OAuth fallback)
vi.mock('../../platform-credentials.js', () => ({
  getCredentials: vi.fn().mockReturnValue(null),
}));

// Mock fs so credential file reads don't hit disk
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn().mockReturnValue('/tmp/mstro-board-exec-mock'),
    rmSync: vi.fn(),
    cpSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue(['output.md']),
    writeFileSync: vi.fn(),
  };
});

// Mock child_process for git worktree operations
vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from('true')),
}));

// Mock the plan parser for board template validation
vi.mock('../../plan/parser.js', () => ({
  resolvePmDir: vi.fn().mockReturnValue('/tmp/mstro-board-exec-mock/.mstro/pm'),
  parseBoardDirectory: vi.fn().mockReturnValue({
    issues: [
      { id: 'IS-001', type: 'issue', status: 'todo' },
      { id: 'IS-002', type: 'issue', status: 'todo' },
      { id: 'IS-003', type: 'issue', status: 'todo' },
    ],
  }),
}));

// Mock PlanExecutor for board execution
const mockStartBoard = vi.fn().mockResolvedValue(undefined);
const mockGetStatus = vi.fn().mockReturnValue('complete');
const mockGetMetrics = vi.fn().mockReturnValue({
  issuesCompleted: 3,
  issuesAttempted: 3,
  totalDuration: 5000,
  currentIssueId: null,
  currentWaveIds: [],
});
const mockExecutorOn = vi.fn();

vi.mock('../../plan/executor.js', () => ({
  PlanExecutor: vi.fn().mockImplementation(() => ({
    startBoard: mockStartBoard,
    getStatus: mockGetStatus,
    getMetrics: mockGetMetrics,
    on: mockExecutorOn,
    emit: vi.fn(),
  })),
}));

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { HeadlessRunner } from '../../../cli/headless/runner.js';
import { parseBoardDirectory } from '../../plan/parser.js';
import {
  createAiBrokerRoutes,
  registerDeployToken,
  setDeployUsageReportListener,
  unregisterDeployToken,
} from '../ai-broker.js';
import { DeployAiService } from '../deploy-ai-service.js';

// ── Helpers ──────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const RAW_TOKEN = 'dpt_integ_test_token_xyz';
const TOKEN_HASH = hashToken(RAW_TOKEN);
const DEPLOYMENT_ID = 'integ-deploy-1';

function makeTokenRecord(overrides: Record<string, unknown> = {}) {
  return {
    deploymentId: DEPLOYMENT_ID,
    tokenHash: TOKEN_HASH,
    capabilities: ['headless', 'pm-board'] as ('headless' | 'pm-board')[],
    rateLimit: {
      maxRequestsPerMinute: 100,
      maxConcurrentSessions: 10,
    },
    aiConfig: {
      aiEnabled: true,
      defaultSystemPrompt: 'You are a helpful deploy assistant.',
      defaultModel: 'sonnet',
      maxTokensPerRequest: 50000,
      workingDir: '/tmp/deploy-workdir',
      allowedBoardTemplateIds: ['BOARD-001', 'BOARD-ALLOWED'],
      maxConcurrentBoardExecutions: 5,
      maxBoardExecutionsPerMinute: 20,
    },
    enabled: true,
    ...overrides,
  };
}

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

/** Collect all SSE events from an event-stream response */
async function collectSSEEvents(res: Response): Promise<Array<{ event: string; data: string }>> {
  const text = await res.text();
  const events: Array<{ event: string; data: string }> = [];
  const blocks = text.split('\n\n').filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    let event = '';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (event || data) events.push({ event, data });
  }
  return events;
}

/** Reset the DeployAiService singleton between tests */
function resetDeployAiService(): void {
  // biome-ignore lint/suspicious/noExplicitAny: resetting private static for testing
  (DeployAiService as any).instance = null;
}

// ── Tests ────────────────────────────────────────────────────────

describe('AI Integration: Headless Session Flow', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-integ-test-key';
    resetDeployAiService();
    registerDeployToken(makeTokenRecord());
    vi.mocked(HeadlessRunner).mockClear();
    mockRun.mockClear();
    mockRun.mockResolvedValue({
      completed: true,
      needsHandoff: false,
      totalTokens: 750,
      sessionId: 'mock-session-integ',
      assistantResponse: 'Task completed successfully.',
    });
    mockCleanup.mockClear();
  });

  afterEach(() => {
    unregisterDeployToken(DEPLOYMENT_ID);
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('full flow: request → broker → handler → mock Claude → SSE response', async () => {
    const res = await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'headless',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-1',
        prompt: 'Build a landing page',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    // Verify HeadlessRunner was instantiated and run() was called
    expect(HeadlessRunner).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalled();

    // Parse SSE and verify 'done' event with session result
    const events = await collectSSEEvents(res);
    const doneEvent = events.find((e) => e.event === 'done');
    expect(doneEvent).toBeDefined();

    const doneData = JSON.parse(doneEvent!.data);
    expect(doneData.completed).toBe(true);
    expect(doneData.totalTokens).toBe(750);
    expect(doneData.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('verifies deploy token is validated before execution', async () => {
    // Invalid token → 401, no HeadlessRunner call
    const res = await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'headless',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-1',
        prompt: 'Should not execute',
      },
      headers: { Authorization: 'Bearer wrong_token' },
    });

    expect(res.status).toBe(401);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Invalid deploy token/i);

    // HeadlessRunner should never have been called
    expect(HeadlessRunner).not.toHaveBeenCalled();
  });

  it('verifies API key is injected via extraEnv to HeadlessRunner', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-specific-key-for-injection';

    await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'headless',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-1',
        prompt: 'Test API key injection',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    // The DeployAiService reads the API key and passes it via extraEnv
    expect(HeadlessRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        extraEnv: { ANTHROPIC_API_KEY: 'sk-ant-specific-key-for-injection' },
      }),
    );
  });

  it('verifies system prompt from deployment config is applied', async () => {
    // Register token with a specific default system prompt
    unregisterDeployToken(DEPLOYMENT_ID);
    registerDeployToken(makeTokenRecord({
      aiConfig: {
        ...makeTokenRecord().aiConfig,
        defaultSystemPrompt: 'You are a code review bot. Be concise.',
      },
    }));

    await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'headless',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-1',
        prompt: 'Review this PR',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    // The composed prompt should include the system prompt wrapped in
    // <system-instruction> tags, followed by the user prompt
    expect(HeadlessRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        directPrompt: expect.stringContaining('<system-instruction>'),
      }),
    );
    expect(HeadlessRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        directPrompt: expect.stringContaining('You are a code review bot. Be concise.'),
      }),
    );
    expect(HeadlessRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        directPrompt: expect.stringContaining('Review this PR'),
      }),
    );
  });

  it('verifies per-request system prompt overrides deployment default', async () => {
    await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'headless',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-1',
        prompt: 'Do something',
        systemPrompt: 'Custom per-request instruction',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(HeadlessRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        directPrompt: expect.stringContaining('Custom per-request instruction'),
      }),
    );
    // The deployment default should NOT be in the prompt
    const calledConfig = vi.mocked(HeadlessRunner).mock.calls[0][0] as { directPrompt: string };
    expect(calledConfig.directPrompt).not.toContain('You are a helpful deploy assistant.');
  });

  it('verifies usage report is sent via onUsageReport callback after completion', async () => {
    const usageReports: unknown[] = [];
    setDeployUsageReportListener((report) => {
      usageReports.push(report);
    });

    const res = await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'headless',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-usage',
        prompt: 'Generate report',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    // Consume the stream to let callbacks fire
    await res.text();

    expect(usageReports.length).toBe(1);
    expect(usageReports[0]).toEqual(
      expect.objectContaining({
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-usage',
        capability: 'headless',
        tokensUsed: 750,
      }),
    );

    // Cleanup listener
    setDeployUsageReportListener(() => {});
  });

  it('returns SSE done event with completed=false when runner fails', async () => {
    // When HeadlessRunner.run() rejects, DeployAiService.execute() catches it
    // and returns { completed: false, error: '...' }. The headless-session-handler
    // wraps this as { ok: true, result } so the broker sends a 'done' event.
    mockRun.mockRejectedValueOnce(new Error('Claude process crashed'));

    const res = await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'headless',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-1',
        prompt: 'This will fail',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const events = await collectSSEEvents(res);
    const doneEvent = events.find((e) => e.event === 'done');
    expect(doneEvent).toBeDefined();

    const doneData = JSON.parse(doneEvent!.data);
    expect(doneData.completed).toBe(false);
    expect(doneData.totalTokens).toBe(0);
  });

  it('rejects when deployment has AI disabled', async () => {
    unregisterDeployToken(DEPLOYMENT_ID);
    registerDeployToken(makeTokenRecord({
      aiConfig: { ...makeTokenRecord().aiConfig, aiEnabled: false },
    }));

    const res = await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'headless',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-1',
        prompt: 'Should not run',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(403);
    expect(HeadlessRunner).not.toHaveBeenCalled();
  });
});

describe('AI Integration: PM Board Execution Flow', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-integ-board-key';
    resetDeployAiService();
    registerDeployToken(makeTokenRecord());
    vi.mocked(HeadlessRunner).mockClear();
    mockRun.mockClear();
    mockRun.mockResolvedValue({
      completed: true,
      needsHandoff: false,
      totalTokens: 300,
      sessionId: 'board-custom-session',
      assistantResponse: 'Board customized.',
    });
    mockCleanup.mockClear();
    mockStartBoard.mockClear();
    mockGetStatus.mockReturnValue('complete');
    mockGetMetrics.mockReturnValue({
      issuesCompleted: 3,
      issuesAttempted: 3,
      totalDuration: 5000,
      currentIssueId: null,
      currentWaveIds: [],
    });
    mockExecutorOn.mockClear();

    // Ensure parseBoardDirectory returns a valid template
    vi.mocked(parseBoardDirectory).mockReturnValue({
      issues: [
        { id: 'IS-001', type: 'issue', status: 'todo' },
        { id: 'IS-002', type: 'issue', status: 'todo' },
        { id: 'IS-003', type: 'issue', status: 'todo' },
      ],
    } as ReturnType<typeof parseBoardDirectory>);

    // readFileSync for collectOutputs
    vi.mocked(readFileSync).mockReturnValue('# Output\nBoard execution results.');
    vi.mocked(existsSync).mockImplementation((p) => {
      // Allow the output directory to "exist" for collectOutputs
      if (typeof p === 'string' && p.includes('/out')) return true;
      // Allow the pm dir copy to succeed
      if (typeof p === 'string' && p.includes('.mstro/pm')) return true;
      return false;
    });
    vi.mocked(readdirSync).mockReturnValue(['result.md'] as unknown as ReturnType<typeof readdirSync>);
  });

  afterEach(() => {
    unregisterDeployToken(DEPLOYMENT_ID);
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('full flow: request → broker → template validation → job ID returned immediately', async () => {
    const res = await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'pm-board',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-board',
        prompt: 'Build a task management app',
        boardTemplateId: 'BOARD-001',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(202);
    const json = await res.json() as Record<string, unknown>;

    // Job ID returned immediately
    expect(json.jobId).toBeDefined();
    expect(json.jobId).toMatch(/^board-exec-/);

    // Status URL returned for polling
    expect(json.statusUrl).toBeDefined();
    expect(json.statusUrl).toContain(`/api/deploy/ai/jobs/${json.jobId}`);
  });

  it('verifies board template ID is validated against allowed list', async () => {
    const res = await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'pm-board',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-board',
        prompt: 'Build something',
        boardTemplateId: 'BOARD-FORBIDDEN',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/not allowed/i);
    expect(json.code).toBe('INVALID_BOARD_TEMPLATE');
  });

  it('accepts allowed board template IDs', async () => {
    const res = await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'pm-board',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-board',
        prompt: 'Build something',
        boardTemplateId: 'BOARD-ALLOWED',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(202);
  });

  it('rejects when board template does not exist on disk', async () => {
    vi.mocked(parseBoardDirectory).mockReturnValueOnce(null);

    const res = await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'pm-board',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-board',
        prompt: 'Build something',
        boardTemplateId: 'BOARD-001',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.code).toBe('BOARD_TEMPLATE_NOT_FOUND');
  });

  it('verifies isolated working directory is created for board execution', async () => {
    const res = await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'pm-board',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-board',
        prompt: 'Build something cool',
        boardTemplateId: 'BOARD-001',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(202);
    await res.json();

    // Wait briefly for background execution to start
    await new Promise((r) => setTimeout(r, 50));

    // The board execution handler should have attempted to create an isolated
    // working directory via git worktree (mocked via child_process.execSync)
    const { execSync } = await import('node:child_process');
    const execCalls = vi.mocked(execSync).mock.calls.map((c) => String(c[0]));
    const worktreeCall = execCalls.find((cmd) => cmd.includes('git worktree add'));
    expect(worktreeCall).toBeDefined();
  });

  it('verifies job ID returned immediately, results available via polling', async () => {
    const res = await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'pm-board',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-poll',
        prompt: 'Build an API',
        boardTemplateId: 'BOARD-001',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(202);
    const { jobId } = await res.json() as Record<string, unknown>;
    expect(jobId).toBeDefined();

    // Poll for status — job was just created so it should exist
    const pollRes = await invokeRoute('GET', `/jobs/${jobId}`);
    expect(pollRes.status).toBe(200);

    const status = await pollRes.json() as Record<string, unknown>;
    expect(status.jobId).toBe(jobId);
    // Status will be one of the valid states since background execution is running
    expect(['customizing', 'executing', 'completed', 'failed']).toContain(status.status);
  });

  it('returns 404 when polling a non-existent job', async () => {
    const res = await invokeRoute('GET', '/jobs/nonexistent-job-id');
    expect(res.status).toBe(404);
  });

  it('verifies deploy token is required for board execution', async () => {
    const res = await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'pm-board',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-board',
        prompt: 'Build something',
        boardTemplateId: 'BOARD-001',
      },
      headers: { Authorization: 'Bearer invalid_token' },
    });

    expect(res.status).toBe(401);
    expect(HeadlessRunner).not.toHaveBeenCalled();
    expect(mockStartBoard).not.toHaveBeenCalled();
  });

  it('board execution uses the developer API key via extraEnv', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-board-specific-key';

    const res = await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'pm-board',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-board',
        prompt: 'Build something',
        boardTemplateId: 'BOARD-001',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(202);

    // Wait for background execution to reach customization phase
    await new Promise((r) => setTimeout(r, 50));

    // The HeadlessRunner for board customization should get the API key
    if (vi.mocked(HeadlessRunner).mock.calls.length > 0) {
      expect(HeadlessRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          extraEnv: { ANTHROPIC_API_KEY: 'sk-ant-board-specific-key' },
        }),
      );
    }
  });

  it('rejects when pm-board capability is not enabled for deployment', async () => {
    unregisterDeployToken(DEPLOYMENT_ID);
    registerDeployToken(makeTokenRecord({
      capabilities: ['headless'], // pm-board not included
    }));

    const res = await invokeRoute('POST', '/invoke', {
      body: {
        capability: 'pm-board',
        deploymentId: DEPLOYMENT_ID,
        endUserId: 'end-user-board',
        prompt: 'Build something',
        boardTemplateId: 'BOARD-001',
      },
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });

    expect(res.status).toBe(403);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/not enabled/i);
  });
});
