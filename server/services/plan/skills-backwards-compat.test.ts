// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Skills Backwards Compatibility Tests
 *
 * Verifies that prompt-building functions using Skills (.claude/skills/{name}/SKILL.md)
 * fall back correctly to inline prompts when no Skill is available, and use Skill content
 * when available.
 *
 * Also tests pure review-gate parsing functions for correctness.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks (hoisted) ──────────────────────────────────────────────────
// Must be at top-level before any imports. Vitest hoists vi.mock() calls
// automatically; the module paths are resolved relative to THIS test file.
//
// agent-loader.ts lives at services/plan/agent-loader.ts (same dir as this
// test), so the path used by quality-review-agent.ts ('../plan/agent-loader.js')
// and this file ('./agent-loader.js') both resolve to the same module.

vi.mock('./agent-loader.js', () => ({
  loadSkillPrompt: vi.fn(() => null),
  loadSkillTemplate: vi.fn(() => null),
  loadAgentPrompt: vi.fn(() => null),
}));

// quality-review-agent.ts imports these at the top level; mock them to avoid
// spawning real processes or touching the file system during tests.
vi.mock('../../cli/headless/headless-logger.js', () => ({
  runWithFileLogger: vi.fn(),
}));
vi.mock('../../cli/headless/index.js', () => ({
  HeadlessRunner: vi.fn(),
}));

// quality-review-agent.ts imports recomputeWithAiReview from quality-service.js.
vi.mock('../websocket/quality-service.js', () => ({
  recomputeWithAiReview: vi.fn(),
}));

// quality-review-agent.ts imports type QualityPersistence from quality-persistence.js
// (import type only, but mock to be safe with any side-effect imports).
vi.mock('../websocket/quality-persistence.js', () => ({}));

// prompt-builders.ts imports loadSkillPrompt from '../services/plan/agent-loader.js'
// which, relative to this test file at services/plan/, resolves to the same
// agent-loader module already mocked above. No additional mock needed.

// ── Imports ─────────────────────────────────────────────────────────────────

import { loadSkillPrompt } from './agent-loader.js';
import {
  buildCodeReviewPrompt,
  buildVerificationPrompt,
  parseCodeReviewResponse,
  type CodeReviewFinding,
} from '../websocket/quality-review-agent.js';
import { parseReviewOutput, autoPassResult } from './review-gate.js';
import { buildRetryPrompt } from '../../cli/prompt-builders.js';
import type { ExecutionCheckpoint } from '../../cli/headless/types.js';

const mockLoadSkillPrompt = vi.mocked(loadSkillPrompt);

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeCheckpoint(overrides: Partial<ExecutionCheckpoint> = {}): ExecutionCheckpoint {
  return {
    originalPrompt: 'Do the thing',
    assistantText: '',
    thinkingText: '',
    completedTools: [],
    inProgressTools: [],
    hungTool: {
      toolName: 'WebFetch',
      toolId: 'tool-1',
      input: { url: 'https://example.com' },
      timeoutMs: 30_000,
      url: 'https://example.com',
    },
    elapsedMs: 35_000,
    ...overrides,
  };
}

function makeCodeFinding(overrides: Partial<CodeReviewFinding> = {}): CodeReviewFinding {
  return {
    severity: 'high',
    category: 'security',
    file: 'src/auth.ts',
    line: 42,
    title: 'SQL injection risk',
    description: 'User input is interpolated directly into a query string.',
    evidence: 'query = `SELECT * FROM users WHERE id = ${userId}`',
    ...overrides,
  };
}

// ── Reset mocks before each test ─────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadSkillPrompt.mockReturnValue(null);
});

// ============================================================================
// buildCodeReviewPrompt
// ============================================================================

