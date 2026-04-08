import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────

const mockRun = vi.fn().mockResolvedValue({
  completed: true,
  needsHandoff: false,
  totalTokens: 500,
  sessionId: 'mock-session',
  assistantResponse: 'Done.',
});
const mockCleanup = vi.fn();

// Mock HeadlessRunner. Must use `function` (not arrow) so vi.fn() is constructor-compatible.
vi.mock('../../../cli/headless/runner.js', () => ({
  HeadlessRunner: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.run = mockRun;
    this.cleanup = mockCleanup;
  }),
}));

// Mock platform-credentials
vi.mock('../../platform-credentials.js', () => ({
  getCredentials: vi.fn().mockReturnValue(null),
}));

// Mock fs to control credential file reads
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
  };
});

import { existsSync } from 'node:fs';
import { HeadlessRunner } from '../../../cli/headless/runner.js';
import { getCredentials } from '../../platform-credentials.js';
import {
  DeployAiService,
  DeployApiKeyError,
  type DeploySession,
  readOwnerApiCredential,
} from '../deploy-ai-service.js';

// ── Helpers ──────────────────────────────────────────────────────

function makeService(): DeployAiService {
  // Reset singleton between tests
  // biome-ignore lint/suspicious/noExplicitAny: resetting private static for testing
  (DeployAiService as any).instance = null;
  return DeployAiService.getInstance();
}

/** Access private sessions map */
function getSessions(svc: DeployAiService): Map<string, DeploySession> {
  // biome-ignore lint/suspicious/noExplicitAny: accessing private member for testing
  return (svc as any).sessions;
}

/** Insert a fake running session into the service for limit/management tests */
function injectSession(svc: DeployAiService, id: string, deploymentId: string, status: DeploySession['status'] = 'running'): DeploySession {
  const session: DeploySession = {
    id,
    deploymentId,
    runner: { cleanup: vi.fn(), run: vi.fn() } as unknown as DeploySession['runner'],
    startedAt: Date.now(),
    status,
  };
  getSessions(svc).set(id, session);
  return session;
}

const baseOptions = {
  deploymentId: 'deploy-1',
  prompt: 'Test prompt',
  workingDir: '/tmp/test',
};

// ── Tests ────────────────────────────────────────────────────────

describe('readOwnerApiCredential', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(getCredentials).mockReturnValue(null);
  });

  describe('API key resolution order', () => {
    it('returns env var key with highest priority', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-123';
      const result = readOwnerApiCredential();
      expect(result).toEqual({
        type: 'api-key',
        key: 'sk-ant-test-key-123',
        source: 'env',
      });
    });

    it('trims whitespace from env var key', () => {
      process.env.ANTHROPIC_API_KEY = '  sk-ant-trimmed  ';
      const result = readOwnerApiCredential();
      expect(result).toEqual({
        type: 'api-key',
        key: 'sk-ant-trimmed',
        source: 'env',
      });
    });

    it('skips empty env var and falls through', () => {
      process.env.ANTHROPIC_API_KEY = '';
      vi.mocked(getCredentials).mockReturnValue({ token: 'some-oauth-token' } as ReturnType<typeof getCredentials>);
      const result = readOwnerApiCredential();
      expect(result).toEqual({ type: 'oauth' });
    });

    it('skips whitespace-only env var and falls through', () => {
      process.env.ANTHROPIC_API_KEY = '   ';
      vi.mocked(getCredentials).mockReturnValue(null);
      const result = readOwnerApiCredential();
      expect(result).toBeNull();
    });

    it('returns oauth when platform credentials exist but no API key', () => {
      delete process.env.ANTHROPIC_API_KEY;
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(getCredentials).mockReturnValue({ token: 'oauth-token' } as ReturnType<typeof getCredentials>);
      const result = readOwnerApiCredential();
      expect(result).toEqual({ type: 'oauth' });
    });

    it('returns null when no credentials exist at all', () => {
      delete process.env.ANTHROPIC_API_KEY;
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(getCredentials).mockReturnValue(null);
      const result = readOwnerApiCredential();
      expect(result).toBeNull();
    });
  });

  describe('credential type enforcement', () => {
    it('accepts api-key type', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-valid';
      const result = readOwnerApiCredential();
      expect(result).not.toBeNull();
      expect(result!.type).toBe('api-key');
    });

    it('rejects oauth type (returns oauth, not api-key)', () => {
      delete process.env.ANTHROPIC_API_KEY;
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(getCredentials).mockReturnValue({ token: 'oauth' } as ReturnType<typeof getCredentials>);
      const result = readOwnerApiCredential();
      expect(result).toEqual({ type: 'oauth' });
      expect(result).not.toHaveProperty('key');
    });

    it('rejects null (no credentials)', () => {
      delete process.env.ANTHROPIC_API_KEY;
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(getCredentials).mockReturnValue(null);
      const result = readOwnerApiCredential();
      expect(result).toBeNull();
    });
  });
});

