import { describe, expect, it, vi } from 'vitest';
import { HeadlessRunner } from './runner.js';

// Mock executeClaudeCommand to prevent actual process spawning
vi.mock('./claude-invoker.js', () => ({
  executeClaudeCommand: vi.fn().mockResolvedValue({
    output: '',
    exitCode: 0,
    assistantResponse: 'mock response',
  }),
}));

describe('HeadlessRunner', () => {
  describe('constructor', () => {
    it('sets default config values', () => {
      const runner = new HeadlessRunner({});
      // biome-ignore lint/suspicious/noExplicitAny: accessing private member for testing
      const config = (runner as any).config;
      expect(config.workingDir).toBe(process.cwd());
      expect(config.tokenBudgetThreshold).toBe(170000);
      expect(config.maxSessions).toBe(50);
      expect(config.maxRetries).toBe(3);
      expect(config.verbose).toBe(false);
      expect(config.maxAutoRetries).toBe(2);
    });

    it('uses provided config values', () => {
      const runner = new HeadlessRunner({
        workingDir: '/tmp/test',
        verbose: true,
        model: 'opus',
      });
      // biome-ignore lint/suspicious/noExplicitAny: accessing private member for testing
      const config = (runner as any).config;
      expect(config.workingDir).toBe('/tmp/test');
      expect(config.verbose).toBe(true);
      expect(config.model).toBe('opus');
    });
  });

  describe('cleanup', () => {
    it('sends SIGTERM to all tracked processes', () => {
      const runner = new HeadlessRunner({});
      // biome-ignore lint/suspicious/noExplicitAny: accessing private member for testing
      const processes = (runner as any).runningProcesses as Map<number, unknown>;

      const mockProc1 = { kill: vi.fn(), killed: false, exitCode: null };
      const mockProc2 = { kill: vi.fn(), killed: false, exitCode: null };
      processes.set(1, mockProc1);
      processes.set(2, mockProc2);

      runner.cleanup();

      expect(mockProc1.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockProc2.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('is a no-op when no processes are tracked', () => {
      const runner = new HeadlessRunner({});
      // Should not throw
      runner.cleanup();
    });
  });

  describe('sweepZombies', () => {
    it('removes processes that have exited', () => {
      const runner = new HeadlessRunner({});
      // biome-ignore lint/suspicious/noExplicitAny: accessing private member for testing
      const processes = (runner as any).runningProcesses as Map<number, unknown>;

      // Process that has exited
      processes.set(1, { exitCode: 0, killed: false });
      // Process still running
      processes.set(2, { exitCode: null, killed: false });
      // Process that was killed
      processes.set(3, { exitCode: null, killed: true });

      const swept = runner.sweepZombies();
      expect(swept).toBe(2); // exitCode=0 and killed=true
      expect(processes.size).toBe(1);
      expect(processes.has(2)).toBe(true);
    });

    it('returns 0 when no zombies', () => {
      const runner = new HeadlessRunner({});
      // biome-ignore lint/suspicious/noExplicitAny: accessing private member for testing
      const processes = (runner as any).runningProcesses as Map<number, unknown>;
      processes.set(1, { exitCode: null, killed: false });

      expect(runner.sweepZombies()).toBe(0);
      expect(processes.size).toBe(1);
    });

    it('handles empty process map', () => {
      const runner = new HeadlessRunner({});
      expect(runner.sweepZombies()).toBe(0);
    });
  });

  describe('run', () => {
    it('returns error when no prompt provided', async () => {
      const runner = new HeadlessRunner({});
      const result = await runner.run();
      expect(result.completed).toBe(false);
      expect(result.error).toContain('No prompt provided');
    });
  });
});
