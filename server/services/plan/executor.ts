// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Plan Executor — Wave-based execution with Claude Code Agent Teams.
 *
 * Reads the dependency DAG from .pm/, picks ALL unblocked issues per wave,
 * spawns a coordinator Claude session that uses Agent Teams to execute them
 * in parallel, then reconciles state and repeats for newly-unblocked issues.
 */

import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HeadlessRunner } from '../../cli/headless/index.js';
import { resolveReadyToWork } from './dependency-resolver.js';
import { parsePlanDirectory, resolvePmDir } from './parser.js';
import { reconcileState } from './state-reconciler.js';
import type { Issue } from './types.js';

export type ExecutionStatus = 'idle' | 'starting' | 'executing' | 'paused' | 'stopping' | 'complete' | 'error';

export interface ExecutionMetrics {
  issuesCompleted: number;
  issuesAttempted: number;
  totalDuration: number;
  currentIssueId: string | null;
  /** IDs of issues being executed in the current wave */
  currentWaveIds: string[];
}

export class PlanExecutor extends EventEmitter {
  private status: ExecutionStatus = 'idle';
  private workingDir: string;
  private shouldStop = false;
  private shouldPause = false;
  private epicScope: string | null = null;
  private metrics: ExecutionMetrics = {
    issuesCompleted: 0,
    issuesAttempted: 0,
    totalDuration: 0,
    currentIssueId: null,
    currentWaveIds: [],
  };

  constructor(workingDir: string) {
    super();
    this.workingDir = workingDir;
  }

  getStatus(): ExecutionStatus {
    return this.status;
  }

  getMetrics(): ExecutionMetrics {
    return { ...this.metrics };
  }

  async startEpic(epicPath: string): Promise<void> {
    this.epicScope = epicPath;
    return this.start();
  }

  async start(): Promise<void> {
    if (this.status === 'executing' || this.status === 'starting') return;

    this.shouldStop = false;
    this.shouldPause = false;
    this.status = 'starting';
    this.emit('statusChanged', this.status);

    const startTime = Date.now();

    try {
      this.status = 'executing';
      this.emit('statusChanged', this.status);

      while (!this.shouldStop && !this.shouldPause) {
        const readyIssues = this.pickReadyIssues();
        if (readyIssues.length === 0) break;

        if (readyIssues.length === 1) {
          // Single issue: direct execution (no Agent Teams overhead)
          await this.executeIssue(readyIssues[0]);
        } else {
          // Multiple unblocked issues: wave execution with Agent Teams
          await this.executeWave(readyIssues);
        }
      }
    } catch (error) {
      this.status = 'error';
      this.emit('error', error instanceof Error ? error.message : String(error));
      return;
    }

    this.metrics.totalDuration = Date.now() - startTime;

    if (this.shouldPause) {
      this.status = 'paused';
    } else if (this.shouldStop) {
      this.status = 'idle';
    } else {
      this.status = 'complete';
    }
    this.emit('statusChanged', this.status);
  }

  pause(): void {
    this.shouldPause = true;
  }

  stop(): void {
    this.shouldStop = true;
  }

  resume(): Promise<void> {
    if (this.status !== 'paused') return Promise.resolve();
    this.shouldPause = false;
    return this.start();
  }

  // ── Wave execution (Agent Teams) ──────────────────────────────

