// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Plan Types — Project Plan Spec (PPS) data structures
 *
 * These types represent the parsed contents of .mstro/pm/ directory files.
 */

// ============================================================================
// Project Config (project.md front matter)
// ============================================================================

export interface ProjectConfig {
  name: string;
  id: string;
  created: string;
  status: 'active' | 'paused' | 'completed' | 'archived';
  estimation: 'fibonacci' | 'tshirt' | 'hours' | 'none';
  idPrefixes: Record<string, string>;
  workflows: WorkflowStatus[];
  labels: string[];
  teams: Team[];
}

export interface WorkflowStatus {
  status: string;
  category: 'ready' | 'unstarted' | 'started' | 'completed' | 'cancelled';
  description: string;
}

export interface Team {
  name: string;
  description?: string;
}

// ============================================================================
// Project State (STATE.md front matter + body)
// ============================================================================

export interface ProjectState {
  project: string;
  currentSprint: string | null;
  activeMilestone: string | null;
  paused: boolean;
  lastSession: string | null;
  // Parsed from markdown body sections:
  readyToWork: IssueSummary[];
  inProgress: IssueSummary[];
  blocked: IssueSummary[];
  recentlyCompleted: IssueSummary[];
  warnings: string[];
}

export interface IssueSummary {
  id: string;
  title: string;
  path: string;
  priority: string;
  blockedBy?: string;
}

// ============================================================================
// Issue / Epic / Bug (backlog/*.md)
// ============================================================================

export interface Issue {
  id: string;
  title: string;
  type: 'issue' | 'epic' | 'bug' | 'task';
  status: string;
  priority: string;
  estimate: number | string | null;
  labels: string[];
  epic: string | null;
  sprint: string | null;
  milestone: string | null;
  assigned: string | null;
  created: string;
  updated: string | null;
  due: string | null;
  blockedBy: string[];
  blocks: string[];
  relatesTo: string[];
  // Body sections
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  technicalNotes: string | null;
  filesToModify: string[];
  activity: string[];
  // Children (for epics)
  children: string[];
  // Progress (for epics)
  progress: string | null;
  // Review gate mode (none = skip review, auto = AI review, required = human review)
  reviewGate: 'none' | 'auto' | 'required';
  // Planned output file path (from front matter output_file, relative to working dir)
  outputFile: string | null;
  // Full markdown body
  body: string;
  // File path relative to .mstro/pm/
  path: string;
}

export interface AcceptanceCriterion {
  text: string;
  checked: boolean;
}

// ============================================================================
// Board (boards/BOARD-N/board.md)
// ============================================================================

export interface Board {
  id: string;
  title: string;
  status: 'draft' | 'active' | 'completed' | 'archived';
  created: string;
  completedAt: string | null;
  goal: string;
  executionSummary: BoardExecutionSummary | null;
  /** Max parallel headless Claude Code instances per execution wave (default: 3) */
  maxParallelAgents: number;
  /** Custom review criteria instructions — replaces default code-review prompt when set */
  reviewCriteria: string;
  path: string;
}

export interface BoardExecutionSummary {
  totalIssues: number;
  completedIssues: number;
  failedIssues: number;
  totalDuration: number;
  waves: number;
}

// ============================================================================
// Workspace (workspace.json)
// ============================================================================

export interface BoardWorktreeEntry {
  path: string;
  branch: string;
}

export interface Workspace {
  activeBoardId: string | null;
  boardOrder: string[];
  boardWorktrees?: Record<string, BoardWorktreeEntry>;
}

// ============================================================================
// Sprint (sprints/*.md) — legacy, kept for migration
// ============================================================================

export interface Sprint {
  id: string;
  title: string;
  status: 'planned' | 'active' | 'completed';
  start: string;
  end: string;
  goal: string;
  capacity: number | null;
  committed: number | null;
  completed: number | null;
  issues: SprintIssueSummary[];
  path: string;
  completedAt: string | null;
  executionSummary: SprintExecutionSummary | null;
}

export interface SprintExecutionSummary {
  totalIssues: number;
  completedIssues: number;
  failedIssues: number;
  totalDuration: number;
  waves: number;
}

export interface SprintIssueSummary {
  id: string;
  title: string;
  path: string;
  points: number | string | null;
  status: string;
}

// ============================================================================
// Milestone (milestones/*.md)
// ============================================================================

export interface Milestone {
  id: string;
  title: string;
  status: 'planned' | 'in_progress' | 'completed' | 'missed';
  targetDate: string | null;
  progress: string | null;
  definition: string;
  epics: MilestoneEpicSummary[];
  path: string;
}

export interface MilestoneEpicSummary {
  id: string;
  title: string;
  path: string;
  progress: string;
}

// ============================================================================
// Review (sprint quality gate)
// ============================================================================

export interface ReviewResult {
  issueId: string;
  issueType: 'code' | 'non-code';
  passed: boolean;
  /** True when the review passed due to infrastructure failure, not genuine quality check */
  autoPass?: boolean;
  checks: ReviewCheck[];
  reviewedAt: string;
}

export interface ReviewCheck {
  name: string;
  passed: boolean;
  details: string;
}

// ============================================================================
// Board Artifacts (board-scoped execution data)
// ============================================================================

export interface BoardArtifacts {
  boardId: string;
  progressLog: string;
  outputFiles: string[];
  reviewResults: ReviewResult[];
  /** Log file names from boards/BOARD-NNN/logs/ (wave execution + review logs) */
  executionLogs: string[];
}

/** @deprecated Use BoardArtifacts — kept for migration compatibility */
export interface SprintArtifacts {
  sprintId: string;
  progressLog: string;
  outputFiles: string[];
  reviewResults: ReviewResult[];
}

// ============================================================================
// Board full state (per-board data sent on board load)
// ============================================================================

export interface BoardFullState {
  board: Board;
  state: ProjectState;
  issues: Issue[];
}

// ============================================================================
// Plan full state (sent on planInit)
// ============================================================================

export interface PlanFullState {
  project: ProjectConfig;
  state: ProjectState;
  boards: Board[];
  workspace: Workspace;
  // Active board's data (loaded eagerly for the focused tab)
  activeBoard: BoardFullState | null;
  // Legacy fields — populated during migration, normally empty
  issues: Issue[];
  sprints: Sprint[];
  milestones: Milestone[];
}
