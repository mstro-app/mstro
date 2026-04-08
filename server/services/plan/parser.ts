// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * PPS Parser — Public API for reading .mstro/pm/ directories.
 *
 * Entity parsing lives in parser-core.ts; migration in parser-migration.ts.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBoard, parseIssue, parseMilestone, parseProjectConfig, parseProjectState, parseSprint, parseWorkspace } from './parser-core.js';
import { isLegacyFormat, migrateToBoards } from './parser-migration.js';
import type {
  Board,
  BoardArtifacts,
  BoardFullState,
  Issue,
  Milestone,
  PlanFullState,
  ProjectConfig,
  ProjectState,
  ReviewResult,
  Sprint,
  SprintArtifacts,
  Workspace,
} from './types.js';

// ============================================================================
// Directory Resolution
// ============================================================================

export function isBoardCentricFormat(pmDir: string): boolean {
  return existsSync(join(pmDir, 'boards'));
}

export function resolvePmDir(workingDir: string): string | null {
  const mstroPmDir = join(workingDir, '.mstro', 'pm');
  if (existsSync(mstroPmDir)) return mstroPmDir;
  return null;
}

export function defaultPmDir(workingDir: string): string {
  return join(workingDir, '.mstro', 'pm');
}

export function planDirExists(workingDir: string): boolean {
  return resolvePmDir(workingDir) !== null;
}

// ============================================================================
// File Utilities
// ============================================================================

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
      .map(name => ({ name, content: readFileSync(join(dirPath, name), 'utf-8') }));
  } catch { return []; }
}

function listDirFiles(dirPath: string, ext: string): string[] {
  if (!existsSync(dirPath)) return [];
  try {
    return readdirSync(dirPath).filter(f => f.endsWith(ext));
  } catch { return []; }
}

function readReviewResults(reviewsDir: string): ReviewResult[] {
  const results: ReviewResult[] = [];
  for (const f of listDirFiles(reviewsDir, '.json')) {
    const content = readFileIfExists(join(reviewsDir, f));
    if (content) results.push(JSON.parse(content) as ReviewResult);
  }
  return results;
}

// ============================================================================
// Defaults
// ============================================================================

const defaultProject: ProjectConfig = {
  name: '', id: '', created: '', status: 'active', estimation: 'none',
  idPrefixes: {}, workflows: [], labels: [], teams: [],
};

const defaultState: ProjectState = {
  project: '', currentSprint: null, activeMilestone: null, paused: false,
  lastSession: null, readyToWork: [], inProgress: [], blocked: [],
  recentlyCompleted: [], warnings: [],
};

// ============================================================================
// Board & Plan Directory Parsing
// ============================================================================

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
    issue.blockedBy = issue.blockedBy.map(bp => bp.startsWith('boards/') ? bp : `${boardPrefix}${bp}`);
    issue.blocks = issue.blocks.map(bp => bp.startsWith('boards/') ? bp : `${boardPrefix}${bp}`);
    if (issue.epic && !issue.epic.startsWith('boards/')) issue.epic = `${boardPrefix}${issue.epic}`;
    if (issue.children.length > 0) {
      issue.children = issue.children.map(cp => cp.startsWith('boards/') ? cp : `${boardPrefix}${cp}`);
    }
    return issue;
  });

  return { board, state, issues };
}

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

// ============================================================================
// Single Entity Parsers
// ============================================================================

export function parseSingleIssue(workingDir: string, issuePath: string): Issue | null {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return null;
  const content = readFileIfExists(join(pmDir, issuePath));
  if (!content) return null;
  return parseIssue(content, issuePath);
}

export function parseSingleSprint(workingDir: string, sprintPath: string): Sprint | null {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return null;
  const content = readFileIfExists(join(pmDir, sprintPath));
  if (!content) return null;
  return parseSprint(content, sprintPath);
}

export function parseSingleMilestone(workingDir: string, milestonePath: string): Milestone | null {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return null;
  const content = readFileIfExists(join(pmDir, milestonePath));
  if (!content) return null;
  return parseMilestone(content, milestonePath);
}

// ============================================================================
// ID Generation
// ============================================================================

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

export function parseBoardArtifacts(workingDir: string, boardId: string): BoardArtifacts | null {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return null;

  const boardDir = join(pmDir, 'boards', boardId);
  if (!existsSync(boardDir)) return null;

  const progressLog = readFileIfExists(join(boardDir, 'progress.md')) ?? '';
  const outputFiles = listDirFiles(join(boardDir, 'out'), '.md');
  const reviewResults = readReviewResults(join(boardDir, 'reviews'));
  const executionLogs = listDirFiles(join(boardDir, 'logs'), '.log').sort();

  return { boardId, progressLog, outputFiles, reviewResults, executionLogs };
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
  const outputFiles = listDirFiles(join(sandboxDir, 'out'), '.md');
  const reviewResults = readReviewResults(join(sandboxDir, 'reviews'));

  return { sprintId, progressLog, outputFiles, reviewResults };
}
