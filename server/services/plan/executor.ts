// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Plan Executor — Wave-based execution with parallel headless Claude Code instances.
 *
 * Orchestrates the execution loop: picks ready issues, executes waves of
 * parallel headless runners (one per issue), runs AI review gate,
 * reconciles state, and repeats.
 *
 * Implementation is split across focused modules:
 * - board-config.ts          — board.md metadata reads, workspace.json active board resolution
 * - config-installer.ts      — tool permissions install/uninstall
 * - issue-prompt-builder.ts  — per-issue prompt construction
 * - issue-writer.ts          — issue front-matter updates, recovery, revert, cancellation notes
 * - output-manager.ts        — output path resolution, listing, publishing
 * - progress-log.ts          — progress.md writer + output dir creation
 * - review-gate.ts           — AI-powered quality gate (review, parse, persist, full pipeline)
 */

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runWithFileLogger } from '../../cli/headless/headless-logger.js';
import {
  DEFAULT_MAX_PARALLEL_AGENTS,
  getBoardMaxParallelAgents,
  resolveActiveBoardId,
  resolveBoardDir,
  tryCompleteBoardIfDone,
} from './board-config.js';
import { ConfigInstaller } from './config-installer.js';
import { resolveReadyToWork } from './dependency-resolver.js';
import { loadBoardIssues, loadProjectIssues } from './issue-loader.js';
import { buildIssuePrompt } from './issue-prompt-builder.js';
import { runIssueWithRetry } from './issue-retry.js';
import {
  extractIssueStatus,
  recoverStaleIssues,
  revertIncompleteIssues,
  updateIssueFrontMatter,
  validateIssuePath,
  type WarnFn,
} from './issue-writer.js';
import { listExistingDocs, publishOutputs, resolveOutputPath } from './output-manager.js';
import { resolvePmDir } from './parser.js';
import { appendProgressEntry, ensureOutputDirs } from './progress-log.js';
import { buildCompletionReason, detectDeadState, hasBlockedIssues } from './readiness-planner.js';
import { runReviewPipeline } from './review-gate.js';
import { reconcileState } from './state-reconciler.js';
import type { Issue } from './types.js';

export type ExecutionStatus = 'idle' | 'starting' | 'executing' | 'paused' | 'stopping' | 'complete' | 'error';

/** Stop after this many consecutive waves with zero completions. */
const MAX_CONSECUTIVE_EMPTY_WAVES = 3;

/**
 * Render a tool-call event as a short single-line label for the verbose
 * Output stream — `Read · package.json`, `Bash · npm test`, etc. The web UI
 * splits the label on the first ` · ` to render the tool name as a badge.
 */
function formatToolCallLine(toolName: string, input: Record<string, unknown> | undefined): string {
  const arg = pickPrimaryArg(toolName, input);
  return arg ? `${toolName} · ${arg}` : toolName;
}

function pickPrimaryArg(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  // Map common Claude Code tools to their most informative single argument.
  const candidates: Record<string, string[]> = {
    Read: ['file_path'],
    Write: ['file_path'],
    Edit: ['file_path'],
    Glob: ['pattern'],
    Grep: ['pattern'],
    Bash: ['command'],
    WebFetch: ['url'],
    WebSearch: ['query'],
    Task: ['description'],
  };
  const keys = candidates[toolName] ?? ['command', 'file_path', 'path', 'pattern', 'url', 'query'];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }
  }
  return '';
}

/** Per-issue stall timeouts (ms) — shorter than Agent Teams wave timeouts */
const ISSUE_STALL_WARNING_MS = 900_000;    // 15 min
const ISSUE_STALL_KILL_MS = 1_800_000;     // 30 min
const ISSUE_STALL_HARD_CAP_MS = 14_400_000; // 4 hr backstop — only fires after stall signals flag the run
const ISSUE_STALL_MAX_EXTENSIONS = 10;

export interface ExecutionMetrics {
  issuesCompleted: number;
  issuesAttempted: number;
  totalDuration: number;
  currentIssueId: string | null;
  /** IDs of issues being executed in the current wave */
  currentWaveIds: string[];
}

