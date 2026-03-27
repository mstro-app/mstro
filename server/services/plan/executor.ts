// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Plan Executor — Runs the PPS execution loop.
 *
 * Reads STATE.md from .pm/ (or legacy .plan/), picks the highest-priority
 * unblocked issue, spawns a coding agent for it, updates state on completion, and loops.
 */

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
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
        const issue = this.pickNextIssue();
        if (!issue) break;
        await this.executeIssue(issue);
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

  private pickNextIssue(): Issue | null {
    const fullState = parsePlanDirectory(this.workingDir);
    if (!fullState) {
      this.emit('error', 'No .pm/ directory found');
      return null;
    }
    if (fullState.state.paused) {
      this.emit('error', 'Project is paused');
      return null;
    }
    const readyIssues = resolveReadyToWork(fullState.issues, this.epicScope ?? undefined);
    if (readyIssues.length === 0) {
      this.emit('complete', this.epicScope ? 'All epic issues are done or blocked' : 'All work is done or blocked');
      return null;
    }
    return readyIssues[0];
  }

  private async executeIssue(issue: Issue): Promise<void> {
    this.metrics.currentIssueId = issue.id;
    this.metrics.issuesAttempted++;
    this.emit('issueStarted', issue);

    // Update issue status to in_progress
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
        // Mark issue as done
        this.updateIssueFrontMatter(issue.path, 'done');
        this.metrics.issuesCompleted++;
        this.emit('issueCompleted', issue);
      }

      // Reconcile STATE.md
      reconcileState(this.workingDir);
      this.emit('stateUpdated');
    } catch (error) {
      this.emit('issueError', {
        issueId: issue.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Revert issue status
      this.updateIssueFrontMatter(issue.path, issue.status);
    }

    this.metrics.currentIssueId = null;
  }

  private buildIssuePrompt(issue: Issue): string {
    const criteria = issue.acceptanceCriteria
      .map(c => `- [${c.checked ? 'x' : ' '}] ${c.text}`)
      .join('\n');

    const files = issue.filesToModify.length > 0
      ? `\nFiles to modify:\n${issue.filesToModify.map(f => `- ${f}`).join('\n')}`
      : '';

    return `Work on this issue:

# ${issue.id}: ${issue.title}

## Description
${issue.description}

## Acceptance Criteria
${criteria || 'No specific criteria defined.'}

## Technical Notes
${issue.technicalNotes || 'None'}
${files}

Instructions:
- Implement all acceptance criteria
- Run tests after making changes
- Keep changes minimal and focused
- Do not modify unrelated code`;
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