describe('buildCodeReviewPrompt', () => {
  describe('when loadSkillPrompt returns null (inline fallback)', () => {
    it('contains "senior staff engineer" persona', () => {
      const result = buildCodeReviewPrompt('/project/src');
      expect(result).toContain('senior staff engineer');
    });

    it('contains "code review" context phrase', () => {
      const result = buildCodeReviewPrompt('/project/src');
      expect(result).toContain('code review');
    });

    it('embeds the dirPath into the prompt', () => {
      const dirPath = '/home/user/myproject';
      const result = buildCodeReviewPrompt(dirPath);
      expect(result).toContain(dirPath);
    });

    it('instructs output as JSON with score, grade, and findings', () => {
      const result = buildCodeReviewPrompt('/project');
      expect(result).toContain('JSON');
      expect(result).toContain('score');
      expect(result).toContain('grade');
    });

    it('mentions findings array in JSON output instruction', () => {
      const result = buildCodeReviewPrompt('/project');
      expect(result).toContain('findings');
    });

    it('works without cliFindings argument', () => {
      expect(() => buildCodeReviewPrompt('/project')).not.toThrow();
    });

    it('works with an empty cliFindings array', () => {
      const result = buildCodeReviewPrompt('/project', []);
      // No CLI section should be injected for an empty array
      expect(result).not.toContain('CLI Tool Findings');
    });

    it('includes CLI findings section when cliFindings are provided', () => {
      const cliFindings = [
        {
          severity: 'high',
          category: 'security',
          file: 'src/index.ts',
          line: 5,
          title: 'Eval usage',
          description: 'eval() called with user input',
        },
      ];
      const result = buildCodeReviewPrompt('/project', cliFindings);
      expect(result).toContain('CLI Tool Findings');
      expect(result).toContain('Eval usage');
      expect(result).toContain('src/index.ts');
    });

    it('formats CLI findings with severity, file, and line number', () => {
      const cliFindings = [
        {
          severity: 'critical',
          category: 'security',
          file: 'src/db.ts',
          line: 17,
          title: 'SQLi risk',
          description: 'Unparameterized query',
        },
      ];
      const result = buildCodeReviewPrompt('/project', cliFindings);
      expect(result).toContain('CRITICAL');
      expect(result).toContain('src/db.ts:17');
    });

    it('omits line suffix when finding line is null', () => {
      const cliFindings = [
        {
          severity: 'low',
          category: 'maintainability',
          file: 'README.md',
          line: null,
          title: 'Missing docs',
          description: 'No description',
        },
      ];
      const result = buildCodeReviewPrompt('/project', cliFindings);
      // Should have the file name but no :null or :undefined suffix
      expect(result).toContain('README.md');
      expect(result).not.toContain(':null');
      expect(result).not.toContain(':undefined');
    });

    it('caps CLI findings display at 50 items and notes overflow', () => {
      const cliFindings = Array.from({ length: 55 }, (_, i) => ({
        severity: 'low',
        category: 'maintainability',
        file: `file${i}.ts`,
        line: i,
        title: `Issue ${i}`,
        description: 'minor',
      }));
      const result = buildCodeReviewPrompt('/project', cliFindings);
      expect(result).toContain('5 more issues');
    });

    it('calls loadSkillPrompt with skill name "code-review"', () => {
      buildCodeReviewPrompt('/project');
      expect(mockLoadSkillPrompt).toHaveBeenCalledWith(
        'code-review',
        expect.objectContaining({ dirPath: '/project' }),
        '/project',
      );
    });
  });

  describe('when loadSkillPrompt returns content (Skill active)', () => {
    it('returns the Skill content directly', () => {
      mockLoadSkillPrompt.mockReturnValue('SKILL CONTENT FOR CODE REVIEW');
      const result = buildCodeReviewPrompt('/project');
      expect(result).toBe('SKILL CONTENT FOR CODE REVIEW');
    });

    it('does not fall through to inline prompt when Skill is available', () => {
      mockLoadSkillPrompt.mockReturnValue('CUSTOM SKILL');
      const result = buildCodeReviewPrompt('/project');
      expect(result).not.toContain('senior staff engineer');
    });
  });
});

// ============================================================================
// buildVerificationPrompt
// ============================================================================

