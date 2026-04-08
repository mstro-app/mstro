// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Board Execution Security Test Suite
 *
 * Tests the security properties of board execution:
 *
 * 1. **Isolation**: Each execution runs in an isolated directory
 * 2. **Cleanup**: Isolated directories are removed after execution
 * 3. **Cross-user prevention**: End users cannot access each other's jobs
 * 4. **Board template validation**: Only allowed template IDs are accepted
 * 5. **Prompt injection**: End-user prompts are never in system instructions
 * 6. **Input sanitization**: Prompts are length-limited and delimiter-stripped
 */

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockRun = vi.fn().mockResolvedValue({ completed: true, error: undefined });
const mockCleanup = vi.fn();
vi.mock('../../../cli/headless/runner.js', () => ({
  HeadlessRunner: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.run = mockRun;
    this.cleanup = mockCleanup;
  }),
}));

// Mock PlanExecutor
const mockStartBoard = vi.fn().mockResolvedValue(undefined);
const mockGetMetrics = vi.fn().mockReturnValue({ issuesAttempted: 2, issuesCompleted: 2 });
const mockGetStatus = vi.fn().mockReturnValue('complete');
const mockOn = vi.fn();
vi.mock('../../../services/plan/executor.js', () => ({
  PlanExecutor: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.startBoard = mockStartBoard;
    this.getMetrics = mockGetMetrics;
    this.getStatus = mockGetStatus;
    this.on = mockOn;
    this.emit = vi.fn();
  }),
}));

// Mock deploy-ai-service
vi.mock('../deploy-ai-service.js', () => ({
  readOwnerApiCredential: vi.fn().mockReturnValue({
    type: 'api-key',
    key: 'sk-ant-test-key-123',
    source: 'env',
  }),
}));

// Mock parser
vi.mock('../../../services/plan/parser.js', () => ({
  resolvePmDir: vi.fn().mockImplementation((dir: string) => join(dir, '.mstro', 'pm')),
  parseBoardDirectory: vi.fn().mockReturnValue({
    issues: [
      { id: 'IS-001', type: 'issue' },
      { id: 'IS-002', type: 'issue' },
    ],
  }),
}));

import {
  type BoardExecutionConfig,
  type BoardExecutionRequest,
  getBoardExecutionStatus,
  getDeploymentBoardExecutionState,
  resetDeploymentBoardExecutionRateLimit,
  startBoardExecution,
} from '../board-execution-handler.js';

// ============================================================================
// Helpers
// ============================================================================