  private async executeWave(issues: Issue[]): Promise<void> {
    const waveIds = issues.map(i => i.id);
    this.metrics.currentWaveIds = waveIds;
    this.metrics.issuesAttempted += issues.length;
    this.emit('waveStarted', { issueIds: waveIds });

    // Mark all wave issues as in_progress
    for (const issue of issues) {
      this.updateIssueFrontMatter(issue.path, 'in_progress');
    }

    const prompt = this.buildCoordinatorPrompt(issues);

    try {
      const runner = new HeadlessRunner({
        workingDir: this.workingDir,
        directPrompt: prompt,
        stallKillMs: 3_600_000,  // 60 min — waves run longer
        stallHardCapMs: 7_200_000, // 2 hr hard cap
        outputCallback: (text: string) => {
          this.emit('output', { issueId: `wave[${waveIds.join(',')}]`, text });
        },
      });

      const result = await runner.run();

      if (!result.completed || result.error) {
        this.emit('waveError', {
          issueIds: waveIds,
          error: result.error || 'Wave did not complete successfully',
        });
      }

      // Check which issues the agents actually completed by reading disk
      this.reconcileWaveResults(issues);

    } catch (error) {
      this.emit('waveError', {
        issueIds: waveIds,
        error: error instanceof Error ? error.message : String(error),
      });
      // Revert any issues that weren't completed
      for (const issue of issues) {
        const pmDir = resolvePmDir(this.workingDir);
        if (!pmDir) continue;
        const fullPath = join(pmDir, issue.path);
        try {
          const content = readFileSync(fullPath, 'utf-8');
          if (content.match(/^status:\s*in_progress$/m)) {
            this.updateIssueFrontMatter(issue.path, issue.status);
          }
        } catch { /* file may be gone */ }
      }
    }

    // Reconcile STATE.md after wave
    reconcileState(this.workingDir);
    this.emit('stateUpdated');
    this.metrics.currentWaveIds = [];
  }

