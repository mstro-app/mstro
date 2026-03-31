// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * PPS Parser — Parses .pm/ (or legacy .plan/) directory files into structured TypeScript objects.
 *
 * Handles YAML front matter extraction and markdown body parsing.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AcceptanceCriterion,
  Board,
  BoardArtifacts,
  BoardExecutionSummary,
  BoardFullState,
  Issue,
  IssueSummary,
  Milestone,
  MilestoneEpicSummary,
  PlanFullState,
  ProjectConfig,
  ProjectState,
  ReviewResult,
  Sprint,
  SprintArtifacts,
  SprintExecutionSummary,
  SprintIssueSummary,
  Team,
  WorkflowStatus,
  Workspace,
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

/** Consume indented YAML list items starting after the current index. Returns [items, newIndex]. */
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

function parseFrontMatter(content: string): ParsedFile {
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
  if (val == null) return null;
  const s = String(val);
  return s === '' ? null : s;
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

  // Table-based parsing (markdown links in table rows)
  let issues = parseSprintIssues(sections.get('Issues'));

  // Fallback: front matter issues array (e.g., ["backlog/IS-001.md", ...])
  if (issues.length === 0 && Array.isArray(fm.issues)) {
    issues = (fm.issues as string[]).map(path => {
      const id = path.replace(/^backlog\//, '').replace(/\.md$/, '');
      return { id, path, title: '', points: null, status: '' };
    });
  }

  // Parse execution_summary if present (JSON object in front matter)
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
// Board Parser
// ============================================================================

function parseBoard(content: string, filePath: string): Board {
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
    path: filePath,
  };
}

function parseWorkspace(content: string): Workspace {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return {
      activeBoardId: typeof parsed.activeBoardId === 'string' ? parsed.activeBoardId : null,
      boardOrder: Array.isArray(parsed.boardOrder) ? parsed.boardOrder.map(String) : [],
    };
  } catch {
    return { activeBoardId: null, boardOrder: [] };
  }
}

/** Check whether a .pm/ directory uses the board-centric format (has boards/ subdirectory). */
export function isBoardCentricFormat(pmDir: string): boolean {
  return existsSync(join(pmDir, 'boards'));
}

/** Check whether a .pm/ directory uses the legacy flat format (has backlog/ at root, no boards/). */
function isLegacyFormat(pmDir: string): boolean {
  return existsSync(join(pmDir, 'backlog')) && !existsSync(join(pmDir, 'boards'));
}

// ============================================================================
// Legacy → Board Migration
// ============================================================================

/** Move all files from a legacy directory into a board subdirectory and remove the source. */
function moveLegacyDir(srcDir: string, destDir: string): void {
  if (!existsSync(srcDir)) return;
  for (const file of readdirSync(srcDir)) {
    renameSync(join(srcDir, file), join(destDir, file));
  }
  rmSync(srcDir, { recursive: true });
}

/** Move a single file if it exists. */
function moveLegacyFile(src: string, dest: string): void {
  if (existsSync(src)) renameSync(src, dest);
}

/** Copy review files from sprint sandbox directories into the board reviews dir. */
function copySprintReviews(sprintsDir: string, boardReviewsDir: string): void {
  for (const entry of readdirSync(sprintsDir)) {
    if (entry.endsWith('.md')) continue;
    const reviewsDir = join(sprintsDir, entry, 'reviews');
    if (!existsSync(reviewsDir)) continue;
    for (const reviewFile of readdirSync(reviewsDir)) {
      cpSync(join(reviewsDir, reviewFile), join(boardReviewsDir, reviewFile));
    }
  }
}

/** Find and return the goal from the active sprint .md file. */
function extractActiveSprintGoal(sprintsDir: string): string {
  for (const entry of readdirSync(sprintsDir).filter(e => e.endsWith('.md'))) {
    const content = readFileIfExists(join(sprintsDir, entry));
    if (!content) continue;
    const fm = parseFrontMatter(content).frontMatter;
    if (fm.status === 'active') return String(fm.goal || '');
  }
  return '';
}