describe('buildVerificationPrompt', () => {
  const sampleFindings: CodeReviewFinding[] = [
    makeCodeFinding(),
    makeCodeFinding({ severity: 'medium', title: 'Missing null check', file: 'src/utils.ts', line: 10 }),
  ];

  describe('when loadSkillPrompt returns null (inline fallback)', () => {
    it('contains the VERIFIER persona keyword', () => {
      const result = buildVerificationPrompt('/project', sampleFindings);
      expect(result).toContain('VERIFIER');
    });

    it('contains "verify" instruction', () => {
      const result = buildVerificationPrompt('/project', sampleFindings);
      expect(result.toLowerCase()).toContain('verify');
    });

    it('embeds the dirPath', () => {
      const result = buildVerificationPrompt('/custom/dir', sampleFindings);
      expect(result).toContain('/custom/dir');
    });

    it('serialises findings as JSON in the prompt body', () => {
      const result = buildVerificationPrompt('/project', sampleFindings);
      // The findings JSON block should contain at least one finding title
      expect(result).toContain('SQL injection risk');
    });

    it('works with an empty findings array', () => {
      expect(() => buildVerificationPrompt('/project', [])).not.toThrow();
    });

    it('calls loadSkillPrompt with skill name "verify-review"', () => {
      buildVerificationPrompt('/project', sampleFindings);
      expect(mockLoadSkillPrompt).toHaveBeenCalledWith(
        'verify-review',
        expect.objectContaining({ dirPath: '/project' }),
        '/project',
      );
    });

    it('includes verdict format instructions', () => {
      const result = buildVerificationPrompt('/project', sampleFindings);
      // Should instruct the model on output format
      expect(result).toContain('JSON');
    });
  });

  describe('when loadSkillPrompt returns content (Skill active)', () => {
    it('returns the Skill content directly', () => {
      mockLoadSkillPrompt.mockReturnValue('SKILL VERIFICATION PROMPT');
      const result = buildVerificationPrompt('/project', sampleFindings);
      expect(result).toBe('SKILL VERIFICATION PROMPT');
    });

    it('does not include VERIFIER fallback text when Skill is available', () => {
      mockLoadSkillPrompt.mockReturnValue('CUSTOM SKILL OUTPUT');
      const result = buildVerificationPrompt('/project', sampleFindings);
      expect(result).not.toContain('VERIFIER');
    });
  });
});

// ============================================================================
// buildRetryPrompt
// ============================================================================

describe('buildRetryPrompt', () => {
  const originalPrompt = 'Build a REST API with authentication';

  describe('when loadSkillPrompt returns null (inline fallback)', () => {
    it('contains "RETRY" in the heading', () => {
      const checkpoint = makeCheckpoint();
      const result = buildRetryPrompt(checkpoint, originalPrompt);
      expect(result.toUpperCase()).toContain('RETRY');
    });

    it('contains "interrupted" to describe what happened', () => {
      const checkpoint = makeCheckpoint();
      const result = buildRetryPrompt(checkpoint, originalPrompt);
      expect(result.toLowerCase()).toContain('interrupted');
    });

    it('mentions "timed out" for the hung tool', () => {
      const checkpoint = makeCheckpoint();
      const result = buildRetryPrompt(checkpoint, originalPrompt);
      expect(result.toLowerCase()).toContain('timed out');
    });

    it('includes the original prompt text', () => {
      const checkpoint = makeCheckpoint();
      const result = buildRetryPrompt(checkpoint, originalPrompt);
      expect(result).toContain(originalPrompt);
    });

    it('includes the hung tool name', () => {
      const checkpoint = makeCheckpoint({ hungTool: { toolName: 'Bash', toolId: 't1', input: {}, timeoutMs: 60_000 } });
      const result = buildRetryPrompt(checkpoint, originalPrompt);
      expect(result).toContain('Bash');
    });

    it('includes the URL suffix when hungTool has a url', () => {
      const checkpoint = makeCheckpoint();
      const result = buildRetryPrompt(checkpoint, originalPrompt);
      expect(result).toContain('https://example.com');
    });

    it('includes completed tools section when completedTools is non-empty', () => {
      const checkpoint = makeCheckpoint({
        completedTools: [
          {
            toolName: 'Read',
            toolId: 'tool-r1',
            input: { file_path: '/project/src/index.ts' },
            result: 'export function main() {}',
            isError: false,
            durationMs: 50,
          },
        ],
      });
      const result = buildRetryPrompt(checkpoint, originalPrompt);
      expect(result).toContain('Results already obtained');
      expect(result).toContain('Read');
    });

    it('omits completed tools section when completedTools is empty', () => {
      const checkpoint = makeCheckpoint({ completedTools: [] });
      const result = buildRetryPrompt(checkpoint, originalPrompt);
      expect(result).not.toContain('Results already obtained');
    });

    it('includes DO NOT retry guidance when allTimedOut is provided', () => {
      const checkpoint = makeCheckpoint();
      const allTimedOut = [
        { toolName: 'WebFetch', input: { url: 'https://slow.com' }, timeoutMs: 30_000 },
      ];
      const result = buildRetryPrompt(checkpoint, originalPrompt, allTimedOut);
      expect(result).toContain('DO NOT');
    });

    it('lists all timed-out tools when allTimedOut has multiple entries', () => {
      const checkpoint = makeCheckpoint();
      const allTimedOut = [
        { toolName: 'WebFetch', input: { url: 'https://a.com' }, timeoutMs: 30_000 },
        { toolName: 'Bash', input: { command: 'npm install' }, timeoutMs: 60_000 },
      ];
      const result = buildRetryPrompt(checkpoint, originalPrompt, allTimedOut);
      expect(result).toContain('WebFetch');
      expect(result).toContain('Bash');
    });

    it('includes in-progress tools section when inProgressTools is non-empty', () => {
      const checkpoint = makeCheckpoint({
        inProgressTools: [
          { toolName: 'Glob', toolId: 'tool-g1', input: { pattern: '**/*.ts' } },
        ],
      });
      const result = buildRetryPrompt(checkpoint, originalPrompt);
      expect(result).toContain('Glob');
    });

    it('calls loadSkillPrompt with skill name "retry-task"', () => {
      const checkpoint = makeCheckpoint();
      buildRetryPrompt(checkpoint, originalPrompt);
      expect(mockLoadSkillPrompt).toHaveBeenCalledWith(
        'retry-task',
        expect.objectContaining({ originalPrompt }),
      );
    });
  });

  describe('when loadSkillPrompt returns content (Skill active)', () => {
    it('returns the Skill content directly', () => {
      mockLoadSkillPrompt.mockReturnValue('SKILL RETRY PROMPT');
      const checkpoint = makeCheckpoint();
      const result = buildRetryPrompt(checkpoint, originalPrompt);
      expect(result).toBe('SKILL RETRY PROMPT');
    });

    it('does not include inline fallback headings when Skill is available', () => {
      mockLoadSkillPrompt.mockReturnValue('CUSTOM RETRY');
      const checkpoint = makeCheckpoint();
      const result = buildRetryPrompt(checkpoint, originalPrompt);
      expect(result).not.toContain('AUTOMATIC RETRY');
    });
  });
});