/** Scope options for a single run. Passed to start(), startBoard(), startEpic(). */
export interface StartOptions {
  /** Epic file path — restricts execution to issues under that epic. */
  epic?: string;
  /** Board ID to execute (e.g. "BOARD-001"). */
  board?: string;
  /** Optional worktree directory for running agents. PM data is always read from workingDir. */
  executionDir?: string;
}

/**
 * Immutable per-run context resolved when a run starts. Groups paths, scope,
 * and environment so helper methods can read them in one place rather than
 * reaching for scattered fields on the executor.
 */
interface PlanExecutionContext {
  readonly workingDir: string;
  readonly extraEnv?: Record<string, string>;
  readonly epicScope: string | null;
  readonly boardId: string | null;
  readonly executionDir: string | null;
  readonly pmDir: string | null;
  readonly boardDir: string | null;
}

export class PlanExecutor extends EventEmitter {
  private status: ExecutionStatus = 'idle';
  private readonly workingDir: string;
  private readonly extraEnv?: Record<string, string>;
  private shouldStop = false;
  private shouldPause = false;
  /** AbortController for killing running HeadlessRunner processes on stop. */
  private waveAbortController: AbortController | null = null;
  /** Resolved context for the current/last run — rebuilt each runStart(). */
  private context: PlanExecutionContext;
  /** Options from the last run; replayed on resume() to preserve scope. */
  private lastStartOptions: StartOptions = {};
  private configInstaller: ConfigInstaller;
  private metrics: ExecutionMetrics = {
    issuesCompleted: 0,
    issuesAttempted: 0,
    totalDuration: 0,
    currentIssueId: null,
    currentWaveIds: [],
  };

  constructor(workingDir: string, options?: { extraEnv?: Record<string, string> }) {
    super();
    this.workingDir = workingDir;
    this.extraEnv = options?.extraEnv;
    this.configInstaller = new ConfigInstaller(workingDir);
    this.context = this.buildContext({});
  }

  getStatus(): ExecutionStatus { return this.status; }
  getMetrics(): ExecutionMetrics { return { ...this.metrics }; }

  startEpic(epicPath: string): Promise<void> {
    return this.runStart({ epic: epicPath });
  }

  /** Start execution, optionally scoped to a specific board. */
  startBoard(boardId: string, executionDir?: string): Promise<void> {
    return this.runStart({ board: boardId, executionDir });
  }

  start(options: StartOptions = {}): Promise<void> {
    return this.runStart(options);
  }

  pause(): void { this.shouldPause = true; }

  stop(): void {
    this.shouldStop = true;
    this.status = 'stopping';
    this.emit('statusChanged', this.status);
    // Kill all running HeadlessRunner processes in the current wave
    this.waveAbortController?.abort();
  }

  resume(): Promise<void> {
    if (this.status !== 'paused') return Promise.resolve();
    this.shouldPause = false;
    // Replay the options from the previous run to preserve epic/board scope.
    return this.runStart(this.lastStartOptions);
  }

  // ── Run orchestration ────────────────────────────────────────

  private async runStart(options: StartOptions): Promise<void> {
    if (this.status === 'executing' || this.status === 'starting') return;

    this.lastStartOptions = options;
    this.shouldStop = false;
    this.shouldPause = false;
    this.status = 'starting';
    this.emit('statusChanged', this.status);

    this.context = this.buildContext(options);

    const startTime = Date.now();
    this.status = 'executing';
    this.emit('statusChanged', this.status);

    await this.runStaleRecovery();
    const stallResult = await this.runWaveLoop();

    this.metrics.totalDuration = Date.now() - startTime;

    if (stallResult === 'stalled' || stallResult === 'dead') {
      this.status = 'error';
      if (stallResult === 'stalled') {
        this.emit('error', `Execution stalled: ${MAX_CONSECUTIVE_EMPTY_WAVES} consecutive waves completed zero issues. Issues may be stuck in review or failing repeatedly.`);
      }
    } else if (this.shouldPause) {
      this.status = 'paused';
    } else if (this.shouldStop) {
      this.status = 'idle';
      // Emit complete so clients can transition out of 'stopping' — metrics are broadcast by the handler.
      this.emit('complete', 'Stopped by user');
    } else {
      this.status = 'complete';
    }
    this.emit('statusChanged', this.status);
  }