/** Migrate sprint reviews and extract the active sprint's goal. */
function migrateLegacySprints(sprintsDir: string, boardReviewsDir: string): string {
  if (!existsSync(sprintsDir)) return '';
  copySprintReviews(sprintsDir, boardReviewsDir);
  const goal = extractActiveSprintGoal(sprintsDir);
  rmSync(sprintsDir, { recursive: true });
  return goal;
}

/** Clean up migrated issues: remove sprint fields, detect active issues. */
function cleanupMigratedIssues(boardBacklogDir: string): boolean {
  if (!existsSync(boardBacklogDir)) return false;
  let hasActive = false;

  for (const file of readdirSync(boardBacklogDir).filter(f => f.endsWith('.md'))) {
    const content = readFileIfExists(join(boardBacklogDir, file));
    if (!content) continue;
    if (content.match(/^status:\s*(in_progress|in_review|todo)/m)) hasActive = true;
    if (content.match(/^sprint:\s*.+$/m)) {
      writeFileSync(join(boardBacklogDir, file), content.replace(/^sprint:\s*.+\n?/m, ''), 'utf-8');
    }
  }
  return hasActive;
}

/** Write the board metadata files (board.md, workspace.json, STATE.md, progress.md). */
function writeBoardMetadata(pmDir: string, boardDir: string, boardId: string, sprintGoal: string, hasActive: boolean): void {
  const today = new Date().toISOString().slice(0, 10);
  const boardMd = [
    '---', `id: ${boardId}`, 'title: "Board 1"',
    `status: ${hasActive ? 'active' : 'draft'}`, `created: "${today}"`,
    'completed_at: null', `goal: "${sprintGoal.replace(/"/g, '\\"')}"`,
    '---', '', '# Board 1', '',
    sprintGoal ? `## Goal\n${sprintGoal}\n` : '',
  ].join('\n');
  writeFileSync(join(boardDir, 'board.md'), boardMd, 'utf-8');

  const workspace: Workspace = { activeBoardId: boardId, boardOrder: [boardId] };
  writeFileSync(join(pmDir, 'workspace.json'), JSON.stringify(workspace, null, 2), 'utf-8');

  if (!existsSync(join(boardDir, 'STATE.md'))) {
    writeFileSync(join(boardDir, 'STATE.md'), [
      '---', 'project: ../../project.md', 'board: board.md', 'paused: false', '---', '',
      '# Board State', '', '## Ready to Work', '', '## In Progress', '',
      '## Blocked', '', '## Recently Completed', '', '## Warnings', '',
    ].join('\n'), 'utf-8');
  }
  if (!existsSync(join(boardDir, 'progress.md'))) {
    writeFileSync(join(boardDir, 'progress.md'), '# Board Progress\n', 'utf-8');
  }
}

/**
 * Migrate a legacy flat .pm/ directory to board-centric format.
 * Creates BOARD-001 from the existing backlog, state, outputs, and reviews.
 */
function migrateToBoards(pmDir: string): void {
  const boardId = 'BOARD-001';
  const boardDir = join(pmDir, 'boards', boardId);

  mkdirSync(boardDir, { recursive: true });
  mkdirSync(join(boardDir, 'backlog'), { recursive: true });
  mkdirSync(join(boardDir, 'out'), { recursive: true });
  mkdirSync(join(boardDir, 'reviews'), { recursive: true });

  moveLegacyDir(join(pmDir, 'backlog'), join(boardDir, 'backlog'));
  moveLegacyFile(join(pmDir, 'STATE.md'), join(boardDir, 'STATE.md'));
  moveLegacyDir(join(pmDir, 'out'), join(boardDir, 'out'));
  moveLegacyFile(join(pmDir, 'progress.md'), join(boardDir, 'progress.md'));

  const sprintGoal = migrateLegacySprints(join(pmDir, 'sprints'), join(boardDir, 'reviews'));
  const hasActive = cleanupMigratedIssues(join(boardDir, 'backlog'));
  writeBoardMetadata(pmDir, boardDir, boardId, sprintGoal, hasActive);
}

// ============================================================================
// Directory Parser
// ============================================================================

