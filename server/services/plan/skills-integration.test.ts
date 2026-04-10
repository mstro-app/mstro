// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Integration tests that verify all 16 Skill files in .claude/skills/ load correctly
 * through agent-loader.ts and maintain backwards compatibility with the original
 * hardcoded prompts they replaced.
 *
 * These tests use the REAL filesystem — no mocking. The workingDir is resolved to the
 * directory containing this test file. findSkillsDir() walks up from there to find
 * /home/username/repos/mstro/.claude/skills/.
 */

import { describe, expect, it } from 'vitest';
import { loadSkillPrompt, loadSkillTemplate } from './agent-loader.js';

const workingDir = new URL('.', import.meta.url).pathname;

const ALL_SKILLS = [
  'commit-message',
  'pr-description',
  'code-review',
  'fix-quality',
  'verify-review',
  'review-code',
  'review-quality',
  'review-custom',
  'assess-stall',
  'detect-context-loss',
  'classify-error',
  'check-injection',
  'retry-task',
  'execute-issue',
  'plan-coordinator',
  'review-criteria',
] as const;

// ── 1. All Skills exist and load ─────────────────────────────────

describe('all 16 skills load from filesystem', () => {
  it.each(ALL_SKILLS)('%s — loadSkillTemplate returns non-null, non-empty string', (skillName) => {
    const result = loadSkillTemplate(skillName, workingDir);
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });
});

// ── 2. Frontmatter is stripped ───────────────────────────────────

describe('frontmatter is stripped from all skills', () => {
  it.each(ALL_SKILLS)('%s — template does not start with ---', (skillName) => {
    const result = loadSkillTemplate(skillName, workingDir);
    expect(result).not.toBeNull();
    expect((result as string).trimStart()).not.toMatch(/^---/);
  });
});

// ── 3. Placeholders present ──────────────────────────────────────