// ============================================================================
// parseCodeReviewResponse
// ============================================================================

describe('parseCodeReviewResponse', () => {
  describe('valid JSON with findings array', () => {
    it('parses score, grade, and summary', () => {
      const raw = JSON.stringify({
        score: 78,
        grade: 'B+',
        summary: 'Overall decent quality.',
        scoreRationale: 'Minor issues found.',
        findings: [],
      });
      const result = parseCodeReviewResponse(raw);
      expect(result.score).toBe(78);
      expect(result.grade).toBe('B+');
      expect(result.summary).toBe('Overall decent quality.');
      expect(result.scoreRationale).toBe('Minor issues found.');
    });

    it('normalises score to 0-100 range (clamps at ceiling)', () => {
      const raw = JSON.stringify({ score: 150, grade: 'A', summary: 'Good', findings: [] });
      expect(parseCodeReviewResponse(raw).score).toBe(100);
    });

    it('normalises score to 0-100 range (clamps at floor)', () => {
      const raw = JSON.stringify({ score: -10, grade: 'F', summary: 'Bad', findings: [] });
      expect(parseCodeReviewResponse(raw).score).toBe(0);
    });

    it('parses valid findings with required fields', () => {
      const raw = JSON.stringify({
        findings: [
          {
            severity: 'high',
            category: 'security',
            file: 'src/auth.ts',
            line: 42,
            title: 'SQL injection',
            description: 'Direct interpolation',
          },
        ],
      });
      const result = parseCodeReviewResponse(raw);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('high');
      expect(result.findings[0].file).toBe('src/auth.ts');
      expect(result.findings[0].title).toBe('SQL injection');
    });

    it('drops findings that are missing required file or title fields', () => {
      const raw = JSON.stringify({
        findings: [
          { severity: 'high', category: 'bugs', line: 1, title: 'No file' }, // missing file
          { severity: 'low', category: 'bugs', file: 'a.ts', line: 1 },      // missing title
          { severity: 'medium', category: 'security', file: 'b.ts', line: 1, title: 'OK' },
        ],
      });
      const result = parseCodeReviewResponse(raw);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].title).toBe('OK');
    });

    it('falls back to "medium" for unknown severity values', () => {
      const raw = JSON.stringify({
        findings: [{ severity: 'extreme', category: 'bugs', file: 'x.ts', line: 1, title: 'T', description: 'D' }],
      });
      expect(parseCodeReviewResponse(raw).findings[0].severity).toBe('medium');
    });

    it('falls back to "maintainability" for unknown category values', () => {
      const raw = JSON.stringify({
        findings: [{ severity: 'low', category: 'unknown-cat', file: 'x.ts', line: 1, title: 'T', description: 'D' }],
      });
      expect(parseCodeReviewResponse(raw).findings[0].category).toBe('maintainability');
    });

    it('sets line to null when line field is not a number', () => {
      const raw = JSON.stringify({
        findings: [{ severity: 'low', category: 'bugs', file: 'x.ts', line: 'not-a-number', title: 'T', description: 'D' }],
      });
      expect(parseCodeReviewResponse(raw).findings[0].line).toBeNull();
    });

    it('generates a default summary when none is provided', () => {
      const raw = JSON.stringify({ findings: [{ severity: 'low', category: 'bugs', file: 'x.ts', line: 1, title: 'T', description: 'D' }] });
      const result = parseCodeReviewResponse(raw);
      expect(typeof result.summary).toBe('string');
      expect(result.summary.length).toBeGreaterThan(0);
    });

    it('returns null score and grade when not present', () => {
      const raw = JSON.stringify({ findings: [] });
      const result = parseCodeReviewResponse(raw);
      expect(result.score).toBeNull();
      expect(result.grade).toBeNull();
    });
  });

  describe('JSON inside markdown code fence', () => {
    it('extracts and parses JSON from ```json ... ``` fence', () => {
      const response = `Here are the findings:\n\`\`\`json\n${JSON.stringify({ score: 90, grade: 'A', summary: 'Excellent', findings: [] })}\n\`\`\``;
      const result = parseCodeReviewResponse(response);
      expect(result.score).toBe(90);
      expect(result.grade).toBe('A');
    });

    it('extracts and parses JSON from plain ``` ... ``` fence', () => {
      const response = `\`\`\`\n${JSON.stringify({ score: 70, grade: 'C', summary: 'Ok', findings: [] })}\n\`\`\``;
      const result = parseCodeReviewResponse(response);
      expect(result.score).toBe(70);
    });

    it('extracts bare JSON object from response text with surrounding prose', () => {
      const json = JSON.stringify({ score: 65, grade: 'D', summary: 'Needs work', findings: [] });
      const response = `I reviewed the code.\n\n${json}\n\nThat concludes my review.`;
      const result = parseCodeReviewResponse(response);
      expect(result.score).toBe(65);
    });
  });

  describe('invalid / malformed JSON', () => {
    it('returns empty findings and failure summary for entirely invalid input', () => {
      const result = parseCodeReviewResponse('This is not JSON at all.');
      expect(result.findings).toEqual([]);
      expect(result.summary).toContain('Failed');
      expect(result.score).toBeNull();
      expect(result.grade).toBeNull();
    });

    it('returns empty findings for truncated JSON', () => {
      const result = parseCodeReviewResponse('{"score": 80, "findings": [{"file":');
      expect(result.findings).toEqual([]);
    });

    it('handles empty string input gracefully', () => {
      const result = parseCodeReviewResponse('');
      expect(result.findings).toEqual([]);
    });
  });
});