/** Resolve the PM directory — prefers .mstro/pm/, falls back to legacy .pm/ and .plan/ */
export function resolvePmDir(workingDir: string): string | null {
  const mstroPmDir = join(workingDir, '.mstro', 'pm');
  if (existsSync(mstroPmDir)) return mstroPmDir;
  const legacyPmDir = join(workingDir, '.pm');
  if (existsSync(legacyPmDir)) return legacyPmDir;
  const legacyPlanDir = join(workingDir, '.plan');
  if (existsSync(legacyPlanDir)) return legacyPlanDir;
  return null;
}

/** Default PM directory path for new projects */
export function defaultPmDir(workingDir: string): string {
  return join(workingDir, '.mstro', 'pm');
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

const defaultProject: ProjectConfig = {
  name: '', id: '', created: '', status: 'active', estimation: 'none',
  idPrefixes: {}, workflows: [], labels: [], teams: [],
};

const defaultState: ProjectState = {
  project: '', currentSprint: null, activeMilestone: null, paused: false,
  lastSession: null, readyToWork: [], inProgress: [], blocked: [],
  recentlyCompleted: [], warnings: [],
};

/** Parse a single board's full state (board.md + STATE.md + backlog/). */
export function parseBoardDirectory(pmDir: string, boardId: string): BoardFullState | null {
  const boardDir = join(pmDir, 'boards', boardId);
  if (!existsSync(boardDir)) return null;

  const boardContent = readFileIfExists(join(boardDir, 'board.md'));
  if (!boardContent) return null;
  const board = parseBoard(boardContent, `boards/${boardId}/board.md`);

  const stateContent = readFileIfExists(join(boardDir, 'STATE.md'));
  const state = stateContent ? parseProjectState(stateContent) : { ...defaultState };

  const issueFiles = readMdFilesInDir(join(boardDir, 'backlog'));
  const boardPrefix = `boards/${boardId}/`;
  const issues = issueFiles.map(f => {
    const issue = parseIssue(f.content, `${boardPrefix}backlog/${f.name}`);
    // Normalize blocked_by/blocks to full board-relative paths so dependency resolver matches
    issue.blockedBy = issue.blockedBy.map(bp => bp.startsWith('boards/') ? bp : `${boardPrefix}${bp}`);
    issue.blocks = issue.blocks.map(bp => bp.startsWith('boards/') ? bp : `${boardPrefix}${bp}`);
    if (issue.epic && !issue.epic.startsWith('boards/')) issue.epic = `${boardPrefix}${issue.epic}`;
    return issue;
  });

  return { board, state, issues };
}

/** Parse all boards from the boards/ directory and resolve the active board. */
function parseBoardCentricState(planDir: string): { boards: Board[]; workspace: Workspace; activeBoard: BoardFullState | null } {
  const workspaceContent = readFileIfExists(join(planDir, 'workspace.json'));
  const workspace = workspaceContent ? parseWorkspace(workspaceContent) : { activeBoardId: null, boardOrder: [] };

  const boards: Board[] = [];
  const boardsDir = join(planDir, 'boards');
  if (existsSync(boardsDir)) {
    for (const entry of readdirSync(boardsDir)) {
      const boardMdPath = join(boardsDir, entry, 'board.md');
      if (!existsSync(boardMdPath)) continue;
      boards.push(parseBoard(readFileSync(boardMdPath, 'utf-8'), `boards/${entry}/board.md`));
    }
  }

  const orderMap = new Map(workspace.boardOrder.map((id, i) => [id, i]));
  boards.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));

  const activeBoard = workspace.activeBoardId ? parseBoardDirectory(planDir, workspace.activeBoardId) : null;
  return { boards, workspace, activeBoard };
}