  /**
   * After a wave, check each issue's status on disk.
   * The coordinator agent is instructed to mark issues as done via front matter,
   * so we trust the disk state and update metrics accordingly.
   */
  private reconcileWaveResults(issues: Issue[]): void {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return;

    for (const issue of issues) {
      const fullPath = join(pmDir, issue.path);
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const statusMatch = content.match(/^status:\s*(\S+)/m);
        const currentStatus = statusMatch?.[1] ?? 'unknown';

        if (currentStatus === 'done') {
          this.metrics.issuesCompleted++;
          this.emit('issueCompleted', issue);
        } else if (currentStatus === 'in_progress') {
          // Agent didn't finish — check if output doc exists (partial completion)
          const outputDoc = this.findOutputDoc(issue.id);
          if (outputDoc) {
            // Output was written but status not updated — mark done
            this.updateIssueFrontMatter(issue.path, 'done');
            this.metrics.issuesCompleted++;
            this.emit('issueCompleted', issue);
          } else {
            // Genuinely incomplete — revert to prior status
            this.updateIssueFrontMatter(issue.path, issue.status);
            this.emit('issueError', {
              issueId: issue.id,
              error: 'Issue did not complete during wave execution',
            });
          }
        }
      } catch {
        // File read error — treat as incomplete
        this.emit('issueError', { issueId: issue.id, error: 'Could not read issue file after wave' });
      }
    }
  }

  /**
   * Look for an output document matching an issue ID in .pm/docs/.
   */
  private findOutputDoc(issueId: string): string | null {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return null;
    const docsDir = join(pmDir, 'docs');
    if (!existsSync(docsDir)) return null;

    try {
      const files = readdirSync(docsDir);
      const prefix = issueId.toLowerCase();
      const match = files.find(f => f.toLowerCase().startsWith(prefix) && f.endsWith('.md'));
      return match ? join(docsDir, match) : null;
    } catch {
      return null;
    }
  }

  // ── Single issue execution (fallback for wave size 1) ─────────

  private async executeIssue(issue: Issue): Promise<void> {
    this.metrics.currentIssueId = issue.id;
    this.metrics.issuesAttempted++;
    this.emit('issueStarted', issue);

    this.updateIssueFrontMatter(issue.path, 'in_progress');

    const prompt = this.buildIssuePrompt(issue);

    try {
      const runner = new HeadlessRunner({
        workingDir: this.workingDir,
        directPrompt: prompt,
        outputCallback: (text: string) => {
          this.emit('output', { issueId: issue.id, text });
        },
      });

      const result = await runner.run();

      if (!result.completed || result.error) {
        this.emit('issueError', { issueId: issue.id, error: result.error || 'Issue did not complete successfully' });
      } else {
        this.updateIssueFrontMatter(issue.path, 'done');
        this.metrics.issuesCompleted++;
        this.emit('issueCompleted', issue);
      }

      reconcileState(this.workingDir);
      this.emit('stateUpdated');
    } catch (error) {
      this.emit('issueError', {
        issueId: issue.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.updateIssueFrontMatter(issue.path, issue.status);
    }

    this.metrics.currentIssueId = null;
  }

  // ── Issue picking ─────────────────────────────────────────────

  private pickReadyIssues(): Issue[] {
    const fullState = parsePlanDirectory(this.workingDir);
    if (!fullState) {
      this.emit('error', 'No .pm/ directory found');
      return [];
    }
    if (fullState.state.paused) {
      this.emit('error', 'Project is paused');
      return [];
    }
    const readyIssues = resolveReadyToWork(fullState.issues, this.epicScope ?? undefined);
    if (readyIssues.length === 0) {
      this.emit('complete', this.epicScope ? 'All epic issues are done or blocked' : 'All work is done or blocked');
    }
    return readyIssues;
  }

  // ── Prompt building ───────────────────────────────────────────

  /**
   * Build the coordinator prompt for a wave of parallel issues.
   * Instructs the Claude session to use Agent tool for parallel execution.
   */
  private buildCoordinatorPrompt(issues: Issue[]): string {
    const pmDir = resolvePmDir(this.workingDir);
    const docsDir = pmDir ? join(pmDir, 'docs') : '.pm/docs';

    // Collect existing output docs that issues may need as input
    const existingDocs = this.listExistingDocs();

    const issueBlocks = issues.map(issue => {
      const criteria = issue.acceptanceCriteria
        .map(c => `- [${c.checked ? 'x' : ' '}] ${c.text}`)
        .join('\n');

      const files = issue.filesToModify.length > 0
        ? `\nFiles to modify:\n${issue.filesToModify.map(f => `- ${f}`).join('\n')}`
        : '';

      // Find predecessor output docs this issue should read
      const predecessorDocs = issue.blockedBy
        .map(bp => {
          const blockerId = bp.replace(/^backlog\//, '').replace(/\.md$/, '');
          return existingDocs.find(d => d.toLowerCase().includes(blockerId.toLowerCase()));
        })
        .filter(Boolean) as string[];

      const predecessorSection = predecessorDocs.length > 0
        ? `\nPredecessor outputs to read:\n${predecessorDocs.map(d => `- ${d}`).join('\n')}`
        : '';

      return `### ${issue.id}: ${issue.title}

**Type**: ${issue.type} | **Priority**: ${issue.priority} | **Estimate**: ${issue.estimate ?? 'unestimated'}

**Description**:
${issue.description}

**Acceptance Criteria**:
${criteria || 'No specific criteria defined.'}

**Technical Notes**:
${issue.technicalNotes || 'None'}
${files}${predecessorSection}

**Output file**: ${docsDir}/${issue.id}-${this.slugify(issue.title)}.md`;
    }).join('\n\n---\n\n');

    return `You are a coordinator executing ${issues.length} issues in parallel using Agent Teams.

## Project Directory
Working directory: ${this.workingDir}
Plan directory: ${pmDir || '.pm/'}

## Issues to Execute in Parallel

${issueBlocks}

## Execution Protocol

1. **Launch all ${issues.length} issues in parallel** using the Agent tool. Send a single message with ${issues.length} Agent tool calls — one per issue. Each agent should:
   - Read the issue spec from the .pm/backlog/ file for full context
   - Read any predecessor output docs listed above before starting work
   - Execute the work described in the issue
   - **CRITICAL: Write all output/results to the output file path specified above** using the Write tool. This file MUST exist on disk when the agent finishes — it is the handoff artifact for downstream issues.
   - Update the issue's front matter status from \`in_progress\` to \`done\` via Edit tool

2. **After all agents complete**, verify:
   - Each output file exists in ${docsDir}/
   - Each issue's status in .pm/backlog/ is \`done\`
   - If any agent failed to write its output or mark done, do it yourself

3. **Do NOT modify STATE.md** — the orchestrator handles state reconciliation.

## Agent Prompt Template

For each Agent tool call, use this structure:
- Set \`description\` to the issue ID and short title
- In the \`prompt\`, include the full issue description, acceptance criteria, predecessor docs to read, and the output file path

## Critical Rules

- Each agent MUST write its output to disk before finishing. Research that only exists in conversation context is LOST.
- Each agent MUST update the issue front matter status to \`done\` when complete.
- Keep agents focused — one issue per agent, no cross-issue work.
- Do not modify files outside the issue's scope.`;
  }

  private buildIssuePrompt(issue: Issue): string {
    const pmDir = resolvePmDir(this.workingDir);
    const docsDir = pmDir ? join(pmDir, 'docs') : '.pm/docs';
    const existingDocs = this.listExistingDocs();

    const criteria = issue.acceptanceCriteria
      .map(c => `- [${c.checked ? 'x' : ' '}] ${c.text}`)
      .join('\n');

    const files = issue.filesToModify.length > 0
      ? `\nFiles to modify:\n${issue.filesToModify.map(f => `- ${f}`).join('\n')}`
      : '';

    // Find predecessor output docs
    const predecessorDocs = issue.blockedBy
      .map(bp => {
        const blockerId = bp.replace(/^backlog\//, '').replace(/\.md$/, '');
        return existingDocs.find(d => d.toLowerCase().includes(blockerId.toLowerCase()));
      })
      .filter(Boolean) as string[];

    const predecessorSection = predecessorDocs.length > 0
      ? `\n## Predecessor Outputs\nRead these files before starting — they contain work from completed upstream issues:\n${predecessorDocs.map(d => `- ${d}`).join('\n')}\n`
      : '';

    const outputFile = `${docsDir}/${issue.id}-${this.slugify(issue.title)}.md`;

    return `Work on this issue:

# ${issue.id}: ${issue.title}

## Description
${issue.description}

## Acceptance Criteria
${criteria || 'No specific criteria defined.'}

## Technical Notes
${issue.technicalNotes || 'None'}
${files}
${predecessorSection}
## Output Persistence

**CRITICAL**: Write all output, research findings, or implementation results to:
\`${outputFile}\`

This file is the handoff artifact for downstream issues that depend on this work.
Do NOT leave results only in conversation — they MUST be written to disk.

After writing the output file, update the issue front matter:
- File: ${pmDir ? join(pmDir, issue.path) : issue.path}
- Change \`status: in_progress\` to \`status: done\`

## Instructions
- Implement all acceptance criteria
- Run tests after making changes (if applicable)
- Keep changes minimal and focused
- Do not modify unrelated code
- Write output to the file path above before finishing`;
  }

  // ── Helpers ───────────────────────────────────────────────────

  private listExistingDocs(): string[] {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return [];
    const docsDir = join(pmDir, 'docs');
    if (!existsSync(docsDir)) return [];

    try {
      return readdirSync(docsDir, { recursive: true })
        .filter((f): f is string => typeof f === 'string' && f.endsWith('.md'))
        .map(f => join(docsDir, f));
    } catch {
      return [];
    }
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  private updateIssueFrontMatter(issuePath: string, newStatus: string): void {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return;
    const fullPath = join(pmDir, issuePath);
    try {
      let content = readFileSync(fullPath, 'utf-8');
      content = content.replace(/^(status:\s*).+$/m, `$1${newStatus}`);
      writeFileSync(fullPath, content, 'utf-8');
    } catch {
      // Ignore errors — file may have been moved
    }
  }
}
