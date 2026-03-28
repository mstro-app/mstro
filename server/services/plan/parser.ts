// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * PPS Parser — Parses .pm/ (or legacy .plan/) directory files into structured TypeScript objects.
 *
 * Handles YAML front matter extraction and markdown body parsing.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AcceptanceCriterion,
  Issue,
  IssueSummary,
  Milestone,
  MilestoneEpicSummary,
  PlanFullState,
  ProjectConfig,
  ProjectState,
  Sprint,
  SprintIssueSummary,
  Team,
  WorkflowStatus,
} from './types.js';

// ============================================================================
// Front Matter Extraction
// ============================================================================

interface ParsedFile {
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

function parseFrontMatter(content: string): ParsedFile {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontMatter: {}, body: content };
  }
  const frontMatter: Record<string, unknown> = {};

  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    frontMatter[trimmed.slice(0, colonIdx).trim()] = parseYamlValue(trimmed.slice(colonIdx + 1).trim());
  }

  return { frontMatter, body: match[2] };
}

// ============================================================================
// Section Extraction
// ============================================================================

function extractSections(body: string): Map<string, string> {
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

function parseCheckboxes(content: string): AcceptanceCriterion[] {
  const items: AcceptanceCriterion[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (match) {
      items.push({ text: match[2].trim(), checked: match[1] !== ' ' });
    }
  }
  return items;
}

function parseListItems(content: string): string[] {
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
    // Match: 1. [IS-003](backlog/IS-003.md) — Title (P1)
    const match = line.match(/\d+\.\s+\[([^\]]+)\]\(([^)]+)\)\s*[—–-]\s*(.+?)(?:\s*\((\w+)\))?\s*$/);
    if (match) {
      summaries.push({
        id: match[1],
        path: match[2],
        title: match[3].trim(),
        priority: match[4] || '',
      });
      continue;
    }
    // Match: - [IS-001](backlog/IS-001.md) — Title
    const match2 = line.match(/^[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*[—–-]\s*(.+?)(?:\s*[→→]\s*blocked by\s+\[([^\]]+)\])?\s*$/i);
    if (match2) {
      summaries.push({
        id: match2[1],
        path: match2[2],
        title: match2[3].trim(),
        priority: '',
        blockedBy: match2[4] || undefined,
      });
    }
  }
  return summaries;
}

