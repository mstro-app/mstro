// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * YAML front-matter parsing and entity parsers for PPS (.mstro/pm/) files.
 */

import type {
  AcceptanceCriterion,
  Board,
  BoardExecutionSummary,
  Issue,
  IssueSummary,
  Milestone,
  MilestoneEpicSummary,
  ProjectConfig,
  ProjectState,
  Sprint,
  SprintExecutionSummary,
  SprintIssueSummary,
  Team,
  WorkflowStatus,
  Workspace,
} from './types.js';

// ============================================================================
// Front Matter Extraction
// ============================================================================

export interface ParsedFile {
  frontMatter: Record<string, unknown>;
  body: string;
}

function stripQuotes(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseYamlValue(v: string): unknown {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map(s => stripQuotes(s.trim())).filter(Boolean);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~' || v === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function consumeIndentedList(lines: string[], startIdx: number): [string[], number] {
  const items: string[] = [];
  let i = startIdx;
  while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
    i++;
    const item = lines[i].trim().replace(/^-\s+/, '');
    items.push(stripQuotes(item));
  }
  return [items, i];
}

export function parseFrontMatter(content: string): ParsedFile {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontMatter: {}, body: content };
  }
  const frontMatter: Record<string, unknown> = {};
  const lines = match[1].split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (!rawValue) {
      const [items, newIdx] = consumeIndentedList(lines, i);
      i = newIdx;
      frontMatter[key] = items.length > 0 ? items : null;
    } else {
      frontMatter[key] = parseYamlValue(rawValue);
    }
  }

  return { frontMatter, body: match[2] };
}

// ============================================================================
// Section Extraction
// ============================================================================

export function extractSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.split('\n');
  let currentSection = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentSection) {
        sections.set(currentSection, currentContent.join('\n').trim());
      }
      currentSection = line.slice(3).trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  if (currentSection) {
    sections.set(currentSection, currentContent.join('\n').trim());
  }

  return sections;
}

export function parseCheckboxes(content: string): AcceptanceCriterion[] {
  const items: AcceptanceCriterion[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (match) {
      items.push({ text: match[2].trim(), checked: match[1] !== ' ' });
    }
  }
  return items;
}

export function parseListItems(content: string): string[] {
  const items: string[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^[-*]\s+(.+)$/);
    if (match) items.push(match[1].trim());
  }
  return items;
}

function parseIssueSummaries(content: string): IssueSummary[] {
  const summaries: IssueSummary[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/\d+\.\s+\[([^\]]+)\]\(([^)]+)\)\s*[—–-]\s*(.+?)(?:\s*\((\w+)\))?\s*$/);
    if (match) {
      summaries.push({ id: match[1], path: match[2], title: match[3].trim(), priority: match[4] || '' });
      continue;
    }
    const match2 = line.match(/^[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*[—–-]\s*(.+?)(?:\s*[→→]\s*blocked by\s+\[([^\]]+)\])?\s*$/i);
    if (match2) {
      summaries.push({ id: match2[1], path: match2[2], title: match2[3].trim(), priority: '', blockedBy: match2[4] || undefined });
    }
  }
  return summaries;
}

function parseCompletedSummaries(content: string): IssueSummary[] {
  const summaries: IssueSummary[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*[—–-]\s*(.+?)(?:\s*✓)?\s*$/);
    if (match) {
      summaries.push({ id: match[1], path: match[2], title: match[3].trim(), priority: '' });
    }
  }
  return summaries;
}

// ============================================================================
// Entity Parsers
// ============================================================================

function parseWorkflows(section: string | undefined): WorkflowStatus[] {
  if (!section) return [];
  const workflows: WorkflowStatus[] = [];
  for (const line of section.split('\n')) {
    const match = line.match(/\|\s*(\w+)\s*\|\s*(\w+)\s*\|\s*(.+?)\s*\|/);
    if (match && match[1] !== 'Status') {
      workflows.push({ status: match[1], category: match[2] as WorkflowStatus['category'], description: match[3].trim() });
    }
  }
  return workflows;
}

function parseTeams(section: string | undefined): Team[] {
  if (!section) return [];
  const teams: Team[] = [];
  for (const line of section.split('\n')) {
    const match = line.match(/^[-*]\s+(\w+)(?:\s*[—–-]\s*(.+))?$/);
    if (match) teams.push({ name: match[1], description: match[2]?.trim() });
  }
  return teams;
}

function toStringArray(val: unknown): string[] {
  return Array.isArray(val) ? val.map(String) : [];
}

