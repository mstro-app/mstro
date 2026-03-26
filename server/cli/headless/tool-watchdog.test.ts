import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TOOL_TIMEOUT_PROFILES, ToolWatchdog } from './tool-watchdog.js';

describe('ToolWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ========== getProfile ==========

  describe('getProfile', () => {
    it('returns specific profile for known tools', () => {
      const watchdog = new ToolWatchdog();
      const webFetch = watchdog.getProfile('WebFetch');
      expect(webFetch.coldStartMs).toBe(180_000);
      expect(webFetch.floorMs).toBe(120_000);
      expect(webFetch.ceilingMs).toBe(300_000);
      expect(webFetch.useAdaptive).toBe(true);
      expect(webFetch.useHaikuTiebreaker).toBe(true);
    });

    it('returns Task profile with long timeouts', () => {
      const watchdog = new ToolWatchdog();
      const task = watchdog.getProfile('Task');
      expect(task.coldStartMs).toBe(900_000);
      expect(task.floorMs).toBe(600_000);
      expect(task.ceilingMs).toBe(2_700_000);
    });

    it('returns Agent profile with same long timeouts as Task', () => {
      const watchdog = new ToolWatchdog();
      const agent = watchdog.getProfile('Agent');
      expect(agent.coldStartMs).toBe(900_000);
      expect(agent.floorMs).toBe(600_000);
      expect(agent.ceilingMs).toBe(2_700_000);
      expect(agent.useAdaptive).toBe(true);
      expect(agent.useHaikuTiebreaker).toBe(true);
    });

    it('returns default profile for unknown tools', () => {
      const watchdog = new ToolWatchdog();
      const unknown = watchdog.getProfile('SomeNewTool');
      expect(unknown.coldStartMs).toBe(300_000);
      expect(unknown.floorMs).toBe(120_000);
      expect(unknown.ceilingMs).toBe(600_000);
      expect(unknown.useAdaptive).toBe(false);
    });

    it('merges custom profiles with defaults', () => {
      const watchdog = new ToolWatchdog({
        profiles: {
          WebFetch: { coldStartMs: 60_000 },
        },
      });
      const profile = watchdog.getProfile('WebFetch');
      expect(profile.coldStartMs).toBe(60_000);
      // Other fields should come from default WebFetch profile
      expect(profile.floorMs).toBe(DEFAULT_TOOL_TIMEOUT_PROFILES.WebFetch.floorMs);
      expect(profile.useAdaptive).toBe(true);
    });

    it('allows custom profiles for new tool names', () => {
      const watchdog = new ToolWatchdog({
        profiles: {
          CustomTool: { coldStartMs: 10_000, floorMs: 5_000, ceilingMs: 30_000 },
        },
      });
      const profile = watchdog.getProfile('CustomTool');
      expect(profile.coldStartMs).toBe(10_000);
      expect(profile.floorMs).toBe(5_000);
      expect(profile.ceilingMs).toBe(30_000);
    });
  });

  // ========== getTimeout ==========

  describe('getTimeout', () => {
    it('returns coldStart for non-adaptive tools', () => {
      const watchdog = new ToolWatchdog();
      // Bash is non-adaptive
      expect(watchdog.getTimeout('Bash')).toBe(300_000);
    });

    it('returns coldStart when no samples recorded', () => {
      const watchdog = new ToolWatchdog();
      expect(watchdog.getTimeout('WebFetch')).toBe(180_000);
    });

    it('returns adaptive timeout after recording samples', () => {
      const watchdog = new ToolWatchdog();
      // Record a 10s completion for WebFetch
      watchdog.recordCompletion('WebFetch', 10_000);

      const timeout = watchdog.getTimeout('WebFetch');
      // First sample: est = 10000, dev = 5000, timeout = 10000 + 4*5000 = 30000
      // But floor is 120000, so should be clamped to floor
      expect(timeout).toBe(120_000);
    });

    it('respects floor clamping', () => {
      const watchdog = new ToolWatchdog();
      // Record very fast completions
      watchdog.recordCompletion('WebFetch', 100);
      watchdog.recordCompletion('WebFetch', 100);
      watchdog.recordCompletion('WebFetch', 100);

      // Adaptive calculation would be very low, but floor prevents it
      expect(watchdog.getTimeout('WebFetch')).toBe(DEFAULT_TOOL_TIMEOUT_PROFILES.WebFetch.floorMs);
    });

    it('respects ceiling clamping', () => {
      const watchdog = new ToolWatchdog();
      // Record very slow completions
      watchdog.recordCompletion('WebSearch', 500_000);

      const timeout = watchdog.getTimeout('WebSearch');
      // Should not exceed ceiling
      expect(timeout).toBeLessThanOrEqual(DEFAULT_TOOL_TIMEOUT_PROFILES.WebSearch.ceilingMs);
    });

    it('does not record completions for non-adaptive tools', () => {
      const watchdog = new ToolWatchdog();
      // Bash is non-adaptive (Read too)
      watchdog.recordCompletion('Bash', 5_000);
      // Should still return coldStart
      expect(watchdog.getTimeout('Bash')).toBe(300_000);
    });
  });

  // ========== recordCompletion ==========

  describe('recordCompletion', () => {
    it('initializes tracker on first sample', () => {
      const watchdog = new ToolWatchdog();
      watchdog.recordCompletion('WebFetch', 20_000);

      // After first sample: timeout should differ from cold start if above floor
      const timeout = watchdog.getTimeout('WebFetch');
      // est=20000, dev=10000, adaptive=20000+4*10000=60000, floor=120000 → 120000
      expect(timeout).toBe(120_000);
    });

    it('updates EMA on subsequent samples', () => {
      const watchdog = new ToolWatchdog();
      // First sample
      watchdog.recordCompletion('Glob', 10_000);
      const timeout1 = watchdog.getTimeout('Glob');

      // Second sample - much longer
      watchdog.recordCompletion('Glob', 50_000);
      const timeout2 = watchdog.getTimeout('Glob');

      // Timeout should increase after longer sample
      expect(timeout2).toBeGreaterThanOrEqual(timeout1);
    });

    it('converges toward actual duration over many samples', () => {
      const watchdog = new ToolWatchdog();
      // Record many similar samples for Glob (adaptive, floor=30000, ceiling=180000)
      for (let i = 0; i < 20; i++) {
        watchdog.recordCompletion('Glob', 45_000);
      }
      const timeout = watchdog.getTimeout('Glob');
      // Should converge near 45000, with deviation near 0
      // adaptive ≈ 45000 + 4*~0 ≈ 45000, but floor is 30000, so should be ~45000
      expect(timeout).toBeGreaterThanOrEqual(30_000);
      expect(timeout).toBeLessThanOrEqual(60_000);
    });
  });

  // ========== startWatch / clearWatch ==========

  describe('startWatch / clearWatch', () => {
    it('calls timeout callback when timer expires', async () => {
      const watchdog = new ToolWatchdog();
      const onTimeout = vi.fn();

      watchdog.startWatch('tool-1', 'WebFetch', { url: 'http://example.com' }, onTimeout);

      // Advance past WebFetch cold start (180s) — async because internal handler is async
      await vi.advanceTimersByTimeAsync(180_001);

      // onTimeout should fire (no tiebreaker configured)
      expect(onTimeout).toHaveBeenCalledOnce();
    });

    it('does not call timeout if cleared before expiry', async () => {
      const watchdog = new ToolWatchdog();
      const onTimeout = vi.fn();

      watchdog.startWatch('tool-1', 'WebFetch', {}, onTimeout);
      watchdog.clearWatch('tool-1');

      await vi.advanceTimersByTimeAsync(300_000);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it('replaces existing watch for same ID', async () => {
      const watchdog = new ToolWatchdog();
      const onTimeout1 = vi.fn();
      const onTimeout2 = vi.fn();

      watchdog.startWatch('tool-1', 'WebFetch', {}, onTimeout1);
      watchdog.startWatch('tool-1', 'WebSearch', {}, onTimeout2);

      // Advance past WebSearch cold start (90s)
      await vi.advanceTimersByTimeAsync(90_001);
      expect(onTimeout2).toHaveBeenCalledOnce();
      expect(onTimeout1).not.toHaveBeenCalled();
    });

    it('tracks multiple watches independently', async () => {
      const watchdog = new ToolWatchdog();
      const onTimeout1 = vi.fn();
      const onTimeout2 = vi.fn();

      watchdog.startWatch('tool-1', 'WebSearch', {}, onTimeout1); // 90s
      watchdog.startWatch('tool-2', 'WebFetch', {}, onTimeout2); // 180s

      await vi.advanceTimersByTimeAsync(90_001);
      expect(onTimeout1).toHaveBeenCalledOnce();
      expect(onTimeout2).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(90_000);
      expect(onTimeout2).toHaveBeenCalledOnce();
    });
  });

  // ========== clearAll ==========

  describe('clearAll', () => {
    it('clears all active watches', () => {
      const watchdog = new ToolWatchdog();
      const onTimeout1 = vi.fn();
      const onTimeout2 = vi.fn();

      watchdog.startWatch('tool-1', 'WebFetch', {}, onTimeout1);
      watchdog.startWatch('tool-2', 'WebSearch', {}, onTimeout2);
      watchdog.clearAll();

      vi.advanceTimersByTime(300_000);
      expect(onTimeout1).not.toHaveBeenCalled();
      expect(onTimeout2).not.toHaveBeenCalled();
    });

    it('clears active watches map', () => {
      const watchdog = new ToolWatchdog();
      watchdog.startWatch('tool-1', 'WebFetch', {}, vi.fn());
      watchdog.startWatch('tool-2', 'WebSearch', {}, vi.fn());

      watchdog.clearAll();
      expect(watchdog.getActiveWatches().size).toBe(0);
    });
  });

  // ========== getActiveWatch / getActiveWatches ==========

  describe('getActiveWatch', () => {
    it('returns watch for active tool', () => {
      const watchdog = new ToolWatchdog();
      watchdog.startWatch('tool-1', 'WebFetch', { url: 'http://test.com' }, vi.fn());

      const watch = watchdog.getActiveWatch('tool-1');
      expect(watch).toBeDefined();
      expect(watch!.toolName).toBe('WebFetch');
      expect(watch!.toolInput).toEqual({ url: 'http://test.com' });
    });

    it('returns undefined for cleared watch', () => {
      const watchdog = new ToolWatchdog();
      watchdog.startWatch('tool-1', 'WebFetch', {}, vi.fn());
      watchdog.clearWatch('tool-1');

      expect(watchdog.getActiveWatch('tool-1')).toBeUndefined();
    });

    it('returns undefined for unknown ID', () => {
      const watchdog = new ToolWatchdog();
      expect(watchdog.getActiveWatch('nonexistent')).toBeUndefined();
    });
  });

  // ========== buildCheckpoint ==========

  describe('buildCheckpoint', () => {
    it('returns null when hung tool ID not found', () => {
      const watchdog = new ToolWatchdog();
      const checkpoint = watchdog.buildCheckpoint(
        'test prompt', '', '', [], 'missing-id', undefined, Date.now()
      );
      expect(checkpoint).toBeNull();
    });

    it('builds checkpoint with correct tool separation', () => {
      const watchdog = new ToolWatchdog();
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
      const processStartTime = Date.now();

      watchdog.startWatch('hung-tool', 'WebFetch', { url: 'http://slow.com' }, vi.fn());

      const accumulatedTools = [
        { toolId: 'tool-1', toolName: 'Read', toolInput: { path: 'a.ts' }, result: 'content', isError: false, duration: 100 },
        { toolId: 'tool-2', toolName: 'Grep', toolInput: { pattern: 'foo' }, result: undefined, isError: false },
        { toolId: 'hung-tool', toolName: 'WebFetch', toolInput: { url: 'http://slow.com' }, result: undefined, isError: false },
      ];

      const checkpoint = watchdog.buildCheckpoint(
        'find and fix',
        'assistant response text',
        'thinking about it',
        accumulatedTools,
        'hung-tool',
        'session-123',
        processStartTime,
      );

      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.originalPrompt).toBe('find and fix');
      expect(checkpoint!.assistantText).toBe('assistant response text');
      expect(checkpoint!.thinkingText).toBe('thinking about it');
      expect(checkpoint!.claudeSessionId).toBe('session-123');

      // Completed tools: only tool-1 (has result and is not hung)
      expect(checkpoint!.completedTools).toHaveLength(1);
      expect(checkpoint!.completedTools[0].toolId).toBe('tool-1');

      // In-progress tools: tool-2 (no result, not hung)
      expect(checkpoint!.inProgressTools).toHaveLength(1);
      expect(checkpoint!.inProgressTools[0].toolId).toBe('tool-2');

      // Hung tool
      expect(checkpoint!.hungTool.toolName).toBe('WebFetch');
      expect(checkpoint!.hungTool.toolId).toBe('hung-tool');
      expect(checkpoint!.hungTool.url).toBe('http://slow.com');
    });

    it('extracts URL from tool input for WebFetch', () => {
      const watchdog = new ToolWatchdog();
      watchdog.startWatch('t1', 'WebFetch', { url: 'http://example.com' }, vi.fn());

      const tools = [
        { toolId: 't1', toolName: 'WebFetch', toolInput: { url: 'http://example.com' }, result: undefined, isError: false },
      ];

      const cp = watchdog.buildCheckpoint('prompt', '', '', tools, 't1', undefined, Date.now());
      expect(cp!.hungTool.url).toBe('http://example.com');
    });

    it('extracts query from tool input for WebSearch', () => {
      const watchdog = new ToolWatchdog();
      watchdog.startWatch('t1', 'WebSearch', { query: 'test search' }, vi.fn());

      const tools = [
        { toolId: 't1', toolName: 'WebSearch', toolInput: { query: 'test search' }, result: undefined, isError: false },
      ];

      const cp = watchdog.buildCheckpoint('prompt', '', '', tools, 't1', undefined, Date.now());
      expect(cp!.hungTool.url).toBe('test search');
    });
  });

  // ========== tiebreaker integration ==========

  describe('tiebreaker', () => {
    it('extends when tiebreaker returns extend', async () => {
      const onTiebreaker = vi.fn().mockResolvedValue({
        action: 'extend',
        extensionMs: 60_000,
        reason: 'still working',
      });
      const watchdog = new ToolWatchdog({ onTiebreaker });
      const onTimeout = vi.fn();

      // Use a tool with useHaikuTiebreaker=true and short timeout
      watchdog.startWatch('t1', 'WebFetch', {}, onTimeout);

      // Advance to trigger timeout
      await vi.advanceTimersByTimeAsync(180_001);

      // Tiebreaker should have been called
      expect(onTiebreaker).toHaveBeenCalledOnce();
      // onTimeout should NOT have fired (tiebreaker extended)
      expect(onTimeout).not.toHaveBeenCalled();

      // Now advance past extension
      await vi.advanceTimersByTimeAsync(60_001);
      // Should fire after extension
      expect(onTimeout).toHaveBeenCalledOnce();
    });

    it('kills when tiebreaker returns kill', async () => {
      const onTiebreaker = vi.fn().mockResolvedValue({
        action: 'kill',
        extensionMs: 0,
        reason: 'process is hung',
      });
      const watchdog = new ToolWatchdog({ onTiebreaker });
      const onTimeout = vi.fn();

      watchdog.startWatch('t1', 'WebFetch', {}, onTimeout);

      await vi.advanceTimersByTimeAsync(180_001);

      expect(onTiebreaker).toHaveBeenCalledOnce();
      expect(onTimeout).toHaveBeenCalledOnce();
    });

    it('kills when tiebreaker throws', async () => {
      const onTiebreaker = vi.fn().mockRejectedValue(new Error('haiku failed'));
      const watchdog = new ToolWatchdog({ onTiebreaker });
      const onTimeout = vi.fn();

      watchdog.startWatch('t1', 'WebFetch', {}, onTimeout);

      await vi.advanceTimersByTimeAsync(180_001);

      expect(onTiebreaker).toHaveBeenCalledOnce();
      expect(onTimeout).toHaveBeenCalledOnce();
    });

    it('does not attempt tiebreaker for tools with useHaikuTiebreaker=false', async () => {
      const onTiebreaker = vi.fn();
      const watchdog = new ToolWatchdog({ onTiebreaker });
      const onTimeout = vi.fn();

      // WebSearch has useHaikuTiebreaker: false
      watchdog.startWatch('t1', 'WebSearch', {}, onTimeout);

      await vi.advanceTimersByTimeAsync(90_001);

      expect(onTiebreaker).not.toHaveBeenCalled();
      expect(onTimeout).toHaveBeenCalledOnce();
    });
  });
});
