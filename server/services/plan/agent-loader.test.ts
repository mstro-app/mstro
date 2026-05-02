import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFs: Record<string, string> = {};

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => path in mockFs),
    readFileSync: vi.fn((path: string) => {
      if (path in mockFs) return mockFs[path];
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }),
  };
});

import { loadAgentPrompt, loadSkillPrompt, loadSkillTemplate } from './agent-loader.js';

function clearMockFs() {
  for (const key of Object.keys(mockFs)) delete mockFs[key];
}

beforeEach(() => {
  clearMockFs();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── loadAgentPrompt ─────────────────────────────────────────────

describe('loadAgentPrompt', () => {
  const vars = { issue_id: 'ISSUE-1', issue_title: 'Fix auth bug' };

  it('returns null when no files exist', () => {
    const result = loadAgentPrompt('review-code', vars);
    expect(result).toBeNull();
  });

  it('loads from system agents directory as baseline fallback', () => {
    // The system agents path is resolved relative to __dirname in agent-loader.ts.
    // We simulate it by adding a file at the resolved path pattern.
    const agentPath = new URL('./agents/review-code.md', import.meta.url).pathname;
    mockFs[agentPath] = '---\nname: review-code\n---\nReview {{issue_id}}: {{issue_title}}.';

    const result = loadAgentPrompt('review-code', vars);
    expect(result).toBe('Review ISSUE-1: Fix auth bug.');
  });

  it('prefers board-level override over system default', () => {
    const agentPath = new URL('./agents/review-code.md', import.meta.url).pathname;
    mockFs[agentPath] = '---\nname: review-code\n---\nSystem: {{issue_id}}';
    mockFs['/boards/B-1/agents/review-code.md'] = '---\nname: review-code\n---\nBoard: {{issue_id}}';

    const result = loadAgentPrompt('review-code', vars, '/boards/B-1');
    expect(result).toBe('Board: ISSUE-1');
  });

  it('prefers Skills over system default when workingDir is set', () => {
    const agentPath = new URL('./agents/review-code.md', import.meta.url).pathname;
    mockFs[agentPath] = '---\nname: review-code\n---\nSystem: {{issue_id}}';
    mockFs['/project/.claude/skills'] = '';
    mockFs['/project/.claude/skills/review-code/SKILL.md'] = '---\nname: review-code\n---\nSkill: {{issue_id}}';

    const result = loadAgentPrompt('review-code', vars, null, '/project');
    expect(result).toBe('Skill: ISSUE-1');
  });

  it('board override wins over Skills', () => {
    mockFs['/project/.claude/skills'] = '';
    mockFs['/project/.claude/skills/review-code/SKILL.md'] = '---\nname: review-code\n---\nSkill: {{issue_id}}';
    mockFs['/boards/B-1/agents/review-code.md'] = '---\nname: review-code\n---\nBoard: {{issue_id}}';

    const result = loadAgentPrompt('review-code', vars, '/boards/B-1', '/project');
    expect(result).toBe('Board: ISSUE-1');
  });

  it('falls through to system default when board and Skill both missing', () => {
    const agentPath = new URL('./agents/review-code.md', import.meta.url).pathname;
    mockFs[agentPath] = '---\nname: review-code\n---\nSystem: {{issue_id}}';

    const result = loadAgentPrompt('review-code', vars, '/boards/B-1', '/project');
    expect(result).toBe('System: ISSUE-1');
  });

  it('strips YAML frontmatter correctly', () => {
    const agentPath = new URL('./agents/test-agent.md', import.meta.url).pathname;
    mockFs[agentPath] = '---\nname: test-agent\ndescription: A test agent\ntype: review\nvariables: [a, b]\nchecks: [x]\n---\nHello {{a}} and {{b}}.';

    const result = loadAgentPrompt('test-agent', { a: 'world', b: 'friend' });
    expect(result).toBe('Hello world and friend.');
  });

  it('preserves unmatched variables as-is', () => {
    const agentPath = new URL('./agents/test-agent.md', import.meta.url).pathname;
    mockFs[agentPath] = '---\nname: test\n---\n{{known}} and {{unknown}}.';

    const result = loadAgentPrompt('test-agent', { known: 'yes' });
    expect(result).toBe('yes and {{unknown}}.');
  });

  it('handles files without frontmatter', () => {
    const agentPath = new URL('./agents/plain.md', import.meta.url).pathname;
    mockFs[agentPath] = 'No frontmatter here. Just {{var}}.';

    const result = loadAgentPrompt('plain', { var: 'text' });
    expect(result).toBe('No frontmatter here. Just text.');
  });
});

// ── loadSkillTemplate ───────────────────────────────────────────

describe('loadSkillTemplate', () => {
  it('returns null when Skill does not exist', () => {
    expect(loadSkillTemplate('nonexistent', '/project')).toBeNull();
  });

  it('loads Skill body with frontmatter stripped', () => {
    mockFs['/project/.claude/skills'] = '';
    mockFs['/project/.claude/skills/my-skill/SKILL.md'] = '---\nname: my-skill\ndescription: test\n---\nHello {{name}}.';

    const result = loadSkillTemplate('my-skill', '/project');
    expect(result).toBe('Hello {{name}}.');
  });

  it('walks up directory tree to find .claude/skills/', () => {
    mockFs['/project/.claude/skills'] = '';
    mockFs['/project/.claude/skills/my-skill/SKILL.md'] = '---\nname: my-skill\n---\nFound it.';

    const result = loadSkillTemplate('my-skill', '/project/deep/nested/dir');
    expect(result).toBe('Found it.');
  });

  it('falls back to system agents when Skill not found', () => {
    const agentPath = new URL('./agents/my-skill.md', import.meta.url).pathname;
    mockFs[agentPath] = '---\nname: my-skill\n---\nFallback body.';

    const result = loadSkillTemplate('my-skill', '/project');
    expect(result).toBe('Fallback body.');
  });
});

// ── loadSkillPrompt ─────────────────────────────────────────────

describe('loadSkillPrompt', () => {
  it('returns null when Skill does not exist', () => {
    expect(loadSkillPrompt('nonexistent', { x: '1' }, '/project')).toBeNull();
  });

  it('loads and interpolates variables', () => {
    mockFs['/project/.claude/skills'] = '';
    mockFs['/project/.claude/skills/test-skill/SKILL.md'] = '---\nname: test-skill\n---\nValue: {{x}}, Other: {{y}}.';

    const result = loadSkillPrompt('test-skill', { x: 'hello', y: 'world' }, '/project');
    expect(result).toBe('Value: hello, Other: world.');
  });

  it('preserves unmatched placeholders', () => {
    mockFs['/project/.claude/skills'] = '';
    mockFs['/project/.claude/skills/test-skill/SKILL.md'] = '---\nname: test-skill\n---\n{{a}} {{b}} {{c}}.';

    const result = loadSkillPrompt('test-skill', { a: 'X' }, '/project');
    expect(result).toBe('X {{b}} {{c}}.');
  });

  it('handles empty variables map', () => {
    mockFs['/project/.claude/skills'] = '';
    mockFs['/project/.claude/skills/test-skill/SKILL.md'] = '---\nname: test-skill\n---\nNo vars here.';

    const result = loadSkillPrompt('test-skill', {}, '/project');
    expect(result).toBe('No vars here.');
  });
});

// ── Resolution order integration ─────────────────────────────────

describe('resolution order', () => {
  it('board > Skill > system for loadAgentPrompt', () => {
    const agentPath = new URL('./agents/agent-x.md', import.meta.url).pathname;
    mockFs[agentPath] = '---\nname: agent-x\n---\nsystem';
    mockFs['/project/.claude/skills'] = '';
    mockFs['/project/.claude/skills/agent-x/SKILL.md'] = '---\nname: agent-x\n---\nskill';
    mockFs['/boards/B/agents/agent-x.md'] = '---\nname: agent-x\n---\nboard';

    expect(loadAgentPrompt('agent-x', {}, '/boards/B', '/project')).toBe('board');

    // Remove board
    delete mockFs['/boards/B/agents/agent-x.md'];
    expect(loadAgentPrompt('agent-x', {}, '/boards/B', '/project')).toBe('skill');

    // Remove skill
    delete mockFs['/project/.claude/skills/agent-x/SKILL.md'];
    expect(loadAgentPrompt('agent-x', {}, '/boards/B', '/project')).toBe('system');
  });
});