function optionalString(val: unknown): string | null {
  if (val == null) return null;
  const s = String(val);
  return s === '' ? null : s;
}

function optionalNumber(val: unknown): number | null {
  return val != null ? Number(val) : null;
}

function clampParallelAgents(val: unknown): number {
  if (val == null) return 3;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 1) return 3;
  return Math.min(Math.round(n), 10);
}

export function parseProjectConfig(content: string): ProjectConfig {
  const { frontMatter, body } = parseFrontMatter(content);
  const sections = extractSections(body);

  const idPrefixes: Record<string, string> = {};
  const rawPrefixes = frontMatter.id_prefixes;
  if (rawPrefixes && typeof rawPrefixes === 'object') {
    Object.assign(idPrefixes, rawPrefixes);
  }

  return {
    name: String(frontMatter.name || ''),
    id: String(frontMatter.id || ''),
    created: String(frontMatter.created || ''),
    status: (frontMatter.status as ProjectConfig['status']) || 'active',
    estimation: (frontMatter.estimation as ProjectConfig['estimation']) || 'none',
    idPrefixes,
    workflows: parseWorkflows(sections.get('Workflows')),
    labels: (Array.isArray(frontMatter.labels) ? frontMatter.labels : []) as string[],
    teams: parseTeams(sections.get('Teams')),
  };
}

export function parseProjectState(content: string): ProjectState {
  const { frontMatter, body } = parseFrontMatter(content);
  const sections = extractSections(body);

  return {
    project: String(frontMatter.project || ''),
    currentSprint: (frontMatter.current_sprint as string) || null,
    activeMilestone: (frontMatter.active_milestone as string) || null,
    paused: frontMatter.paused === true,
    lastSession: (frontMatter.last_session as string) || null,
    readyToWork: parseIssueSummaries(sections.get('Ready to Work') || ''),
    inProgress: parseIssueSummaries(sections.get('In Progress') || ''),
    blocked: parseIssueSummaries(sections.get('Blocked') || ''),
    recentlyCompleted: parseCompletedSummaries(sections.get('Recently Completed') || ''),
    warnings: parseListItems(sections.get('Warnings') || ''),
  };
}

export function parseIssue(content: string, filePath: string): Issue {
  const { frontMatter: fm, body } = parseFrontMatter(content);
  const sections = extractSections(body);

  return {
    id: String(fm.id || ''),
    title: String(fm.title || ''),
    type: (fm.type as Issue['type']) || 'issue',
    status: String(fm.status || 'todo'),
    priority: String(fm.priority || 'P2'),
    estimate: fm.estimate != null ? fm.estimate as number | string : null,
    labels: toStringArray(fm.labels),
    epic: optionalString(fm.epic),
    sprint: optionalString(fm.sprint),
    milestone: optionalString(fm.milestone),
    assigned: optionalString(fm.assigned),
    created: String(fm.created || ''),
    updated: optionalString(fm.updated),
    due: optionalString(fm.due),
    blockedBy: toStringArray(fm.blocked_by),
    blocks: toStringArray(fm.blocks),
    relatesTo: toStringArray(fm.relates_to),
    children: toStringArray(fm.children),
    progress: optionalString(fm.progress),
    description: sections.get('Description') || '',
    acceptanceCriteria: parseCheckboxes(sections.get('Acceptance Criteria') || ''),
    technicalNotes: sections.get('Technical Notes') || null,
    filesToModify: parseListItems(sections.get('Files to Modify') || ''),
    activity: parseListItems(sections.get('Activity') || ''),
    reviewGate: (['none', 'auto', 'required'].includes(String(fm.review_gate)) ? String(fm.review_gate) : 'auto') as Issue['reviewGate'],
    outputFile: optionalString(fm.output_file),
    body,
    path: filePath,
  };
}

function parseSprintIssues(section: string | undefined): SprintIssueSummary[] {
  if (!section) return [];
  const issues: SprintIssueSummary[] = [];
  for (const line of section.split('\n')) {
    const match = line.match(/\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.+?)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|/);
    if (match) {
      issues.push({ id: match[1], path: match[2], title: match[3].trim(), points: /^\d+$/.test(match[4]) ? Number(match[4]) : match[4], status: match[5] });
    }
  }
  return issues;
}