// ============================================================================
// parseReviewOutput (review-gate)
// ============================================================================

describe('parseReviewOutput', () => {
  describe('valid JSON with passed: true', () => {
    it('parses issueId, issueType, and passed flag', () => {
      const output = JSON.stringify({
        passed: true,
        checks: [{ name: 'criteria_met', passed: true, details: 'All good.' }],
      });
      const result = parseReviewOutput('ISSUE-1', 'code', output);
      expect(result.issueId).toBe('ISSUE-1');
      expect(result.issueType).toBe('code');
      expect(result.passed).toBe(true);
    });

    it('parses individual checks correctly', () => {
      const output = JSON.stringify({
        passed: true,
        checks: [
          { name: 'api_works', passed: true, details: 'Endpoints respond correctly.' },
          { name: 'tests_pass', passed: true, details: 'All 42 tests green.' },
        ],
      });
      const result = parseReviewOutput('ISSUE-2', 'non-code', output);
      expect(result.checks).toHaveLength(2);
      expect(result.checks[0].name).toBe('api_works');
      expect(result.checks[1].details).toBe('All 42 tests green.');
    });

    it('returns passed: false when passed field is false', () => {
      const output = JSON.stringify({
        passed: false,
        checks: [{ name: 'tests_pass', passed: false, details: 'Build failed.' }],
      });
      const result = parseReviewOutput('ISSUE-3', 'code', output);
      expect(result.passed).toBe(false);
    });
  });

  describe('passed as number (0 or 1)', () => {
    it('coerces passed: 1 to true', () => {
      const output = JSON.stringify({ passed: 1, checks: [] });
      expect(parseReviewOutput('I-1', 'code', output).passed).toBe(true);
    });

    it('coerces passed: 0 to false', () => {
      const output = JSON.stringify({ passed: 0, checks: [] });
      expect(parseReviewOutput('I-1', 'code', output).passed).toBe(false);
    });
  });

  describe('JSON embedded in prose', () => {
    it('extracts the JSON object from surrounding text', () => {
      const output = `I reviewed the issue.\n\n{"passed": true, "checks": [{"name": "ok", "passed": true, "details": "done"}]}\n\nGood work.`;
      const result = parseReviewOutput('I-1', 'code', output);
      expect(result.passed).toBe(true);
      expect(result.autoPass).toBeUndefined();
    });
  });

  describe('invalid or missing JSON', () => {
    it('returns autoPass result for plain text with no JSON', () => {
      const result = parseReviewOutput('I-1', 'code', 'The work looks good.');
      expect(result.passed).toBe(true);
      expect(result.autoPass).toBe(true);
    });

    it('returns autoPass result for empty string', () => {
      const result = parseReviewOutput('I-1', 'non-code', '');
      expect(result.autoPass).toBe(true);
    });

    it('returns autoPass result for JSON missing the passed field', () => {
      const output = JSON.stringify({ checks: [] });
      const result = parseReviewOutput('I-1', 'code', output);
      expect(result.autoPass).toBe(true);
    });

    it('includes issueId in autoPass result', () => {
      const result = parseReviewOutput('ISSUE-99', 'code', 'no json here');
      expect(result.issueId).toBe('ISSUE-99');
    });

    it('includes issueType in autoPass result', () => {
      const result = parseReviewOutput('I-1', 'non-code', 'no json here');
      expect(result.issueType).toBe('non-code');
    });
  });

  describe('checks normalisation', () => {
    it('handles checks with missing name or details gracefully', () => {
      const output = JSON.stringify({
        passed: true,
        checks: [{ passed: true }],  // missing name and details
      });
      const result = parseReviewOutput('I-1', 'code', output);
      expect(result.checks[0].name).toBeDefined();
      expect(result.checks[0].details).toBeDefined();
    });

    it('returns empty checks array when checks field is absent', () => {
      const output = JSON.stringify({ passed: true });
      const result = parseReviewOutput('I-1', 'code', output);
      expect(result.checks).toEqual([]);
    });

    it('returns empty checks array when checks is not an array', () => {
      const output = JSON.stringify({ passed: true, checks: 'not an array' });
      const result = parseReviewOutput('I-1', 'code', output);
      expect(result.checks).toEqual([]);
    });
  });
});

