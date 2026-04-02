// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Plan Executor — Wave-based execution with Claude Code Agent Teams.
 *
 * Orchestrates the execution loop: picks ready issues, executes waves,
 * runs AI review gate, reconciles state, and repeats.
 *
 * Implementation is split across focused modules:
 * - config-installer.ts  — teammate permissions + bouncer MCP install/uninstall
 * - prompt-builder.ts    — Agent Teams coordinator prompt construction
 * - output-manager.ts    — output path resolution, listing, publishing
 * - review-gate.ts       — AI-powered quality gate (review, parse, persist)
 * - front-matter.ts      — YAML front matter field editing utility
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWithFileLogger } from '../../cli/headless/headless-logger.js';
import { HeadlessRunner } from '../../cli/headless/index.js';
import { ConfigInstaller } from './config-installer.js';
import { resolveReadyToWork } from './dependency-resolver.js';
import { replaceFrontMatterField, setFrontMatterField } from './front-matter.js';
import { listExistingDocs, publishOutputs, resolveOutputPath } from './output-manager.js';
import { parseBoardDirectory, parsePlanDirectory, resolvePmDir } from './parser.js';
import { buildCoordinatorPrompt } from './prompt-builder.js';
import { appendReviewFeedback, getReviewAttemptCount, MAX_REVIEW_ATTEMPTS, persistReviewResult, reviewIssue } from './review-gate.js';
import { reconcileState } from './state-reconciler.js';
import type { Issue } from './types.js';

export type ExecutionStatus = 'idle' | 'starting' | 'executing' | 'paused' | 'stopping' | 'complete' | 'error';

/** Max teammates per wave. Agent Teams docs recommend 3-5; beyond 5-6 returns diminish. */
const MAX_WAVE_SIZE = 5;

/** Stop after this many consecutive waves with zero completions. */
const MAX_CONSECUTIVE_EMPTY_WAVES = 3;