export function parseSprint(content: string, filePath: string): Sprint {
  const { frontMatter: fm, body } = parseFrontMatter(content);
  const sections = extractSections(body);

  let issues = parseSprintIssues(sections.get('Issues'));
  if (issues.length === 0 && Array.isArray(fm.issues)) {
    issues = (fm.issues as string[]).map(path => {
      const id = path.replace(/^backlog\//, '').replace(/\.md$/, '');
      return { id, path, title: '', points: null, status: '' };
    });
  }

  let executionSummary: SprintExecutionSummary | null = null;
  if (fm.execution_summary && typeof fm.execution_summary === 'object') {
    const es = fm.execution_summary as Record<string, unknown>;
    executionSummary = {
      totalIssues: Number(es.total_issues ?? 0),
      completedIssues: Number(es.completed_issues ?? 0),
      failedIssues: Number(es.failed_issues ?? 0),
      totalDuration: Number(es.total_duration ?? 0),
      waves: Number(es.waves ?? 0),
    };
  }

  return {
    id: String(fm.id || ''),
    title: String(fm.title || ''),
    status: (fm.status as Sprint['status']) || 'planned',
    start: String(fm.start || fm.start_date || ''),
    end: String(fm.end || fm.end_date || ''),
    goal: String(fm.goal || sections.get('Goal') || sections.get('Sprint Goal') || ''),
    capacity: optionalNumber(fm.capacity),
    committed: optionalNumber(fm.committed),
    completed: optionalNumber(fm.completed),
    issues,
    path: filePath,
    completedAt: optionalString(fm.completed_at),
    executionSummary,
  };
}

export function parseMilestone(content: string, filePath: string): Milestone {
  const { frontMatter, body } = parseFrontMatter(content);
  const sections = extractSections(body);

  const epics: MilestoneEpicSummary[] = [];
  const epicSection = sections.get('Epics');
  if (epicSection) {
    for (const line of epicSection.split('\n')) {
      const match = line.match(/\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.+?)\s*\|\s*(\S+)\s*\|/);
      if (match) {
        epics.push({ id: match[1], path: match[2], title: match[3].trim(), progress: match[4] });
      }
    }
  }

  return {
    id: String(frontMatter.id || ''),
    title: String(frontMatter.title || ''),
    status: (frontMatter.status as Milestone['status']) || 'planned',
    targetDate: (frontMatter.target_date as string) || null,
    progress: (frontMatter.progress as string) || null,
    definition: sections.get('Definition of Done') || '',
    epics,
    path: filePath,
  };
}

export function parseBoard(content: string, filePath: string): Board {
  const { frontMatter: fm, body } = parseFrontMatter(content);
  const sections = extractSections(body);

  let executionSummary: BoardExecutionSummary | null = null;
  if (fm.execution_summary && typeof fm.execution_summary === 'object') {
    const es = fm.execution_summary as Record<string, unknown>;
    executionSummary = {
      totalIssues: Number(es.total_issues ?? 0),
      completedIssues: Number(es.completed_issues ?? 0),
      failedIssues: Number(es.failed_issues ?? 0),
      totalDuration: Number(es.total_duration ?? 0),
      waves: Number(es.waves ?? 0),
    };
  }

  return {
    id: String(fm.id || ''),
    title: String(fm.title || ''),
    status: (fm.status as Board['status']) || 'draft',
    created: String(fm.created || ''),
    completedAt: optionalString(fm.completed_at),
    goal: String(fm.goal || sections.get('Goal') || ''),
    executionSummary,
    maxParallelAgents: clampParallelAgents(fm.max_parallel_agents),
    reviewCriteria: String(fm.review_criteria || sections.get('Review Criteria') || '').replace(/\\n/g, '\n'),
    path: filePath,
  };
}

function parseWorktreeEntry(v: unknown): { path: string; branch: string } | null {
  if (!v || typeof v !== 'object' || !('path' in v) || !('branch' in v)) return null;
  const e = v as { path: unknown; branch: unknown };
  return typeof e.path === 'string' && typeof e.branch === 'string' ? { path: e.path, branch: e.branch } : null;
}

export function parseWorkspace(content: string): Workspace {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const boardWorktrees: Record<string, { path: string; branch: string }> = {};
    if (parsed.boardWorktrees && typeof parsed.boardWorktrees === 'object') {
      for (const [k, v] of Object.entries(parsed.boardWorktrees as Record<string, unknown>)) {
        const entry = parseWorktreeEntry(v);
        if (entry) boardWorktrees[k] = entry;
      }
    }
    return {
      activeBoardId: typeof parsed.activeBoardId === 'string' ? parsed.activeBoardId : null,
      boardOrder: Array.isArray(parsed.boardOrder) ? parsed.boardOrder.map(String) : [],
      ...(Object.keys(boardWorktrees).length > 0 ? { boardWorktrees } : {}),
    };
  } catch {
    return { activeBoardId: null, boardOrder: [] };
  }
}