describe('expected {{variable}} placeholders are present in templates', () => {
  it('commit-message has recentCommits, stagedFiles, diff', () => {
    const t = loadSkillTemplate('commit-message', workingDir) as string;
    expect(t).toContain('{{recentCommits}}');
    expect(t).toContain('{{stagedFiles}}');
    expect(t).toContain('{{diff}}');
  });

  it('pr-description has baseBranch, commits, filesChanged, diff', () => {
    const t = loadSkillTemplate('pr-description', workingDir) as string;
    expect(t).toContain('{{baseBranch}}');
    expect(t).toContain('{{commits}}');
    expect(t).toContain('{{filesChanged}}');
    expect(t).toContain('{{diff}}');
  });

  it('code-review has dirPath, cliFindingsSection', () => {
    const t = loadSkillTemplate('code-review', workingDir) as string;
    expect(t).toContain('{{dirPath}}');
    expect(t).toContain('{{cliFindingsSection}}');
  });

  it('fix-quality has issueList, issueCount, showCount', () => {
    const t = loadSkillTemplate('fix-quality', workingDir) as string;
    expect(t).toContain('{{issueList}}');
    expect(t).toContain('{{issueCount}}');
    expect(t).toContain('{{showCount}}');
  });

  it('verify-review has dirPath, findingsJson', () => {
    const t = loadSkillTemplate('verify-review', workingDir) as string;
    expect(t).toContain('{{dirPath}}');
    expect(t).toContain('{{findingsJson}}');
  });

  it('review-code has issue_id, issue_title, files_modified, acceptance_criteria', () => {
    const t = loadSkillTemplate('review-code', workingDir) as string;
    expect(t).toContain('{{issue_id}}');
    expect(t).toContain('{{issue_title}}');
    expect(t).toContain('{{files_modified}}');
    expect(t).toContain('{{acceptance_criteria}}');
  });

  it('review-quality has issue_id, issue_title, output_path, acceptance_criteria', () => {
    const t = loadSkillTemplate('review-quality', workingDir) as string;
    expect(t).toContain('{{issue_id}}');
    expect(t).toContain('{{issue_title}}');
    expect(t).toContain('{{output_path}}');
    expect(t).toContain('{{acceptance_criteria}}');
  });

  it('review-custom has issue_id, review_criteria, acceptance_criteria', () => {
    const t = loadSkillTemplate('review-custom', workingDir) as string;
    expect(t).toContain('{{issue_id}}');
    expect(t).toContain('{{review_criteria}}');
    expect(t).toContain('{{acceptance_criteria}}');
  });

  it('assess-stall has silenceMin, totalMin, lastToolName', () => {
    const t = loadSkillTemplate('assess-stall', workingDir) as string;
    expect(t).toContain('{{silenceMin}}');
    expect(t).toContain('{{totalMin}}');
    expect(t).toContain('{{lastToolName}}');
  });

  it('detect-context-loss has effectiveTimeouts, responseTail', () => {
    const t = loadSkillTemplate('detect-context-loss', workingDir) as string;
    expect(t).toContain('{{effectiveTimeouts}}');
    expect(t).toContain('{{responseTail}}');
  });

  it('classify-error has stderrTail', () => {
    const t = loadSkillTemplate('classify-error', workingDir) as string;
    expect(t).toContain('{{stderrTail}}');
  });

  it('check-injection has operation, userContextBlock', () => {
    const t = loadSkillTemplate('check-injection', workingDir) as string;
    expect(t).toContain('{{operation}}');
    expect(t).toContain('{{userContextBlock}}');
  });

  it('retry-task has hungToolName, originalPrompt', () => {
    const t = loadSkillTemplate('retry-task', workingDir) as string;
    expect(t).toContain('{{hungToolName}}');
    expect(t).toContain('{{originalPrompt}}');
  });

  it('execute-issue has issue_id, issue_title, workingDir', () => {
    const t = loadSkillTemplate('execute-issue', workingDir) as string;
    expect(t).toContain('{{issue_id}}');
    expect(t).toContain('{{issue_title}}');
    expect(t).toContain('{{workingDir}}');
  });

  it('plan-coordinator has issueCount, workingDir, issueBlocks', () => {
    const t = loadSkillTemplate('plan-coordinator', workingDir) as string;
    expect(t).toContain('{{issueCount}}');
    expect(t).toContain('{{workingDir}}');
    expect(t).toContain('{{issueBlocks}}');
  });
});

// ── 4. Backwards compatibility — interpolation produces expected phrases ─────

