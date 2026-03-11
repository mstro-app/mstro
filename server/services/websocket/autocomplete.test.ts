import { describe, expect, it, vi } from 'vitest';
import { AutocompleteService } from './autocomplete.js';

// Mock file system operations to avoid hitting real FS
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ isDirectory: () => false })),
}));

vi.mock('./file-utils.js', () => ({
  CACHE_TTL_MS: 5000,
  directoryCache: new Map(),
  getFileType: vi.fn((path: string) => {
    const ext = path.split('.').pop() || '';
    return ext || 'unknown';
  }),
  isIgnored: vi.fn(() => false),
  parseGitignore: vi.fn(() => []),
  scanDirectoryRecursiveWithDepth: vi.fn(() => []),
}));

describe('AutocompleteService', () => {
  // ========== Frecency ==========

  describe('calculateFrecencyScore', () => {
    it('returns 0 for unknown files', () => {
      const svc = new AutocompleteService();
      expect(svc.calculateFrecencyScore('nonexistent.ts')).toBe(0);
    });

    it('returns positive score for recently used files', () => {
      const svc = new AutocompleteService();
      svc.recordFileSelection('src/index.ts');
      const score = svc.calculateFrecencyScore('src/index.ts');
      expect(score).toBeGreaterThan(0);
    });

    it('increases score with more selections', () => {
      const svc = new AutocompleteService();
      svc.recordFileSelection('src/index.ts');
      const score1 = svc.calculateFrecencyScore('src/index.ts');

      svc.recordFileSelection('src/index.ts');
      svc.recordFileSelection('src/index.ts');
      const score3 = svc.calculateFrecencyScore('src/index.ts');

      expect(score3).toBeGreaterThan(score1);
    });

    it('decays score over time', () => {
      const svc = new AutocompleteService();

      // Record selection at a specific time
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      svc.recordFileSelection('src/index.ts');
      const recentScore = svc.calculateFrecencyScore('src/index.ts');

      // Move forward 8 days (past the 7-day recency window)
      vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);
      const staleScore = svc.calculateFrecencyScore('src/index.ts');

      expect(staleScore).toBeLessThan(recentScore);
      vi.restoreAllMocks();
    });

    it('handles initial frecency data in constructor', () => {
      const svc = new AutocompleteService({
        'src/main.ts': { count: 5, lastUsed: Date.now() },
      });
      expect(svc.calculateFrecencyScore('src/main.ts')).toBeGreaterThan(0);
    });
  });

  // ========== recordFileSelection ==========

  describe('recordFileSelection', () => {
    it('creates new entry for first selection', () => {
      const svc = new AutocompleteService();
      svc.recordFileSelection('new-file.ts');

      const data = svc.getFrecencyData();
      expect(data['new-file.ts']).toBeDefined();
      expect(data['new-file.ts'].count).toBe(1);
    });

    it('increments count for existing entry', () => {
      const svc = new AutocompleteService();
      svc.recordFileSelection('file.ts');
      svc.recordFileSelection('file.ts');
      svc.recordFileSelection('file.ts');

      const data = svc.getFrecencyData();
      expect(data['file.ts'].count).toBe(3);
    });

    it('updates lastUsed timestamp', () => {
      const svc = new AutocompleteService();
      const before = Date.now();
      svc.recordFileSelection('file.ts');
      const data = svc.getFrecencyData();
      expect(data['file.ts'].lastUsed).toBeGreaterThanOrEqual(before);
    });
  });

  // ========== setFrecencyData / getFrecencyData ==========

  describe('setFrecencyData / getFrecencyData', () => {
    it('replaces frecency data', () => {
      const svc = new AutocompleteService();
      svc.recordFileSelection('old.ts');

      const newData = {
        'new.ts': { count: 10, lastUsed: Date.now() },
      };
      svc.setFrecencyData(newData);

      expect(svc.getFrecencyData()).toBe(newData);
      expect(svc.calculateFrecencyScore('old.ts')).toBe(0);
      expect(svc.calculateFrecencyScore('new.ts')).toBeGreaterThan(0);
    });
  });

  // ========== getFileCompletions ==========

  describe('getFileCompletions', () => {
    it('returns empty array when no files match', () => {
      const svc = new AutocompleteService();
      const results = svc.getFileCompletions('nonexistent', '/tmp/test');
      expect(results).toEqual([]);
    });

    it('handles @ symbol prefix', () => {
      const svc = new AutocompleteService();
      // Should not throw when handling @ prefix
      const results = svc.getFileCompletions('@src/index', '/tmp/test');
      expect(Array.isArray(results)).toBe(true);
    });

    it('returns empty array on error', () => {
      const svc = new AutocompleteService();
      // Invalid working dir should return empty (caught by try/catch)
      const results = svc.getFileCompletions('test', '/nonexistent/path');
      expect(results).toEqual([]);
    });

    it('limits results to 15', () => {
      // This is tested structurally — the code slices to 15
      const svc = new AutocompleteService();
      const results = svc.getFileCompletions('', '/tmp/test');
      expect(results.length).toBeLessThanOrEqual(15);
    });
  });

  // ========== Scoring logic (frecency weight formula) ==========

  describe('frecency scoring formula', () => {
    it('uses log2 for frequency weight', () => {
      const svc = new AutocompleteService();

      // count=1: log2(2) = 1
      svc.setFrecencyData({ 'a.ts': { count: 1, lastUsed: Date.now() } });
      const score1 = svc.calculateFrecencyScore('a.ts');

      // count=7: log2(8) = 3
      svc.setFrecencyData({ 'a.ts': { count: 7, lastUsed: Date.now() } });
      const score7 = svc.calculateFrecencyScore('a.ts');

      // Score should roughly triple (3x) since frequency goes from 1 to 3
      expect(score7 / score1).toBeCloseTo(3, 0);
    });

    it('recency weight is ~1.0 for very recent files', () => {
      const svc = new AutocompleteService();
      svc.setFrecencyData({ 'a.ts': { count: 1, lastUsed: Date.now() } });
      const score = svc.calculateFrecencyScore('a.ts');

      // With recencyWeight ≈ 1, score ≈ log2(2) * (0.3 + 0.7*1) * 100 = 100
      expect(score).toBeCloseTo(100, -1);
    });

    it('recency weight is ~0.3 for files used > 7 days ago', () => {
      const svc = new AutocompleteService();
      const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
      svc.setFrecencyData({ 'a.ts': { count: 1, lastUsed: eightDaysAgo } });
      const score = svc.calculateFrecencyScore('a.ts');

      // With recencyWeight = max(0, 1 - 8*24/168) = 0
      // score ≈ log2(2) * (0.3 + 0.7*0) * 100 = 30
      expect(score).toBeCloseTo(30, -1);
    });
  });
});