/** Wave execution stall timeouts (ms) */
const WAVE_STALL_WARNING_MS = 1_800_000;   // 30 min — Agent Teams leads are silent while teammates work
const WAVE_STALL_KILL_MS = 3_600_000;      // 60 min — waves run longer
const WAVE_STALL_HARD_CAP_MS = 7_200_000;  // 2 hr hard cap
const WAVE_STALL_MAX_EXTENSIONS = 10;

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
  /** Board directory path (e.g. /path/.pm/boards/BOARD-001). Used for outputs, reviews, progress. */
  private boardDir: string | null = null;
  /** Board ID being executed (e.g. "BOARD-001") */
  private boardId: string | null = null;
  private configInstaller: ConfigInstaller;
  /** Flag to prevent start() from clearing scope set by startBoard/startEpic */
  private _scopeSetByCall = false;
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
    this.configInstaller = new ConfigInstaller(workingDir);
  }

  getStatus(): ExecutionStatus { return this.status; }
  getMetrics(): ExecutionMetrics { return { ...this.metrics }; }

  async startEpic(epicPath: string): Promise<void> {
    this.epicScope = epicPath;
    this._scopeSetByCall = true;
    return this.start();
  }

  /** Start execution, optionally scoped to a specific board. */
  async startBoard(boardId: string): Promise<void> {
    this.boardId = boardId;
    this._scopeSetByCall = true;
    return this.start();
  }

  async start(): Promise<void> {
    if (this.status === 'executing' || this.status === 'starting') return;

    this.shouldStop = false;
    this.shouldPause = false;
    // Reset scoping from previous runs unless explicitly set by startBoard/startEpic
    if (!this._scopeSetByCall) {
      this.epicScope = null;
      this.boardId = null;
    }
    this._scopeSetByCall = false;
    this.status = 'starting';
    this.emit('statusChanged', this.status);

    const startTime = Date.now();
    this.status = 'executing';
    this.emit('statusChanged', this.status);

    this.boardDir = this.resolveBoardDir();

    const stallResult = await this.runWaveLoop();

    this.metrics.totalDuration = Date.now() - startTime;

    if (stallResult === 'stalled') {
      this.status = 'error';
      this.emit('error', `Execution stalled: ${MAX_CONSECUTIVE_EMPTY_WAVES} consecutive waves completed zero issues. Issues may be stuck in review or failing repeatedly.`);
    } else if (this.shouldPause) {
      this.status = 'paused';
    } else if (this.shouldStop) {
      this.status = 'idle';
    } else {
      this.status = 'complete';
    }
    this.emit('statusChanged', this.status);
  }

  /** Run waves until done, paused, stopped, or stalled. Returns 'stalled' if zero-completion cap hit. */
  private async runWaveLoop(): Promise<'done' | 'stalled'> {
    let consecutiveZeroCompletions = 0;

    while (!this.shouldStop && !this.shouldPause) {
      const readyIssues = this.pickReadyIssues();
      if (readyIssues.length === 0) break;

      const completedCount = await this.executeWave(readyIssues.slice(0, MAX_WAVE_SIZE));

      if (completedCount > 0) {
        consecutiveZeroCompletions = 0;
        continue;
      }
      consecutiveZeroCompletions++;
      if (consecutiveZeroCompletions >= MAX_CONSECUTIVE_EMPTY_WAVES) return 'stalled';
    }
    return 'done';
  }

  pause(): void { this.shouldPause = true; }
  stop(): void { this.shouldStop = true; }

  resume(): Promise<void> {
    if (this.status !== 'paused') return Promise.resolve();
    this.shouldPause = false;
    // Preserve board/epic scope across resume by marking as a scoped call
    this._scopeSetByCall = true;
    return this.start();
  }

  // ── Wave execution ───────────────────────────────────────────

  private async executeWave(issues: Issue[]): Promise<number> {
    const waveStart = Date.now();
    const waveIds = issues.map(i => i.id);
    const waveLabel = `wave[${waveIds.join(',')}]`;
    this.metrics.currentWaveIds = waveIds;
    this.metrics.issuesAttempted += issues.length;
    this.emit('waveStarted', { issueIds: waveIds });

    this.ensureOutputDirs();
    this.configInstaller.installTeammatePermissions();
    this.configInstaller.installBouncerForSubagents();

    for (const issue of issues) {
      this.updateIssueFrontMatter(issue.path, 'in_progress');
    }

    const existingDocs = listExistingDocs(this.workingDir, this.boardDir);
    const pmDir = resolvePmDir(this.workingDir);
    const prompt = buildCoordinatorPrompt({
      issues,
      workingDir: this.workingDir,
      pmDir,
      boardDir: this.boardDir,
      existingDocs,
      resolveOutputPath: (issue) => resolveOutputPath(issue, this.workingDir, this.boardDir),
    });

    let completedCount = 0;

    try {
      const runner = new HeadlessRunner({
        workingDir: this.workingDir,
        directPrompt: prompt,
        stallWarningMs: WAVE_STALL_WARNING_MS,
        stallKillMs: WAVE_STALL_KILL_MS,
        stallHardCapMs: WAVE_STALL_HARD_CAP_MS,
        stallMaxExtensions: WAVE_STALL_MAX_EXTENSIONS,
        verbose: process.env.MSTRO_VERBOSE === '1',
        disallowedTools: ['TeamCreate', 'TeamDelete', 'TaskCreate', 'TaskUpdate', 'TaskList'],
        extraEnv: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
        outputCallback: (text: string) => {
          this.emit('output', { issueId: waveLabel, text });
        },
      });

      const boardLogDir = this.boardDir ? join(this.boardDir, 'logs') : undefined;
      const result = await runWithFileLogger('pm-execute-wave', () => runner.run(), boardLogDir);

      if (!result.completed || result.error) {
        this.emit('waveError', {
          issueIds: waveIds,
          error: result.error || 'Wave did not complete successfully',
        });
      }

      completedCount = await this.reconcileWaveResults(issues);
    } catch (error) {
      this.emit('waveError', {
        issueIds: waveIds,
        error: error instanceof Error ? error.message : String(error),
      });
      this.revertIncompleteIssues(issues);
    } finally {
      this.configInstaller.uninstallBouncerForSubagents();
      this.configInstaller.uninstallTeammatePermissions();
    }

    this.finalizeWave(issues, waveStart, waveLabel);
    this.metrics.currentWaveIds = [];
    return completedCount;
  }

  /**
   * Post-wave operations wrapped individually so a failure in one
   * doesn't prevent the others or kill the while loop in start().
   */
  private finalizeWave(issues: Issue[], waveStart: number, waveLabel: string): void {
    try {
      reconcileState(this.workingDir, this.boardId ?? undefined);
      this.emit('stateUpdated');
    } catch (err) {
      this.emit('output', {
        issueId: waveLabel,
        text: `Warning: state reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    try {
      publishOutputs(issues, this.workingDir, this.boardDir, {
        onWarning: (issueId, text) => this.emit('output', { issueId, text: `Warning: ${text}` }),
      });
    } catch (err) {
      this.emit('output', {
        issueId: waveLabel,
        text: `Warning: output publishing failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    try {
      this.appendProgressEntry(issues, waveStart);
    } catch (err) {
      this.emit('output', {
        issueId: waveLabel,
        text: `Warning: progress log update failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ── Review gate orchestration ────────────────────────────────

  /**
   * After a wave, check each issue's status on disk and run the AI review gate.
   * Issues that agents marked as `done` are moved to `in_review`, reviewed,
   * and either confirmed `done` (passed) or reverted to `todo` (failed).
   */
  private async reconcileWaveResults(issues: Issue[]): Promise<number> {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return 0;

    let completed = 0;

    for (const issue of issues) {
      const fullPath = join(pmDir, issue.path);
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const statusMatch = content.match(/^status:\s*(\S+)/m);
        const currentStatus = statusMatch?.[1] ?? 'unknown';

        if (currentStatus === 'done') {
          if (issue.reviewGate === 'none') {
            // Skip review gate — accept agent's done status directly
            this.metrics.issuesCompleted++;
            this.emit('issueCompleted', issue);
            completed++;
          } else {
            completed += await this.runReviewGate(issue, pmDir);
          }
        } else {
          this.updateIssueFrontMatter(issue.path, issue.status);
          this.emit('issueError', {
            issueId: issue.id,
            error: 'Issue did not complete during wave execution',
          });
        }
      } catch {
        this.emit('issueError', { issueId: issue.id, error: 'Could not read issue file after wave' });
      }
    }

    return completed;
  }

  /** Run the review gate for a single issue that agents marked as done. Returns 1 if passed, 0 otherwise. */
  private async runReviewGate(issue: Issue, pmDir: string): Promise<number> {
    const reviewDir = this.boardDir ?? pmDir;
    const attempts = getReviewAttemptCount(reviewDir, issue);
    if (attempts >= MAX_REVIEW_ATTEMPTS) {
      this.updateIssueFrontMatter(issue.path, 'in_review');
      this.emit('reviewProgress', { issueId: issue.id, status: 'max_attempts' });
      this.emit('output', { issueId: issue.id, text: 'Review: max attempts reached, keeping in review' });
      return 0;
    }

    this.updateIssueFrontMatter(issue.path, 'in_review');
    this.emit('reviewProgress', { issueId: issue.id, status: 'reviewing' });

    const outputPath = resolveOutputPath(issue, this.workingDir, this.boardDir);
    const result = await reviewIssue({
      workingDir: this.workingDir,
      issue,
      pmDir,
      outputPath,
      onOutput: (text) => this.emit('output', { issueId: issue.id, text }),
      logDir: this.boardDir ? join(this.boardDir, 'logs') : undefined,
    });
    persistReviewResult(reviewDir, issue, result);

    if (result.passed) {
      this.updateIssueFrontMatter(issue.path, 'done');
      this.metrics.issuesCompleted++;
      this.emit('reviewProgress', { issueId: issue.id, status: 'passed' });
      this.emit('issueCompleted', issue);
      return 1;
    }

    this.updateIssueFrontMatter(issue.path, 'todo');
    appendReviewFeedback(pmDir, issue, result);
    this.emit('reviewProgress', { issueId: issue.id, status: 'failed' });
    this.emit('issueError', {
      issueId: issue.id,
      error: `Review failed: ${result.checks.filter(c => !c.passed).map(c => c.name).join(', ')}`,
    });
    return 0;
  }

  // ── Helpers ──────────────────────────────────────────────────

  private pickReadyIssues(): Issue[] {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) {
      this.emit('error', 'No PM directory found');
      return [];
    }

    const effectiveBoardId = this.boardId ?? this.resolveActiveBoardId();
    const issues = effectiveBoardId
      ? this.loadBoardIssues(pmDir, effectiveBoardId)
      : this.loadProjectIssues();

    if (!issues) return [];

    const readyIssues = resolveReadyToWork(issues, this.epicScope ?? undefined);
    if (readyIssues.length === 0) {
      this.emit('complete', this.epicScope ? 'All epic issues are done or blocked' : 'All work is done or blocked');
      if (effectiveBoardId) {
        this.tryCompleteBoardIfDone(pmDir, effectiveBoardId, issues);
      }
    }
    return readyIssues;
  }

  /** Load issues from a specific board, auto-activating draft boards. Returns null on error. */
  private loadBoardIssues(pmDir: string, boardId: string): Issue[] | null {
    const boardState = parseBoardDirectory(pmDir, boardId);
    if (!boardState) {
      this.emit('error', `Board not found: ${boardId}`);
      return null;
    }
    if (boardState.state.paused) {
      this.emit('error', 'Board is paused');
      return null;
    }
    if (boardState.board.status === 'draft') {
      this.activateBoard(pmDir, boardId);
    } else if (boardState.board.status !== 'active') {
      this.emit('error', `Board ${boardId} is not active (status: ${boardState.board.status})`);
      return null;
    }
    return boardState.issues;
  }

  /** Load project-level issues (legacy or no boards). Returns null on error. */
  private loadProjectIssues(): Issue[] | null {
    const fullState = parsePlanDirectory(this.workingDir);
    if (!fullState) {
      this.emit('error', 'No PM directory found');
      return null;
    }
    if (fullState.state.paused) {
      this.emit('error', 'Project is paused');
      return null;
    }
    return fullState.issues;
  }

  /** Activate a draft board by updating its status in board.md. */
  private activateBoard(pmDir: string, boardId: string): void {
    const boardMdPath = join(pmDir, 'boards', boardId, 'board.md');
    if (!existsSync(boardMdPath)) return;
    try {
      const content = readFileSync(boardMdPath, 'utf-8');
      writeFileSync(boardMdPath, replaceFrontMatterField(content, 'status', 'active'), 'utf-8');
    } catch { /* non-fatal — pickReadyIssues will re-check */ }
  }

  /** Check if all issues in a board are done and mark board as completed. */
  private tryCompleteBoardIfDone(pmDir: string, boardId: string, issues: Issue[]): void {
    const allDone = issues.length > 0 && issues.every(i => i.status === 'done' || i.status === 'cancelled');
    if (!allDone) return;

    const boardMdPath = join(pmDir, 'boards', boardId, 'board.md');
    if (!existsSync(boardMdPath)) return;

    try {
      let content = readFileSync(boardMdPath, 'utf-8');
      content = replaceFrontMatterField(content, 'status', 'completed');
      content = replaceFrontMatterField(content, 'completed_at', `"${new Date().toISOString()}"`);
      writeFileSync(boardMdPath, content, 'utf-8');
    } catch { /* non-fatal */ }
  }

  private resolveActiveBoardId(): string | null {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return null;
    try {
      const workspacePath = join(pmDir, 'workspace.json');
      if (!existsSync(workspacePath)) return null;
      const workspace = JSON.parse(readFileSync(workspacePath, 'utf-8'));
      return workspace.activeBoardId ?? null;
    } catch {
      return null;
    }
  }

  private revertIncompleteIssues(issues: Issue[]): void {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return;
    for (const issue of issues) {
      const fullPath = join(pmDir, issue.path);
      try {
        const content = readFileSync(fullPath, 'utf-8');
        if (content.match(/^status:\s*in_progress$/m)) {
          this.updateIssueFrontMatter(issue.path, issue.status);
        }
      } catch { /* file may be gone */ }
    }
  }

  private updateIssueFrontMatter(issuePath: string, newStatus: string): void {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return;
    try {
      setFrontMatterField(join(pmDir, issuePath), 'status', newStatus);
    } catch { /* file may have been moved */ }
  }

  private ensureOutputDirs(): void {
    if (this.boardDir) {
      const boardOutDir = join(this.boardDir, 'out');
      if (!existsSync(boardOutDir)) mkdirSync(boardOutDir, { recursive: true });
    } else {
      const pmDir = resolvePmDir(this.workingDir);
      if (pmDir) {
        const outDir = join(pmDir, 'out');
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      }
    }
  }

  private appendProgressEntry(issues: Issue[], waveStart: number): void {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return;

    // Board-scoped progress log
    const progressPath = this.boardDir
      ? join(this.boardDir, 'progress.md')
      : join(pmDir, 'progress.md');

    const durationMin = Math.round((Date.now() - waveStart) / 60_000);
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);

    const completed: string[] = [];
    const failed: string[] = [];
    for (const issue of issues) {
      try {
        const content = readFileSync(join(pmDir, issue.path), 'utf-8');
        const statusMatch = content.match(/^status:\s*(\S+)/m);
        if (statusMatch?.[1] === 'done') {
          completed.push(issue.id);
        } else {
          failed.push(issue.id);
        }
      } catch {
        failed.push(issue.id);
      }
    }

    const lines = [
      '',
      `## ${timestamp} — Wave [${issues.map(i => i.id).join(', ')}]`,
      '',
      `- **Duration**: ${durationMin} min`,
      `- **Completed**: ${completed.length}/${issues.length}${completed.length > 0 ? ` (${completed.join(', ')})` : ''}`,
    ];
    if (failed.length > 0) {
      lines.push(`- **Failed**: ${failed.join(', ')}`);
    }
    lines.push('');

    this.writeProgressLines(progressPath, lines);
  }

  private writeProgressLines(filePath: string, lines: string[]): void {
    try {
      if (existsSync(filePath)) {
        const existing = readFileSync(filePath, 'utf-8');
        writeFileSync(filePath, `${existing.trimEnd()}\n${lines.join('\n')}`, 'utf-8');
      } else {
        writeFileSync(filePath, `# Board Progress\n${lines.join('\n')}`, 'utf-8');
      }
    } catch { /* non-fatal */ }
  }

  /** Resolve the active board's directory path for outputs, reviews, and progress. */
  private resolveBoardDir(): string | null {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return null;

    const effectiveBoardId = this.boardId ?? this.resolveActiveBoardId();
    if (!effectiveBoardId) return null;

    const boardDir = join(pmDir, 'boards', effectiveBoardId);
    return existsSync(boardDir) ? boardDir : null;
  }
}