describe('backwards compatibility — interpolated output contains key phrases', () => {
  it('commit-message contains imperative mood guidance and section headers', () => {
    const result = loadSkillPrompt(
      'commit-message',
      {
        recentCommits: 'abc123 Fix bug',
        stagedFiles: 'M src/index.ts',
        diff: '+console.log("hi")',
      },
      workingDir,
    );
    expect(result).not.toBeNull();
    const out = result as string;
    expect(out.toLowerCase()).toContain('commit message');
    expect(out.toLowerCase()).toContain('imperative mood');
    expect(out).toContain('STAGED FILES');
    expect(out).toContain('DIFF');
  });

  it('pr-description contains pull request guidance and Summary section', () => {
    const result = loadSkillPrompt(
      'pr-description',
      {
        baseBranch: 'main',
        commits: 'abc Fix',
        filesChanged: 'src/x.ts',
        diff: '+line',
      },
      workingDir,
    );
    expect(result).not.toBeNull();
    const out = result as string;
    expect(out.toLowerCase()).toContain('pull request');
    expect(out).toContain('## Summary');
    expect(out.toLowerCase()).toContain('title');
  });

  it('code-review contains senior engineer framing and review categories', () => {
    const result = loadSkillPrompt(
      'code-review',
      { dirPath: '/tmp/test', cliFindingsSection: '' },
      workingDir,
    );
    expect(result).not.toBeNull();
    const out = result as string;
    // Original prompt used "senior staff engineer" framing
    const lc = out.toLowerCase();
    expect(lc.match(/senior staff engineer|code review/)).toBeTruthy();
    expect(lc).toContain('security');
    expect(lc).toContain('bugs');
    expect(lc).toContain('json');
  });

  it('fix-quality contains fix guidance and Issues to Fix section', () => {
    const result = loadSkillPrompt(
      'fix-quality',
      {
        issueList: '1. [HIGH] x.ts:5 — Bug',
        issueCount: '1',
        showCount: '1',
      },
      workingDir,
    );
    expect(result).not.toBeNull();
    const out = result as string;
    const lc = out.toLowerCase();
    expect(lc).toContain('fix');
    expect(lc).toContain('quality');
    expect(out).toContain('Issues to Fix');
  });

  it('assess-stall output contains VERDICT, WORKING, and STALLED', () => {
    const result = loadSkillPrompt(
      'assess-stall',
      {
        silenceMin: '5',
        totalMin: '10',
        lastToolName: 'Bash',
        lastToolInputLine: '',
        pendingToolCount: '1',
        totalToolCalls: '5',
        tokenLine: 'no tokens',
        promptPreview: 'Fix bug',
      },
      workingDir,
    );
    expect(result).not.toBeNull();
    const out = result as string;
    expect(out).toContain('VERDICT');
    expect(out).toContain('WORKING');
    expect(out).toContain('STALLED');
  });

  it('classify-error output contains CATEGORY and MESSAGE format', () => {
    const result = loadSkillPrompt(
      'classify-error',
      { tailLength: '100', stderrTail: 'Error: auth failed' },
      workingDir,
    );
    expect(result).not.toBeNull();
    const out = result as string;
    expect(out).toContain('CATEGORY');
    expect(out).toContain('MESSAGE');
  });

  it('check-injection output mentions injection and allow decision', () => {
    const result = loadSkillPrompt(
      'check-injection',
      { operation: 'Bash: rm -rf /', userContextBlock: '' },
      workingDir,
    );
    expect(result).not.toBeNull();
    const out = result as string;
    const lc = out.toLowerCase();
    expect(lc.match(/inject(ion)?/)).toBeTruthy();
    expect(lc.match(/allow/)).toBeTruthy();
  });

  it('retry-task output mentions retry/interrupted/timed out', () => {
    const result = loadSkillPrompt(
      'retry-task',
      {
        hungToolName: 'WebFetch',
        hungToolTimeoutSec: '60',
        urlSuffix: '',
        timedOutToolsSection: '',
        completedToolsSection: '',
        inProgressToolsSection: '',
        assistantTextSection: '',
        originalPrompt: 'Do the task',
      },
      workingDir,
    );
    expect(result).not.toBeNull();
    const out = result as string;
    const lc = out.toLowerCase();
    expect(lc.match(/retry|interrupted|timed out/)).toBeTruthy();
    // Variable values should be interpolated
    expect(out).toContain('WebFetch');
    expect(out).toContain('Do the task');
  });
});

// ── 5. Skills resolution from nested directory (walk-up behavior) ─────────────

describe('findSkillsDir walks up from nested directories', () => {
  it('finds skills walking up from a deeply nested path', () => {
    // dirname() does not require the path to exist on disk — walk-up still works
    const deepPath = workingDir + '/deep/nested/path';
    const result = loadSkillTemplate('commit-message', deepPath);
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });

  it('finds skills walking up from an extra level of nesting', () => {
    const deeperPath = workingDir + '/a/b/c/d';
    const result = loadSkillTemplate('assess-stall', deeperPath);
    expect(result).not.toBeNull();
    expect((result as string)).toContain('VERDICT');
  });

  it('still strips frontmatter when found via walk-up', () => {
    const deepPath = workingDir + '/deep/nested';
    const result = loadSkillTemplate('classify-error', deepPath);
    expect(result).not.toBeNull();
    expect((result as string).trimStart()).not.toMatch(/^---/);
  });
});