export function parsePlanDirectory(workingDir: string): PlanFullState | null {
  const planDir = resolvePmDir(workingDir);
  if (!planDir) return null;

  if (isLegacyFormat(planDir)) migrateToBoards(planDir);

  const projectContent = readFileIfExists(join(planDir, 'project.md'));
  const project = projectContent ? parseProjectConfig(projectContent) : { ...defaultProject };
  const milestoneFiles = readMdFilesInDir(join(planDir, 'milestones'));
  const milestones = milestoneFiles.map(f => parseMilestone(f.content, `milestones/${f.name}`));

  if (!isBoardCentricFormat(planDir)) {
    return {
      project, state: { ...defaultState }, boards: [], workspace: { activeBoardId: null, boardOrder: [] },
      activeBoard: null, issues: [], sprints: [], milestones,
    };
  }

  const { boards, workspace, activeBoard } = parseBoardCentricState(planDir);
  return {
    project, state: activeBoard?.state ?? { ...defaultState },
    boards, workspace, activeBoard, issues: activeBoard?.issues ?? [],
    sprints: [], milestones,
  };
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
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}-(\\d+)$`);
  let max = 0;
  for (const issue of issues) {
    const match = issue.id.match(pattern);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

/** Compute the next available board ID (e.g., "BOARD-003") */
export function getNextBoardId(boards: Board[]): string {
  let max = 0;
  for (const board of boards) {
    const match = board.id.match(/^BOARD-(\d+)$/);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return `BOARD-${String(max + 1).padStart(3, '0')}`;
}

/** Compute the next available board number for display title (e.g., "Board 3") */
export function getNextBoardNumber(boards: Board[]): number {
  let max = 0;
  for (const board of boards) {
    const match = board.title.match(/^Board (\d+)$/);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return max + 1;
}

/** Parse board artifacts from boards/BOARD-N/ directory. */
export function parseBoardArtifacts(workingDir: string, boardId: string): BoardArtifacts | null {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return null;

  const boardDir = join(pmDir, 'boards', boardId);
  if (!existsSync(boardDir)) return null;

  const progressLog = readFileIfExists(join(boardDir, 'progress.md')) ?? '';

  const outDir = join(boardDir, 'out');
  let outputFiles: string[] = [];
  if (existsSync(outDir)) {
    try {
      outputFiles = readdirSync(outDir).filter(f => f.endsWith('.md'));
    } catch { /* skip */ }
  }

  const reviewsDir = join(boardDir, 'reviews');
  const reviewResults: ReviewResult[] = [];
  if (existsSync(reviewsDir)) {
    try {
      for (const f of readdirSync(reviewsDir).filter(f => f.endsWith('.json'))) {
        const content = readFileIfExists(join(reviewsDir, f));
        if (content) {
          reviewResults.push(JSON.parse(content) as ReviewResult);
        }
      }
    } catch { /* skip */ }
  }

  return { boardId, progressLog, outputFiles, reviewResults };
}

/** @deprecated Use getNextBoardId — kept for migration compatibility */
export function getNextSprintId(sprints: Sprint[]): string {
  let max = 0;
  for (const sprint of sprints) {
    const match = sprint.id.match(/^SPRINT-(\d+)$/);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return `SPRINT-${String(max + 1).padStart(3, '0')}`;
}

/** @deprecated Use parseBoardArtifacts — kept for migration compatibility */
export function parseSprintArtifacts(workingDir: string, sprintId: string): SprintArtifacts | null {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return null;

  const sandboxDir = join(pmDir, 'sprints', sprintId);
  if (!existsSync(sandboxDir)) return null;

  const progressLog = readFileIfExists(join(sandboxDir, 'progress.md')) ?? '';

  const outDir = join(sandboxDir, 'out');
  let outputFiles: string[] = [];
  if (existsSync(outDir)) {
    try {
      outputFiles = readdirSync(outDir).filter(f => f.endsWith('.md'));
    } catch { /* skip */ }
  }

  const reviewsDir = join(sandboxDir, 'reviews');
  const reviewResults: ReviewResult[] = [];
  if (existsSync(reviewsDir)) {
    try {
      for (const f of readdirSync(reviewsDir).filter(f => f.endsWith('.json'))) {
        const content = readFileIfExists(join(reviewsDir, f));
        if (content) {
          reviewResults.push(JSON.parse(content) as ReviewResult);
        }
      }
    } catch { /* skip */ }
  }

  return { sprintId, progressLog, outputFiles, reviewResults };
}