  /** Build an immutable execution context from start options. */
  private buildContext(options: StartOptions): PlanExecutionContext {
    const pmDir = resolvePmDir(this.workingDir);
    const boardId = options.board ?? null;
    return {
      workingDir: this.workingDir,
      extraEnv: this.extraEnv,
      epicScope: options.epic ?? null,
      boardId,
      executionDir: options.executionDir ?? null,
      pmDir,
      boardDir: resolveBoardDir(pmDir, boardId),
    };
  }

  // ── Warning / update helpers bound to the executor's event stream ──

  /**
   * Forward module-emitted warnings as executor 'output' events so they flow
   * through to the WebSocket broadcast like inline warnings always have.
   */
  private emitWarn: WarnFn = (message, issueId) => {
    this.emit('output', { issueId: issueId ?? 'system', text: message, boardId: this.context.boardId ?? null });
  };

  private async setIssueStatus(issuePath: string, newStatus: string): Promise<void> {
    const { pmDir } = this.context;
    if (!pmDir) return;
    await updateIssueFrontMatter(pmDir, issuePath, newStatus, this.emitWarn);
  }

  // ── Wave loop ────────────────────────────────────────────────

  /** Run waves until done, paused, stopped, or stalled. */
  private async runWaveLoop(): Promise<'done' | 'stalled' | 'dead'> {
    let consecutiveZeroCompletions = 0;
    const maxParallel = await getBoardMaxParallelAgents(this.context.pmDir, this.effectiveBoardId(), this.emitWarn);

    while (!this.shouldStop && !this.shouldPause) {
      const readyIssues = await this.pickReadyIssues();
      if (readyIssues.length === 0) {
        // pickReadyIssues emits 'error' for dead state, 'complete' otherwise — check if dead
        return await this.hasDeadIssues() ? 'dead' : 'done';
      }

      const completedCount = await this.executeWave(readyIssues.slice(0, maxParallel));

      if (completedCount > 0) {
        consecutiveZeroCompletions = 0;
        continue;
      }
      consecutiveZeroCompletions++;
      if (consecutiveZeroCompletions >= MAX_CONSECUTIVE_EMPTY_WAVES) return 'stalled';
    }
    return 'done';
  }

  private effectiveBoardId(): string | null {
    return this.context.boardId ?? resolveActiveBoardId(this.context.pmDir);
  }

  private async hasDeadIssues(): Promise<boolean> {
    const { pmDir } = this.context;
    if (!pmDir) return false;
    const { issues } = await this.loadScopedIssues(pmDir);
    return issues ? hasBlockedIssues(issues) : false;
  }

  // ── Wave execution ───────────────────────────────────────────

