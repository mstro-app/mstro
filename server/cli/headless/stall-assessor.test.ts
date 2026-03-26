import { describe, expect, it } from 'vitest';
import type { StallContext } from './stall-assessor.js';

// quickHeuristic, parseAssessmentResponse, and parseVerdictResponse are not exported.
// We test them via assessStall (which calls quickHeuristic first) and by testing
// the parsing functions indirectly. Since quickHeuristic is the critical logic
// and assessStall calls it before Haiku, we can test the heuristic paths by
// providing contexts that match known patterns.
//
// To avoid spawning Haiku (which requires `claude` CLI), we only test contexts
// that trigger the heuristic fast-path (return non-null from quickHeuristic).

import { assessStall } from './stall-assessor.js';

function makeContext(overrides: Partial<StallContext> = {}): StallContext {
  return {
    originalPrompt: 'Fix the bug in auth.ts',
    silenceMs: 120_000,
    pendingToolCount: 0,
    totalToolCalls: 5,
    elapsedTotalMs: 300_000,
    ...overrides,
  };
}

describe('assessStall - quickHeuristic paths', () => {
  it('extends when tokens are still flowing (tokenSilenceMs < 60s)', async () => {
    const ctx = makeContext({ tokenSilenceMs: 30_000 });
    const verdict = await assessStall(ctx, 'claude', false, false);
    expect(verdict.action).toBe('extend');
    expect(verdict.extensionMs).toBe(10 * 60_000);
    expect(verdict.reason).toContain('Tokens still flowing');
  });

  it('extends when tokenSilenceMs is 0', async () => {
    const ctx = makeContext({ tokenSilenceMs: 0 });
    const verdict = await assessStall(ctx, 'claude', false, false);
    expect(verdict.action).toBe('extend');
    expect(verdict.reason).toContain('Tokens still flowing');
  });

  it('does not use token heuristic when tokenSilenceMs >= 60s', async () => {
    const ctx = makeContext({
      tokenSilenceMs: 60_000,
      pendingToolCount: 3, // will trigger parallel tools heuristic
    });
    const verdict = await assessStall(ctx, 'claude', false, false);
    // Should NOT hit the token heuristic, should hit the 3+ parallel tools one
    expect(verdict.action).toBe('extend');
    expect(verdict.reason).toContain('parallel tool calls');
  });

  it('defers to watchdog when active and tools are pending', async () => {
    const ctx = makeContext({ pendingToolCount: 1, lastToolName: 'Bash' });
    const verdict = await assessStall(ctx, 'claude', false, true);
    expect(verdict.action).toBe('extend');
    expect(verdict.extensionMs).toBe(15 * 60_000);
    expect(verdict.reason).toContain('Watchdog active');
  });

  it('defers to watchdog and lists pending tool names', async () => {
    const ctx = makeContext({
      pendingToolCount: 2,
      pendingToolNames: new Set(['WebFetch', 'Bash']),
    });
    const verdict = await assessStall(ctx, 'claude', false, true);
    expect(verdict.action).toBe('extend');
    expect(verdict.reason).toContain('WebFetch');
    expect(verdict.reason).toContain('Bash');
  });

  it('extends for Task subagent via pendingToolNames', async () => {
    const ctx = makeContext({
      pendingToolCount: 1,
      pendingToolNames: new Set(['Task']),
    });
    const verdict = await assessStall(ctx, 'claude', false, false);
    expect(verdict.action).toBe('extend');
    expect(verdict.reason).toContain('Task subagent');
  });

  it('extends for Task subagent via lastToolName fallback', async () => {
    const ctx = makeContext({
      pendingToolCount: 1,
      lastToolName: 'Task',
    });
    const verdict = await assessStall(ctx, 'claude', false, false);
    expect(verdict.action).toBe('extend');
    expect(verdict.reason).toContain('Task subagent');
  });

  it('extends for Agent tool via pendingToolNames (Claude Code renamed Task to Agent)', async () => {
    const ctx = makeContext({
      pendingToolCount: 1,
      pendingToolNames: new Set(['Agent']),
    });
    const verdict = await assessStall(ctx, 'claude', false, false);
    expect(verdict.action).toBe('extend');
    expect(verdict.reason).toContain('subagent');
  });

  it('extends for Agent tool via lastToolName fallback', async () => {
    const ctx = makeContext({
      pendingToolCount: 1,
      lastToolName: 'Agent',
    });
    const verdict = await assessStall(ctx, 'claude', false, false);
    expect(verdict.action).toBe('extend');
    expect(verdict.reason).toContain('subagent');
  });

  it('scales Task extension with pending count', async () => {
    const ctx1 = makeContext({
      pendingToolCount: 1,
      pendingToolNames: new Set(['Task']),
    });
    const ctx3 = makeContext({
      pendingToolCount: 3,
      pendingToolNames: new Set(['Task']),
    });
    const v1 = await assessStall(ctx1, 'claude', false, false);
    const v3 = await assessStall(ctx3, 'claude', false, false);
    // More pending = more extension, capped at 30 min
    expect(v3.extensionMs).toBeGreaterThanOrEqual(v1.extensionMs);
    expect(v3.extensionMs).toBeLessThanOrEqual(30 * 60_000);
  });

  it('extends for 3+ parallel tool calls', async () => {
    const ctx = makeContext({ pendingToolCount: 3 });
    const verdict = await assessStall(ctx, 'claude', false, false);
    expect(verdict.action).toBe('extend');
    expect(verdict.extensionMs).toBe(15 * 60_000);
    expect(verdict.reason).toContain('parallel tool calls');
  });

  it('extends for 5 parallel tool calls', async () => {
    const ctx = makeContext({ pendingToolCount: 5 });
    const verdict = await assessStall(ctx, 'claude', false, false);
    expect(verdict.action).toBe('extend');
    expect(verdict.reason).toContain('5 parallel tool calls');
  });

  it('extends for WebSearch without watchdog', async () => {
    const ctx = makeContext({ lastToolName: 'WebSearch', pendingToolCount: 1 });
    // pendingToolCount < 3, not Task, not watchdog active, but WebSearch
    const verdict = await assessStall(ctx, 'claude', false, false);
    expect(verdict.action).toBe('extend');
    expect(verdict.extensionMs).toBe(5 * 60_000);
    expect(verdict.reason).toContain('WebSearch');
  });

  it('extends for WebFetch without watchdog', async () => {
    const ctx = makeContext({ lastToolName: 'WebFetch', pendingToolCount: 1 });
    const verdict = await assessStall(ctx, 'claude', false, false);
    expect(verdict.action).toBe('extend');
    expect(verdict.extensionMs).toBe(5 * 60_000);
    expect(verdict.reason).toContain('WebFetch');
  });

  it('does NOT extend for WebSearch when watchdog is active', async () => {
    // When watchdog is active and tools are pending, the watchdog deferral
    // takes priority over the WebSearch heuristic
    const ctx = makeContext({
      lastToolName: 'WebSearch',
      pendingToolCount: 1,
    });
    const verdict = await assessStall(ctx, 'claude', false, true);
    // Should defer to watchdog, not WebSearch heuristic
    expect(verdict.action).toBe('extend');
    expect(verdict.reason).toContain('Watchdog active');
  });

  it('falls back to extend when Haiku assessment fails', async () => {
    // Context that doesn't match any heuristic → triggers Haiku →
    // Haiku fails (no `claude` binary) → cautious extend
    const ctx = makeContext({
      pendingToolCount: 1,
      lastToolName: 'Edit',
    });
    const verdict = await assessStall(ctx, 'nonexistent-claude-binary', false, false);
    expect(verdict.action).toBe('extend');
    expect(verdict.extensionMs).toBe(10 * 60_000);
    expect(verdict.reason).toContain('unavailable');
  });
});