// ============================================================================
// autoPassResult
// ============================================================================

describe('autoPassResult', () => {
  it('returns passed: true', () => {
    const result = autoPassResult('ISSUE-1', 'code', 'infrastructure failure');
    expect(result.passed).toBe(true);
  });

  it('sets autoPass: true flag', () => {
    const result = autoPassResult('ISSUE-1', 'code', 'infrastructure failure');
    expect(result.autoPass).toBe(true);
  });

  it('sets issueId correctly', () => {
    const result = autoPassResult('ISSUE-42', 'non-code', 'reason');
    expect(result.issueId).toBe('ISSUE-42');
  });

  it('sets issueType correctly', () => {
    const resultCode = autoPassResult('I-1', 'code', 'reason');
    expect(resultCode.issueType).toBe('code');

    const resultNonCode = autoPassResult('I-1', 'non-code', 'reason');
    expect(resultNonCode.issueType).toBe('non-code');
  });

  it('includes the reason in the checks details', () => {
    const reason = 'Review threw an error';
    const result = autoPassResult('ISSUE-1', 'code', reason);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].details).toContain(reason);
  });

  it('marks the single check as passed', () => {
    const result = autoPassResult('I-1', 'code', 'reason');
    expect(result.checks[0].passed).toBe(true);
  });

  it('has a non-empty check name', () => {
    const result = autoPassResult('I-1', 'code', 'reason');
    expect(result.checks[0].name.length).toBeGreaterThan(0);
  });

  it('includes a reviewedAt ISO timestamp', () => {
    const result = autoPassResult('I-1', 'code', 'reason');
    expect(result.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