  private async executeWave(issues: Issue[]): Promise<number> {
    const waveStart = Date.now();
    const waveIds = issues.map(i => i.id);
    const waveLabel = `wave[${waveIds.join(',')}]`;
    this.metrics.currentWaveIds = waveIds;
    this.metrics.issuesAttempted += issues.length;
    this.emit('waveStarted', { issueIds: waveIds });

    // Create abort controller for this wave — stop() will abort it
    this.waveAbortController = new AbortController();

    await ensureOutputDirs(this.context.pmDir, this.context.boardDir);
    this.configInstaller.installPermissions();

    for (const issue of issues) {
      await this.setIssueStatus(issue.path, 'in_progress');
    }

    const existingDocs = listExistingDocs(this.workingDir, this.context.boardDir);
    const { pmDir } = this.context;

    let completedCount = 0;

    try {
      // Spawn one HeadlessRunner per issue in parallel
      const abortSignal = this.waveAbortController?.signal;
      const runnerPromises = issues.map(issue => this.runSingleIssue(issue, pmDir, existingDocs, waveLabel, abortSignal));
      const results = await Promise.allSettled(runnerPromises);

      // Log any rejected promises
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'rejected') {
          this.emit('issueError', {
            issueId: issues[i].id,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }

      completedCount = await this.reconcileWaveResults(issues);
    } catch (error) {
      this.emit('waveError', {
        issueIds: waveIds,
        error: error instanceof Error ? error.message : String(error),
      });
      if (pmDir) await revertIncompleteIssues(pmDir, issues, this.emitWarn);
    } finally {
      this.configInstaller.uninstallPermissions();
    }

    this.waveAbortController = null;
    await this.finalizeWave(issues, waveStart, waveLabel);
    this.metrics.currentWaveIds = [];
    return completedCount;
  }

  /** Run a single issue via its own headless Claude Code instance with retry logic. */
  private async runSingleIssue(
    issue: Issue,
    pmDir: string | null,
    existingDocs: string[],
    waveLabel: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const { executionDir, boardDir, workingDir } = this.context;
    const effectiveDir = executionDir || workingDir;
    const outputPath = resolveOutputPath(issue, workingDir, boardDir);
    const prompt = buildIssuePrompt({
      issue,
      workingDir: effectiveDir,
      pmDir,
      boardDir,
      existingDocs,
      outputPath,
    });

    const boardLogDir = boardDir ? join(boardDir, 'logs') : undefined;
    const emitOutput = (text: string) => this.emit('output', { issueId: issue.id, text });
    const result = await runWithFileLogger(`pm-issue-${issue.id}`, () => runIssueWithRetry({
      workingDir: effectiveDir,
      prompt,
      stallWarningMs: ISSUE_STALL_WARNING_MS,
      stallKillMs: ISSUE_STALL_KILL_MS,
      stallHardCapMs: ISSUE_STALL_HARD_CAP_MS,
      stallMaxExtensions: ISSUE_STALL_MAX_EXTENSIONS,
      outputCallback: emitOutput,
      // Thinking deltas: marker-prefix so the web UI can classify them as a
      // separate verbose-only block type without needing a new message field.
      thinkingCallback: (text: string) => emitOutput(`[[MSTRO_THINKING]]${text}`),
      // Tool calls: emit a single line per completed tool with a short arg
      // summary. The 'tool_complete' event fires after input has fully
      // streamed in, so we can render the tool with its real arguments.
      toolUseCallback: (event) => {
        if (event.type !== 'tool_complete' || !event.toolName) return;
        emitOutput(`[[MSTRO_TOOL]]${formatToolCallLine(event.toolName, event.completeInput)}`);
      },
      extraEnv: this.extraEnv,
      abortSignal,
    }), boardLogDir);

    if (!result.completed || result.error) {
      this.emit('output', { issueId: waveLabel, text: `Issue ${issue.id}: ${result.error || 'did not complete'}` });
    }
  }

  /**
   * Post-wave operations wrapped individually so a failure in one
   * doesn't prevent the others or kill the while loop in start().
   */
  private async finalizeWave(issues: Issue[], waveStart: number, waveLabel: string): Promise<void> {
    const { pmDir, boardDir, boardId } = this.context;

    try {
      reconcileState(this.workingDir, boardId ?? undefined);
      this.emit('stateUpdated');
    } catch (err) {
      this.emit('output', {
        issueId: waveLabel,
        text: `Warning: state reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    try {
      publishOutputs(issues, this.workingDir, boardDir, {
        onWarning: (issueId, text) => this.emit('output', { issueId, text: `Warning: ${text}` }),
      });
    } catch (err) {
      this.emit('output', {
        issueId: waveLabel,
        text: `Warning: output publishing failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    try {
      await appendProgressEntry(pmDir, boardDir, issues, waveStart, this.emitWarn);
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
    const { pmDir } = this.context;
    if (!pmDir) return 0;

    let completed = 0;

    for (const issue of issues) {
      const fullPath = validateIssuePath(issue.path, pmDir);
      try {
        const content = await readFile(fullPath, 'utf-8');
        const currentStatus = extractIssueStatus(content) ?? 'unknown';

        if (currentStatus === 'in_review' || currentStatus === 'done') {
          if (await this.finalizeCompletedIssue(issue, pmDir)) completed++;
        } else {
          await this.setIssueStatus(issue.path, issue.status);
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

  /**
   * Finalize a single issue whose status reached `in_review`/`done`. Runs the
   * review pipeline unless the issue opted out via `reviewGate: 'none'`.
   * Returns true when the issue is confirmed done (counted toward completions).
   */
  private async finalizeCompletedIssue(issue: Issue, pmDir: string): Promise<boolean> {
    if (issue.reviewGate === 'none') {
      await this.setIssueStatus(issue.path, 'done');
      this.metrics.issuesCompleted++;
      this.emit('issueCompleted', issue);
      return true;
    }

    const passed = await runReviewPipeline(
      {
        issue,
        pmDir,
        workingDir: this.workingDir,
        executionDir: this.context.executionDir,
        boardDir: this.context.boardDir,
        boardId: this.context.boardId,
        extraEnv: this.extraEnv,
      },
      {
        setStatus: (path, status) => this.setIssueStatus(path, status),
        onOutput: (issueId, text) => this.emit('output', { issueId, text }),
        onReviewProgress: (issueId, status) => this.emit('reviewProgress', { issueId, status }),
        onIssueAbandoned: (issueId, reason, attempts) => this.emit('issueAbandoned', { issueId, reason, attempts }),
        onIssueCompleted: (completedIssue) => this.emit('issueCompleted', completedIssue),
        onIssueError: (issueId, error) => this.emit('issueError', { issueId, error }),
        warn: this.emitWarn,
      },
    );
    if (passed) this.metrics.issuesCompleted++;
    return passed;
  }

  // ── Recovery ─────────────────────────────────────────────────

  /**
   * Recover from a previous interrupted execution by reverting stale
   * `in_progress` and `in_review` issues back to `todo`. Without this,
   * these issues block the dependency graph and cause the executor to
   * find zero ready issues, making "Implement" appear to do nothing.
   */
  private async runStaleRecovery(): Promise<void> {
    const { pmDir } = this.context;
    if (!pmDir) return;

    const { issues } = await this.loadScopedIssues(pmDir);
    if (!issues) return;

    const recovered = await recoverStaleIssues(pmDir, issues, this.emitWarn);
    if (recovered.length > 0) {
      this.emit('output', {
        issueId: 'recovery',
        text: `Recovered ${recovered.length} issue${recovered.length > 1 ? 's' : ''} from previous interrupted execution: ${recovered.join(', ')}`,
      });
      this.emit('stateUpdated');
    }
  }

  // ── Issue loading & readiness ────────────────────────────────

  private async pickReadyIssues(): Promise<Issue[]> {
    const { pmDir, epicScope } = this.context;
    if (!pmDir) {
      this.emit('error', 'No PM directory found');
      return [];
    }

    const { issues, boardId } = await this.loadScopedIssues(pmDir);
    if (!issues) return [];

    const readyIssues = resolveReadyToWork(issues, epicScope ?? undefined);
    if (readyIssues.length === 0) {
      const deadState = detectDeadState(issues);
      if (deadState) {
        this.emit('error', deadState);
      } else {
        this.emit('complete', buildCompletionReason(issues, epicScope));
        if (boardId) {
          await tryCompleteBoardIfDone(pmDir, boardId, issues, this.emitWarn);
        }
      }
    }
    return readyIssues;
  }

  /**
   * Load issues for the active execution scope. Returns the resolved boardId
   * alongside the issues so callers can branch on board-specific logic without
   * re-resolving the scope.
   */
  private async loadScopedIssues(pmDir: string): Promise<{ issues: Issue[] | null; boardId: string | null }> {
    const boardId = this.effectiveBoardId();
    const issues = boardId
      ? await loadBoardIssues(pmDir, boardId, {
          onError: msg => this.emit('error', msg),
          warn: this.emitWarn,
        })
      : loadProjectIssues(this.workingDir, { onError: msg => this.emit('error', msg) });
    return { issues, boardId };
  }
}

// Re-export for backwards compatibility with modules that imported the constant from here.
export { DEFAULT_MAX_PARALLEL_AGENTS };