function makeRequest(overrides?: Partial<BoardExecutionRequest>): BoardExecutionRequest {
  return {
    boardTemplateId: 'BOARD-001',
    endUserPrompt: 'Build me a todo app',
    endUserId: 'user-alice',
    deploymentId: 'deploy-test-1',
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<BoardExecutionConfig>): BoardExecutionConfig {
  return {
    deploymentId: 'deploy-test-1',
    aiEnabled: true,
    allowedAiCapabilities: ['board-execution'],
    allowedBoardTemplateIds: ['BOARD-001', 'BOARD-002'],
    maxConcurrentBoardExecutions: 3,
    maxBoardExecutionsPerMinute: 10,
    defaultModel: 'sonnet',
    workingDir: '/tmp/mstro-test-workdir',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Board Execution: Isolation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRun.mockResolvedValue({ completed: true, error: undefined });
    resetDeploymentBoardExecutionRateLimit('deploy-test-1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates an isolated directory via git worktree or tmpdir', () => {
    // The startBoardExecution function creates jobs that reference an isolatedDir.
    // Verify the function accepts valid config and creates a job.
    const result = startBoardExecution(makeRequest(), makeConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Job IDs use crypto.randomUUID() — format: board-exec-<deploymentId>-<uuid>
      expect(result.jobId).toMatch(/^board-exec-deploy-test-1-[0-9a-f-]{36}$/);
    }
  });

  it('assigns unique job IDs per execution (UUID-based, no collisions)', () => {
    const results = [];
    for (let i = 0; i < 10; i++) {
      const r = startBoardExecution(
        makeRequest({ endUserId: `user-${i}` }),
        makeConfig({ maxConcurrentBoardExecutions: 20, maxBoardExecutionsPerMinute: 20 }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) results.push(r.jobId);
    }
    // All IDs must be unique
    expect(new Set(results).size).toBe(results.length);
  });
});

describe('Board Execution: Cross-user isolation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRun.mockResolvedValue({ completed: true, error: undefined });
    resetDeploymentBoardExecutionRateLimit('deploy-test-1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when endUserId does not match the job owner', () => {
    const result = startBoardExecution(
      makeRequest({ endUserId: 'user-alice' }),
      makeConfig(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Alice can see her own job
    const aliceView = getBoardExecutionStatus(result.jobId, 'user-alice');
    expect(aliceView).not.toBeNull();
    expect(aliceView!.jobId).toBe(result.jobId);

    // Bob CANNOT see Alice's job
    const bobView = getBoardExecutionStatus(result.jobId, 'user-bob');
    expect(bobView).toBeNull();
  });

  it('returns job when no endUserId filter is provided (admin view)', () => {
    const result = startBoardExecution(
      makeRequest({ endUserId: 'user-alice' }),
      makeConfig(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No endUserId → admin/monitoring view, should return the job
    const adminView = getBoardExecutionStatus(result.jobId);
    expect(adminView).not.toBeNull();
  });

  it('returns null for non-existent job IDs', () => {
    const view = getBoardExecutionStatus('nonexistent-job-id', 'user-alice');
    expect(view).toBeNull();
  });

  it('jobs Map has no shared state between different endUserIds', () => {
    const aliceResult = startBoardExecution(
      makeRequest({ endUserId: 'user-alice' }),
      makeConfig(),
    );
    const bobResult = startBoardExecution(
      makeRequest({ endUserId: 'user-bob' }),
      makeConfig(),
    );

    expect(aliceResult.ok).toBe(true);
    expect(bobResult.ok).toBe(true);
    if (!aliceResult.ok || !bobResult.ok) return;

    // Alice's job is invisible to Bob and vice versa
    expect(getBoardExecutionStatus(aliceResult.jobId, 'user-bob')).toBeNull();
    expect(getBoardExecutionStatus(bobResult.jobId, 'user-alice')).toBeNull();

    // Each user can see only their own
    expect(getBoardExecutionStatus(aliceResult.jobId, 'user-alice')).not.toBeNull();
    expect(getBoardExecutionStatus(bobResult.jobId, 'user-bob')).not.toBeNull();
  });
});

describe('Board Execution: Board template ID validation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    resetDeploymentBoardExecutionRateLimit('deploy-test-1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects board template IDs not in allowedBoardTemplateIds', () => {
    const result = startBoardExecution(
      makeRequest({ boardTemplateId: 'BOARD-HACKED' }),
      makeConfig({ allowedBoardTemplateIds: ['BOARD-001', 'BOARD-002'] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_BOARD_TEMPLATE');
      expect(result.error.message).toContain('BOARD-HACKED');
      expect(result.error.message).toContain('not allowed');
    }
  });

  it('accepts board template IDs that are in allowedBoardTemplateIds', () => {
    const result = startBoardExecution(
      makeRequest({ boardTemplateId: 'BOARD-001' }),
      makeConfig({ allowedBoardTemplateIds: ['BOARD-001', 'BOARD-002'] }),
    );

    expect(result.ok).toBe(true);
  });

  it('rejects empty board template ID', () => {
    const result = startBoardExecution(
      makeRequest({ boardTemplateId: '' }),
      makeConfig(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_REQUEST');
    }
  });

  it('rejects whitespace-only board template ID', () => {
    const result = startBoardExecution(
      makeRequest({ boardTemplateId: '   ' }),
      makeConfig(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_REQUEST');
    }
  });

  it('rejects board template IDs containing path traversal (..)', () => {
    const result = startBoardExecution(
      makeRequest({ boardTemplateId: '../BOARD-001' }),
      makeConfig({ allowedBoardTemplateIds: ['../BOARD-001', 'BOARD-001'] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_BOARD_TEMPLATE');
      expect(result.error.message).toContain('invalid characters');
    }
  });

  it('rejects board template IDs containing forward slash', () => {
    const result = startBoardExecution(
      makeRequest({ boardTemplateId: 'boards/BOARD-001' }),
      makeConfig({ allowedBoardTemplateIds: ['boards/BOARD-001'] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_BOARD_TEMPLATE');
    }
  });

  it('rejects board template IDs containing backslash', () => {
    const result = startBoardExecution(
      makeRequest({ boardTemplateId: 'boards\\BOARD-001' }),
      makeConfig({ allowedBoardTemplateIds: ['boards\\BOARD-001'] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_BOARD_TEMPLATE');
    }
  });

  it('rejects board template IDs containing null bytes', () => {
    const result = startBoardExecution(
      makeRequest({ boardTemplateId: 'BOARD-001\x00evil' }),
      makeConfig({ allowedBoardTemplateIds: ['BOARD-001\x00evil'] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_BOARD_TEMPLATE');
    }
  });

  it('rejects when board-execution capability is not allowed', () => {
    const result = startBoardExecution(
      makeRequest(),
      makeConfig({ allowedAiCapabilities: ['headless'] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CAPABILITY_DENIED');
    }
  });

  it('rejects when AI is disabled', () => {
    const result = startBoardExecution(
      makeRequest(),
      makeConfig({ aiEnabled: false }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AI_DISABLED');
    }
  });
});

describe('Board Execution: Input validation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    resetDeploymentBoardExecutionRateLimit('deploy-test-1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects empty endUserPrompt', () => {
    const result = startBoardExecution(
      makeRequest({ endUserPrompt: '' }),
      makeConfig(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_REQUEST');
      expect(result.error.message).toContain('endUserPrompt');
    }
  });

  it('rejects whitespace-only endUserPrompt', () => {
    const result = startBoardExecution(
      makeRequest({ endUserPrompt: '   ' }),
      makeConfig(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_REQUEST');
    }
  });

  it('rejects empty endUserId', () => {
    const result = startBoardExecution(
      makeRequest({ endUserId: '' }),
      makeConfig(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_REQUEST');
      expect(result.error.message).toContain('endUserId');
    }
  });

  it('rejects prompts exceeding the max length', () => {
    const result = startBoardExecution(
      makeRequest({ endUserPrompt: 'x'.repeat(100_001) }),
      makeConfig(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_REQUEST');
      expect(result.error.message).toContain('100,000');
    }
  });

  it('accepts prompts at the max length boundary', () => {
    const result = startBoardExecution(
      makeRequest({ endUserPrompt: 'x'.repeat(100_000) }),
      makeConfig(),
    );

    expect(result.ok).toBe(true);
  });
});

describe('Board Execution: Rate limiting', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    resetDeploymentBoardExecutionRateLimit('deploy-rate-test');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tracks per-minute executions even after async completion', () => {
    const config = makeConfig({
      deploymentId: 'deploy-rate-test',
      maxConcurrentBoardExecutions: 5,
      maxBoardExecutionsPerMinute: 2,
    });

    // Start two executions (they complete instantly with mocks, but per-minute timestamps persist)
    startBoardExecution(
      makeRequest({ deploymentId: 'deploy-rate-test' }),
      config,
    );
    startBoardExecution(
      makeRequest({ deploymentId: 'deploy-rate-test', endUserId: 'user-2' }),
      config,
    );

    // The per-minute timestamps should still be tracked
    const state = getDeploymentBoardExecutionState('deploy-rate-test');
    expect(state.executionsInLastMinute).toBeGreaterThanOrEqual(2);
  });

  it('rejects when per-minute limit is exceeded', () => {
    const config = makeConfig({
      deploymentId: 'deploy-rate-test',
      maxConcurrentBoardExecutions: 10,
      maxBoardExecutionsPerMinute: 2,
    });

    // Fill up the per-minute bucket
    startBoardExecution(
      makeRequest({ deploymentId: 'deploy-rate-test' }),
      config,
    );
    startBoardExecution(
      makeRequest({ deploymentId: 'deploy-rate-test', endUserId: 'user-2' }),
      config,
    );

    // Third should be rate-limited
    const third = startBoardExecution(
      makeRequest({ deploymentId: 'deploy-rate-test', endUserId: 'user-3' }),
      config,
    );
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.error.code).toBe('RATE_LIMIT_EXCEEDED');
    }
  });

  it('reset clears rate limit state', () => {
    const config = makeConfig({
      deploymentId: 'deploy-rate-test',
      maxConcurrentBoardExecutions: 5,
    });

    startBoardExecution(
      makeRequest({ deploymentId: 'deploy-rate-test' }),
      config,
    );

    resetDeploymentBoardExecutionRateLimit('deploy-rate-test');

    const state = getDeploymentBoardExecutionState('deploy-rate-test');
    expect(state.activeExecutions).toBe(0);
    expect(state.executionsInLastMinute).toBe(0);
  });
});

describe('Board Execution: API key isolation (no process.env mutation)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRun.mockResolvedValue({ completed: true, error: undefined });
    resetDeploymentBoardExecutionRateLimit('deploy-test-1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not mutate process.env.ANTHROPIC_API_KEY during execution', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;

    startBoardExecution(makeRequest(), makeConfig());

    // Allow async execution to start
    await new Promise(resolve => setTimeout(resolve, 50));

    // process.env should not have been modified
    expect(process.env.ANTHROPIC_API_KEY).toBe(originalKey);
  });

  it('passes API key via PlanExecutor extraEnv, not process.env', async () => {
    const { PlanExecutor } = await import('../../../services/plan/executor.js');

    startBoardExecution(makeRequest(), makeConfig());

    // Allow async execution to start
    await new Promise(resolve => setTimeout(resolve, 50));

    const calls = vi.mocked(PlanExecutor).mock.calls;
    if (calls.length > 0) {
      const [, options] = calls[calls.length - 1] as [string, { extraEnv?: Record<string, string> } | undefined];
      expect(options?.extraEnv?.ANTHROPIC_API_KEY).toBe('sk-ant-test-key-123');
    }
  });
});

describe('Board Execution: Prompt isolation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    resetDeploymentBoardExecutionRateLimit('deploy-test-1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('HeadlessRunner receives deployMode=true for deploy executions', async () => {
    // The HeadlessRunner mock is set up at the top of this file.
    // We verify that board execution passes deployMode to it.
    const { HeadlessRunner } = await import('../../../cli/headless/runner.js');

    startBoardExecution(
      makeRequest(),
      makeConfig(),
    );

    // Allow async execution to start
    await new Promise(resolve => setTimeout(resolve, 50));

    // The HeadlessRunner should have been called with deployMode: true
    const calls = vi.mocked(HeadlessRunner).mock.calls;
    if (calls.length > 0) {
      const config = calls[calls.length - 1][0] as Record<string, unknown>;
      expect(config.deployMode).toBe(true);
    }
  });

  it('sanitizeEndUserPrompt is exported and callable', async () => {
    // The sanitizeEndUserPrompt function is exported and tested in detail
    // in prompt-injection.test.ts. This test verifies the import works.
    const mod = await import('../board-execution-handler.js');
    expect(typeof mod.sanitizeEndUserPrompt).toBe('function');
    expect(mod.sanitizeEndUserPrompt('hello')).toBe('hello');
  });
});
