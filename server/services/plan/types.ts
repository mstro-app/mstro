// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Plan Types — Project Plan Spec (PPS) data structures
 *
 * These types represent the parsed contents of .pm/ directory files.
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
  category: 'unstarted' | 'started' | 'completed' | 'cancelled';
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
  // Full markdown body
  body: string;
  // File path relative to .pm/
  path: string;
}

export interface AcceptanceCriterion {
  text: string;
  checked: boolean;
}

// ============================================================================
// Sprint (sprints/*.md)
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
// Plan full state (sent on planInit)
// ============================================================================

export interface PlanFullState {
  project: ProjectConfig;
  state: ProjectState;
  issues: Issue[];
  sprints: Sprint[];
  milestones: Milestone[];
}