function parseCompletedSummaries(content: string): IssueSummary[] {
  const summaries: IssueSummary[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*[—–-]\s*(.+?)(?:\s*✓)?\s*$/);
    if (match) {
      summaries.push({
        id: match[1],
        path: match[2],
        title: match[3].trim(),
        priority: '',
      });
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
      workflows.push({
        status: match[1],
        category: match[2] as WorkflowStatus['category'],
        description: match[3].trim(),
      });
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

function parseProjectConfig(content: string): ProjectConfig {
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

function parseProjectState(content: string): ProjectState {
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

function toStringArray(val: unknown): string[] {
  return Array.isArray(val) ? val.map(String) : [];
}

function optionalString(val: unknown): string | null {
  return (val as string) || null;
}

function parseIssue(content: string, filePath: string): Issue {
  const { frontMatter: fm, body } = parseFrontMatter(content);
  const sections = extractSections(body);

  return {
    id: String(fm.id || ''),
    title: String(fm.title || ''),
    type: (fm.type as Issue['type']) || 'issue',
    status: String(fm.status || 'backlog'),
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
      issues.push({
        id: match[1],
        path: match[2],
        title: match[3].trim(),
        points: /^\d+$/.test(match[4]) ? Number(match[4]) : match[4],
        status: match[5],
      });
    }
  }
  return issues;
}

function optionalNumber(val: unknown): number | null {
  return val != null ? Number(val) : null;
}

function parseSprint(content: string, filePath: string): Sprint {
  const { frontMatter: fm, body } = parseFrontMatter(content);
  const sections = extractSections(body);

  return {
    id: String(fm.id || ''),
    title: String(fm.title || ''),
    status: (fm.status as Sprint['status']) || 'planned',
    start: String(fm.start || ''),
    end: String(fm.end || ''),
    goal: String(fm.goal || sections.get('Goal') || ''),
    capacity: optionalNumber(fm.capacity),
    committed: optionalNumber(fm.committed),
    completed: optionalNumber(fm.completed),
    issues: parseSprintIssues(sections.get('Issues')),
    path: filePath,
  };
}

function parseMilestone(content: string, filePath: string): Milestone {
  const { frontMatter, body } = parseFrontMatter(content);
  const sections = extractSections(body);

  const epics: MilestoneEpicSummary[] = [];
  const epicSection = sections.get('Epics');
  if (epicSection) {
    for (const line of epicSection.split('\n')) {
      const match = line.match(/\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.+?)\s*\|\s*(\S+)\s*\|/);
      if (match) {
        epics.push({
          id: match[1],
          path: match[2],
          title: match[3].trim(),
          progress: match[4],
        });
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

// ============================================================================
// Directory Parser
// ============================================================================

/** Resolve the PM directory — prefers .pm/, falls back to legacy .plan/ */
export function resolvePmDir(workingDir: string): string | null {
  const pmDir = join(workingDir, '.pm');
  if (existsSync(pmDir)) return pmDir;
  const legacyDir = join(workingDir, '.plan');
  if (existsSync(legacyDir)) return legacyDir;
  return null;
}

export function planDirExists(workingDir: string): boolean {
  return resolvePmDir(workingDir) !== null;
}

function readFileIfExists(path: string): string | null {
  try {
    if (existsSync(path)) return readFileSync(path, 'utf-8');
  } catch { /* skip */ }
  return null;
}

function readMdFilesInDir(dirPath: string): Array<{ name: string; content: string }> {
  if (!existsSync(dirPath)) return [];
  try {
    return readdirSync(dirPath)
      .filter(f => f.endsWith('.md'))
      .map(name => {
        const content = readFileSync(join(dirPath, name), 'utf-8');
        return { name, content };
      });
  } catch { return []; }
}

export function parsePlanDirectory(workingDir: string): PlanFullState | null {
  const planDir = resolvePmDir(workingDir);
  if (!planDir) return null;

  // Parse project.md
  const projectContent = readFileIfExists(join(planDir, 'project.md'));
  const project = projectContent
    ? parseProjectConfig(projectContent)
    : { name: '', id: '', created: '', status: 'active' as const, estimation: 'none' as const, idPrefixes: {}, workflows: [], labels: [], teams: [] };

  // Parse STATE.md
  const stateContent = readFileIfExists(join(planDir, 'STATE.md'));
  const state = stateContent
    ? parseProjectState(stateContent)
    : { project: '', currentSprint: null, activeMilestone: null, paused: false, lastSession: null, readyToWork: [], inProgress: [], blocked: [], recentlyCompleted: [], warnings: [] };

  // Parse backlog issues
  const issueFiles = readMdFilesInDir(join(planDir, 'backlog'));
  const issues = issueFiles.map(f => parseIssue(f.content, `backlog/${f.name}`));

  // Parse sprints
  const sprintFiles = readMdFilesInDir(join(planDir, 'sprints'));
  const sprints = sprintFiles.map(f => parseSprint(f.content, `sprints/${f.name}`));

  // Parse milestones
  const milestoneFiles = readMdFilesInDir(join(planDir, 'milestones'));
  const milestones = milestoneFiles.map(f => parseMilestone(f.content, `milestones/${f.name}`));

  return { project, state, issues, sprints, milestones };
}

export function parseSingleIssue(workingDir: string, issuePath: string): Issue | null {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return null;
  const fullPath = join(pmDir, issuePath);
  const content = readFileIfExists(fullPath);
  if (!content) return null;
  return parseIssue(content, issuePath);
}

export function parseSingleSprint(workingDir: string, sprintPath: string): Sprint | null {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return null;
  const fullPath = join(pmDir, sprintPath);
  const content = readFileIfExists(fullPath);
  if (!content) return null;
  return parseSprint(content, sprintPath);
}

export function parseSingleMilestone(workingDir: string, milestonePath: string): Milestone | null {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return null;
  const fullPath = join(pmDir, milestonePath);
  const content = readFileIfExists(fullPath);
  if (!content) return null;
  return parseMilestone(content, milestonePath);
}

/** Compute the next available ID for a given prefix (e.g., "IS" → "IS-004") */
export function getNextId(issues: Issue[], prefix: string): string {
  let max = 0;
  for (const issue of issues) {
    const match = issue.id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}