describe('DeployAiService', () => {
  let service: DeployAiService;
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    service = makeService();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    vi.mocked(HeadlessRunner).mockClear();
    mockRun.mockClear();
    mockRun.mockResolvedValue({
      completed: true, needsHandoff: false, totalTokens: 500,
      sessionId: 'mock-session', assistantResponse: 'Done.',
    });
    mockCleanup.mockClear();
  });

  afterEach(() => {
    service.cleanup();
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = DeployAiService.getInstance();
      const b = DeployAiService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('execute — auth enforcement', () => {
    it('throws DeployApiKeyError when credential is null', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(getCredentials).mockReturnValue(null);

      await expect(service.execute(baseOptions)).rejects.toThrow(DeployApiKeyError);
    });

    it('throws DeployApiKeyError when credential is oauth', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(getCredentials).mockReturnValue({ token: 'oauth' } as ReturnType<typeof getCredentials>);

      await expect(service.execute(baseOptions)).rejects.toThrow(DeployApiKeyError);
    });

    it('succeeds when credential is api-key', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-good-key';
      const result = await service.execute(baseOptions);
      expect(result.completed).toBe(true);
    });
  });

  describe('execute — extraEnv injection', () => {
    it('passes the API key in extraEnv to HeadlessRunner', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-injected-key';

      await service.execute(baseOptions);

      expect(HeadlessRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          extraEnv: { ANTHROPIC_API_KEY: 'sk-ant-injected-key' },
        }),
      );
    });

    it('passes workingDir and prompt to HeadlessRunner config', async () => {
      await service.execute({
        ...baseOptions,
        prompt: 'Build the app',
        workingDir: '/home/test/project',
      });

      expect(HeadlessRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          workingDir: '/home/test/project',
          directPrompt: 'Build the app',
        }),
      );
    });

    it('passes model override to HeadlessRunner config', async () => {
      await service.execute({ ...baseOptions, model: 'sonnet' });

      expect(HeadlessRunner).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'sonnet' }),
      );
    });

    it('passes disallowedTools to HeadlessRunner config', async () => {
      await service.execute({
        ...baseOptions,
        disallowedTools: ['Bash', 'Write'],
      });

      expect(HeadlessRunner).toHaveBeenCalledWith(
        expect.objectContaining({ disallowedTools: ['Bash', 'Write'] }),
      );
    });
  });

  describe('execute — session lifecycle', () => {
    it('returns a result with sessionId and completion status', async () => {
      const result = await service.execute(baseOptions);
      expect(result.sessionId).toMatch(/^deploy-deploy-1-/);
      expect(result.completed).toBe(true);
      expect(result.totalTokens).toBe(500);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('emits sessionStart event', async () => {
      const handler = vi.fn();
      service.on('sessionStart', handler);

      await service.execute(baseOptions);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentId: 'deploy-1',
        }),
      );
    });

    it('emits sessionComplete event on success', async () => {
      const handler = vi.fn();
      service.on('sessionComplete', handler);

      await service.execute(baseOptions);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentId: 'deploy-1',
          completed: true,
        }),
      );
    });

    it('returns error result when runner throws', async () => {
      mockRun.mockRejectedValueOnce(new Error('Runner crashed'));

      const result = await service.execute(baseOptions);
      expect(result.completed).toBe(false);
      expect(result.error).toBe('Runner crashed');
      expect(result.totalTokens).toBe(0);
    });

    it('emits sessionError event when runner throws', async () => {
      mockRun.mockRejectedValueOnce(new Error('Boom'));

      const handler = vi.fn();
      service.on('sessionError', handler);

      await service.execute(baseOptions);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Boom',
          deploymentId: 'deploy-1',
        }),
      );
    });

    it('tracks session while running', async () => {
      let resolveRun!: (v: unknown) => void;
      mockRun.mockReturnValueOnce(new Promise((r) => { resolveRun = r; }));

      const executePromise = service.execute(baseOptions);

      // Session should be tracked while running
      const sessions = service.getDeploymentSessions('deploy-1');
      expect(sessions.length).toBe(1);
      expect(sessions[0].status).toBe('running');

      resolveRun({
        completed: true, needsHandoff: false, totalTokens: 100, sessionId: 'sess',
      });
      await executePromise;
    });
  });

  describe('session management', () => {
    it('stopSession cancels a running session', () => {
      const session = injectSession(service, 'sess-1', 'deploy-1');
      const stopped = service.stopSession('sess-1');

      expect(stopped).toBe(true);
      expect(session.status).toBe('cancelled');
      expect(session.runner.cleanup).toHaveBeenCalled();
    });

    it('stopSession returns false for non-existent session', () => {
      expect(service.stopSession('nonexistent')).toBe(false);
    });

    it('stopSession returns false for already-completed session', () => {
      injectSession(service, 'sess-done', 'deploy-1', 'completed');
      expect(service.stopSession('sess-done')).toBe(false);
    });

    it('stopDeployment cancels all running sessions for a deployment', () => {
      injectSession(service, 'sess-a', 'dep-x');
      injectSession(service, 'sess-b', 'dep-x');
      injectSession(service, 'sess-c', 'dep-y'); // different deployment

      const stopped = service.stopDeployment('dep-x');
      expect(stopped).toBe(2);

      expect(service.getSession('sess-a')!.status).toBe('cancelled');
      expect(service.getSession('sess-b')!.status).toBe('cancelled');
      expect(service.getSession('sess-c')!.status).toBe('running');
    });

    it('getActiveSessionCount returns count of running sessions', () => {
      injectSession(service, 's1', 'dep-1');
      injectSession(service, 's2', 'dep-1');
      injectSession(service, 's3', 'dep-1', 'completed');

      expect(service.getActiveSessionCount('dep-1')).toBe(2);
    });
  });

  describe('concurrency limits', () => {
    it('rejects when per-deployment concurrent session limit (3) is reached', async () => {
      // Pre-populate 3 running sessions for 'dep-limit'
      injectSession(service, 's1', 'dep-limit');
      injectSession(service, 's2', 'dep-limit');
      injectSession(service, 's3', 'dep-limit');

      await expect(
        service.execute({ ...baseOptions, deploymentId: 'dep-limit' }),
      ).rejects.toThrow(/maximum of 3 concurrent sessions/);
    });

    it('rejects when total session limit (10) is reached', async () => {
      // Pre-populate 10 running sessions across different deployments
      for (let i = 0; i < 10; i++) {
        injectSession(service, `total-s${i}`, `dep-${i % 4}`);
      }

      await expect(
        service.execute({ ...baseOptions, deploymentId: 'dep-new' }),
      ).rejects.toThrow(/Maximum total concurrent deploy sessions.*10/);
    });

    it('allows execution when under limits', async () => {
      injectSession(service, 's1', 'dep-limit');
      injectSession(service, 's2', 'dep-limit');
      // Only 2 out of 3 — should succeed
      const result = await service.execute({ ...baseOptions, deploymentId: 'dep-limit' });
      expect(result.completed).toBe(true);
    });
  });

  describe('sweepStaleSessions', () => {
    it('removes completed sessions older than 60s', () => {
      const session = injectSession(service, 'stale-1', 'dep-1', 'completed');
      session.startedAt = Date.now() - 120_000; // 2 minutes ago

      const swept = service.sweepStaleSessions();
      expect(swept).toBe(1);
      expect(service.getSession('stale-1')).toBeUndefined();
    });

    it('does not remove running sessions', () => {
      const session = injectSession(service, 'active-1', 'dep-1', 'running');
      session.startedAt = Date.now() - 120_000;

      const swept = service.sweepStaleSessions();
      expect(swept).toBe(0);
      expect(service.getSession('active-1')).toBeDefined();
    });

    it('does not remove recently completed sessions', () => {
      injectSession(service, 'recent-1', 'dep-1', 'completed');
      // startedAt defaults to now, so it's < 60s old

      const swept = service.sweepStaleSessions();
      expect(swept).toBe(0);
    });
  });
});
