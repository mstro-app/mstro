// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Board Execution Handler
 *
 * Handles PM Board execution requests from a developer's backend on behalf
 * of end users. Each execution is isolated — no shared context between
 * end users.
 *
 * Flow:
 * 1. Validate boardTemplateId against deployment's allowedBoardTemplateIds
 * 2. Load the referenced board template from .mstro/pm/boards/
 * 3. Create an isolated working directory (git worktree)
 * 4. Use headless Claude Code to customize the board from end-user prompt
 * 5. Trigger PM Board "implement all" execution via PlanExecutor
 * 6. Collect results and return them
 *
 * Board executions are long-running — returns a job ID immediately with
 * polling for status and results.
 *
 * Security: End-user prompts are untrusted input. They are always passed
 * as user messages, never injected into system instructions.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeadlessRunner } from '../../cli/headless/runner.js';
import { PlanExecutor } from '../plan/executor.js';
import { parseBoardDirectory, resolvePmDir } from '../plan/parser.js';
import { readOwnerApiCredential } from './deploy-ai-service.js';

// ========== Prompt Sanitization ==========

/**
 * Maximum allowed length for an end-user prompt.
 * Prevents memory abuse and ensures reasonable prompt sizes.
 */
const MAX_END_USER_PROMPT_LENGTH = 100_000;

/**
 * Sanitize an end-user prompt before passing it to the AI.
 *
 * SECURITY: End-user prompts are untrusted. This function:
 * 1. Strips system instruction XML delimiters to prevent prompt escape
 * 2. Removes null bytes and zero-width characters used for evasion
 * 3. Truncates to MAX_END_USER_PROMPT_LENGTH
 *
 * Note: This does NOT strip tool-use instructions or path traversal text —
 * those are handled by the Security Bouncer (tool execution level) and
 * the isolated working directory (filesystem level).
 */
export function sanitizeEndUserPrompt(prompt: string): string {
  let sanitized = prompt;

  // Strip system instruction XML tags that could break prompt structure
  sanitized = sanitized.replace(/<\/?system-instruction>/gi, '');

  // Remove null bytes
  sanitized = sanitized.replace(/\x00/g, '');

  // Remove zero-width characters used for evasion
  // U+200B Zero Width Space, U+200C Zero Width Non-Joiner,
  // U+200D Zero Width Joiner, U+FEFF Byte Order Mark
  sanitized = sanitized.replace(/\u200B|\u200C|\u200D|\uFEFF/g, '');

  // Truncate to max length
  if (sanitized.length > MAX_END_USER_PROMPT_LENGTH) {
    sanitized = sanitized.slice(0, MAX_END_USER_PROMPT_LENGTH);
  }

  return sanitized;
}

// ========== Types ==========

export interface BoardExecutionRequest {
  /** Board template to execute (must be in deployment's allowedBoardTemplateIds) */
  boardTemplateId: string;
  /** The end user's prompt (untrusted input) */
  endUserPrompt: string;
  /** Unique identifier for the end user (for isolation + rate tracking) */
  endUserId: string;
  /** Deployment that owns this execution */
  deploymentId: string;
}

export interface BoardExecutionConfig {
  deploymentId: string;
  aiEnabled: boolean;
  allowedAiCapabilities: string[];
  /** Board template IDs this deployment is allowed to execute */
  allowedBoardTemplateIds: string[];
  /** Max concurrent board executions per deployment */
  maxConcurrentBoardExecutions: number;
  /** Max board executions per minute (null = unlimited) */
  maxBoardExecutionsPerMinute: number | null;
  defaultModel: string;
  workingDir: string;
}

export type BoardExecutionErrorCode =
  | 'CAPABILITY_DENIED'
  | 'AI_DISABLED'
  | 'INVALID_BOARD_TEMPLATE'
  | 'BOARD_TEMPLATE_NOT_FOUND'
  | 'RATE_LIMIT_EXCEEDED'
  | 'CONCURRENT_LIMIT_EXCEEDED'
  | 'INVALID_REQUEST'
  | 'EXECUTION_FAILED';

export interface BoardExecutionError {
  code: BoardExecutionErrorCode;
  message: string;
}

export type BoardExecutionJobStatus =
  | 'customizing'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BoardExecutionProgress {
  phase: 'isolating' | 'customizing' | 'executing' | 'collecting' | 'done';
  issuesTotal: number;
  issuesCompleted: number;
  currentWaveIds: string[];
}

export interface BoardExecutionJobResult {
  completed: boolean;
  issuesTotal: number;
  issuesCompleted: number;
  issuesFailed: number;
  /** Output artifact contents keyed by filename */
  outputs: Record<string, string>;
  durationMs: number;
}

export interface BoardExecutionStatusResult {
  jobId: string;
  status: BoardExecutionJobStatus;
  progress: BoardExecutionProgress;
  result: BoardExecutionJobResult | null;
  error: string | null;
}

export type StartBoardExecutionResult =
  | { ok: true; jobId: string }
  | { ok: false; error: BoardExecutionError };

// ========== Internal Job Type ==========

interface BoardExecutionJob {
  jobId: string;
  deploymentId: string;
  endUserId: string;
  boardTemplateId: string;
  endUserPrompt: string;
  status: BoardExecutionJobStatus;
  progress: BoardExecutionProgress;
  result: BoardExecutionJobResult | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  isolatedDir: string | null;
}

// ========== Rate Limiter ==========

interface RateBucket {
  timestamps: number[];
  activeExecutions: number;
}

const rateBuckets = new Map<string, RateBucket>();

function getBucket(deploymentId: string): RateBucket {
  let bucket = rateBuckets.get(deploymentId);
  if (!bucket) {
    bucket = { timestamps: [], activeExecutions: 0 };
    rateBuckets.set(deploymentId, bucket);
  }
  return bucket;
}

function pruneTimestamps(bucket: RateBucket): void {
  const oneMinuteAgo = Date.now() - 60_000;
  while (bucket.timestamps.length > 0 && bucket.timestamps[0] < oneMinuteAgo) {
    bucket.timestamps.shift();
  }
}

function checkRateLimit(
  config: BoardExecutionConfig,
): BoardExecutionError | null {
  const bucket = getBucket(config.deploymentId);

  // Check concurrent executions
  if (bucket.activeExecutions >= config.maxConcurrentBoardExecutions) {
    return {
      code: 'CONCURRENT_LIMIT_EXCEEDED',
      message: `Deployment has reached the maximum of ${config.maxConcurrentBoardExecutions} concurrent board executions. Wait for an existing execution to complete.`,
    };
  }

  // Check executions per minute
  if (config.maxBoardExecutionsPerMinute !== null) {
    pruneTimestamps(bucket);
    if (bucket.timestamps.length >= config.maxBoardExecutionsPerMinute) {
      return {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Deployment has exceeded the rate limit of ${config.maxBoardExecutionsPerMinute} board executions per minute. Try again shortly.`,
      };
    }
  }

  return null;
}

function recordExecutionStart(deploymentId: string): void {
  const bucket = getBucket(deploymentId);
  bucket.timestamps.push(Date.now());
  bucket.activeExecutions++;
}

function recordExecutionEnd(deploymentId: string): void {
  const bucket = getBucket(deploymentId);
  bucket.activeExecutions = Math.max(0, bucket.activeExecutions - 1);
}

// ========== Job Store ==========

/** Retention window for completed/failed jobs before cleanup (5 minutes) */
const JOB_RETENTION_MS = 300_000;

const jobs = new Map<string, BoardExecutionJob>();

function createJob(request: BoardExecutionRequest): BoardExecutionJob {
  const jobId = `board-exec-${request.deploymentId}-${randomUUID()}`;
  const now = Date.now();

  const job: BoardExecutionJob = {
    jobId,
    deploymentId: request.deploymentId,
    endUserId: request.endUserId,
    boardTemplateId: request.boardTemplateId,
    endUserPrompt: request.endUserPrompt,
    status: 'customizing',
    progress: {
      phase: 'isolating',
      issuesTotal: 0,
      issuesCompleted: 0,
      currentWaveIds: [],
    },
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    isolatedDir: null,
  };

  jobs.set(jobId, job);
  return job;
}

function updateJob(jobId: string, updates: Partial<BoardExecutionJob>): void {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, updates, { updatedAt: Date.now() });
}

function scheduleJobCleanup(jobId: string): void {
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (job && job.status !== 'customizing' && job.status !== 'executing') {
      if (job.isolatedDir) {
        cleanupIsolatedDir(job.isolatedDir);
      }
      jobs.delete(jobId);
    }
  }, JOB_RETENTION_MS);
}

// ========== Isolation ==========

function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an isolated working directory for a board execution.
 *
 * Uses git worktree for git repos (efficient — shares object store).
 * Falls back to a filtered directory copy for non-git repos.
 *
 * .mstro/pm/ is gitignored, so it is always copied manually.
 */
function createIsolatedDir(workingDir: string): string {
  const prefix = join(tmpdir(), 'mstro-board-exec-');

  if (isGitRepo(workingDir)) {
    const isolatedDir = mkdtempSync(prefix);
    // git worktree needs a non-existent path
    rmSync(isolatedDir, { recursive: true, force: true });
    execSync(`git worktree add --detach "${isolatedDir}"`, {
      cwd: workingDir,
      stdio: 'pipe',
    });

    // .mstro/ is gitignored — copy the PM directory manually
    const pmDir = join(workingDir, '.mstro', 'pm');
    const isolatedPmDir = join(isolatedDir, '.mstro', 'pm');
    if (existsSync(pmDir) && !existsSync(isolatedPmDir)) {
      mkdirSync(join(isolatedDir, '.mstro'), { recursive: true });
      cpSync(pmDir, isolatedPmDir, { recursive: true });
    }

    return isolatedDir;
  }

  // Fallback: filtered directory copy for non-git repos
  const isolatedDir = mkdtempSync(prefix);
  cpSync(workingDir, isolatedDir, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('.git'),
  });
  return isolatedDir;
}

function cleanupIsolatedDir(isolatedDir: string): void {
  try {
    // Try git worktree remove first
    execSync(`git worktree remove --force "${isolatedDir}"`, { stdio: 'pipe' });
  } catch {
    // Fallback: direct removal
    try {
      rmSync(isolatedDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  }
}

// ========== Board Template Loading ==========

function validateBoardTemplate(
  workingDir: string,
  boardTemplateId: string,
): { issueCount: number } | null {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return null;

  const boardState = parseBoardDirectory(pmDir, boardTemplateId);
  if (!boardState) return null;

  return {
    issueCount: boardState.issues.filter(i => i.type !== 'epic').length,
  };
}

// ========== Board Customization ==========

/**
 * Build the customization prompt. The system instruction explains the task;
 * the end-user prompt is in a separate, clearly delimited section.
 *
 * SECURITY: The end-user prompt is never interpolated into the system
 * instruction. It appears in the user-message section only.
 */
function buildCustomizationPrompt(
  boardTemplateId: string,
  endUserPrompt: string,
  isolatedDir: string,
): string {
  const pmDir = resolvePmDir(isolatedDir);
  const boardDir = pmDir ? join(pmDir, 'boards', boardTemplateId) : '';
  const backlogDir = boardDir ? join(boardDir, 'backlog') : '';

  const systemInstruction = `You are customizing a PM Board template for an end user's specific needs.

## Board Template
Board ID: ${boardTemplateId}
Board directory: ${boardDir}
Backlog directory: ${backlogDir}

## Task

Read all issue files in the board's backlog directory. Then adapt every issue to fulfill the end user's request below. For each issue:

1. Update the description to be specific to the end user's needs
2. Update acceptance criteria to match their requirements
3. Update technical notes with relevant implementation details
4. Update "Files to Modify" if applicable
5. Preserve all YAML front matter fields (id, type, status, priority, blocked_by, etc.)
6. Do NOT change issue IDs, dependency edges, or the overall board structure

If issues need to be added or removed to properly serve the end user's request, you may do so — but preserve the dependency graph's integrity.

## Rules

- All changes must be within ${backlogDir}
- Preserve YAML front matter structure exactly
- Keep issue scoping appropriate (1-5 story points each)
- Ensure blocked_by references remain valid
- Do NOT modify board.md, STATE.md, or any files outside the backlog
- Respond briefly describing what you changed`;

  return [
    '<system-instruction>',
    systemInstruction,
    '</system-instruction>',
    '',
    endUserPrompt,
  ].join('\n');
}

/**
 * Customize a board template via headless Claude Code session.
 * Claude reads the board's issues and adapts them for the end user's prompt.
 */
async function customizeBoard(
  boardTemplateId: string,
  endUserPrompt: string,
  isolatedDir: string,
  apiKey: string,
): Promise<{ completed: boolean; error?: string }> {
  const prompt = buildCustomizationPrompt(boardTemplateId, endUserPrompt, isolatedDir);

  const runner = new HeadlessRunner({
    workingDir: isolatedDir,
    directPrompt: prompt,
    stallWarningMs: 300_000,    // 5 min
    stallKillMs: 900_000,       // 15 min
    stallHardCapMs: 1_800_000,  // 30 min hard cap
    extraEnv: { ANTHROPIC_API_KEY: apiKey },
    verbose: false,
    deployMode: true,           // Activate deploy-specific bouncer patterns
  });

  const result = await runner.run();
  return { completed: result.completed, error: result.error };
}

// ========== Board Execution ==========

/**
 * Run the full board execution ("implement all") via PlanExecutor.
 * Listens to executor events to track progress on the parent job.
 */
async function executeBoard(
  boardTemplateId: string,
  isolatedDir: string,
  job: BoardExecutionJob,
  apiKey: string,
): Promise<BoardExecutionJobResult> {
  const startTime = Date.now();
  const executor = new PlanExecutor(isolatedDir, {
    extraEnv: { ANTHROPIC_API_KEY: apiKey },
  });

  // Track progress via executor events
  executor.on('waveStarted', (data: { issueIds: string[] }) => {
    const current = jobs.get(job.jobId);
    if (current) {
      updateJob(job.jobId, {
        progress: { ...current.progress, currentWaveIds: data.issueIds },
      });
    }
  });

  executor.on('issueCompleted', () => {
    const current = jobs.get(job.jobId);
    if (current) {
      updateJob(job.jobId, {
        progress: {
          ...current.progress,
          issuesCompleted: current.progress.issuesCompleted + 1,
          currentWaveIds: [],
        },
      });
    }
  });

  await executor.startBoard(boardTemplateId);

  // Collect output artifacts
  const outputs = collectOutputs(isolatedDir, boardTemplateId);
  const metrics = executor.getMetrics();

  return {
    completed: executor.getStatus() === 'complete',
    issuesTotal: metrics.issuesAttempted,
    issuesCompleted: metrics.issuesCompleted,
    issuesFailed: metrics.issuesAttempted - metrics.issuesCompleted,
    outputs,
    durationMs: Date.now() - startTime,
  };
}

// ========== Result Collection ==========

function collectOutputs(
  isolatedDir: string,
  boardTemplateId: string,
): Record<string, string> {
  const pmDir = resolvePmDir(isolatedDir);
  if (!pmDir) return {};

  const outDir = join(pmDir, 'boards', boardTemplateId, 'out');
  if (!existsSync(outDir)) return {};

  const outputs: Record<string, string> = {};
  try {
    for (const file of readdirSync(outDir)) {
      if (file.endsWith('.md')) {
        outputs[file] = readFileSync(join(outDir, file), 'utf-8');
      }
    }
  } catch { /* non-fatal */ }

  return outputs;
}

// ========== Background Execution ==========

/**
 * Orchestrates the full board execution lifecycle. Updates job state
 * as it progresses through isolation, customization, execution, and
 * result collection phases.
 */
async function runBoardExecution(
  job: BoardExecutionJob,
  config: BoardExecutionConfig,
  apiKey: string,
): Promise<void> {
  try {
    // Phase 1: Create isolated working directory
    updateJob(job.jobId, {
      progress: { ...job.progress, phase: 'isolating' },
    });

    let isolatedDir: string;
    try {
      isolatedDir = createIsolatedDir(config.workingDir);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      updateJob(job.jobId, {
        status: 'failed',
        error: `Failed to create isolated directory: ${message}`,
      });
      return;
    }

    updateJob(job.jobId, { isolatedDir });

    // Phase 2: Customize board via headless Claude Code
    updateJob(job.jobId, {
      status: 'customizing',
      progress: { ...job.progress, phase: 'customizing' },
    });

    const customization = await customizeBoard(
      job.boardTemplateId,
      sanitizeEndUserPrompt(job.endUserPrompt),
      isolatedDir,
      apiKey,
    );

    if (!customization.completed) {
      updateJob(job.jobId, {
        status: 'failed',
        error: `Board customization failed: ${customization.error || 'Unknown error'}`,
      });
      return;
    }

    // Phase 3: Execute board ("implement all")
    updateJob(job.jobId, {
      status: 'executing',
      progress: { ...job.progress, phase: 'executing' },
    });

    const result = await executeBoard(
      job.boardTemplateId,
      isolatedDir,
      job,
      apiKey,
    );

    // Phase 4: Store results
    updateJob(job.jobId, {
      status: result.completed ? 'completed' : 'failed',
      progress: {
        phase: 'done',
        issuesTotal: result.issuesTotal,
        issuesCompleted: result.issuesCompleted,
        currentWaveIds: [],
      },
      result,
      error: result.completed ? null : 'Board execution did not complete all issues',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    updateJob(job.jobId, {
      status: 'failed',
      error: message,
    });
  } finally {
    recordExecutionEnd(job.deploymentId);
    scheduleJobCleanup(job.jobId);
  }
}

// ========== Public API ==========

/**
 * Start a board execution for an end user. Returns a job ID immediately.
 * The execution runs asynchronously — poll with getBoardExecutionStatus().
 *
 * Validates the deployment config, checks rate limits, verifies the board
 * template exists and is allowed, then launches the background execution.
 *
 * @returns Structured result with either the job ID or an error.
 */
export function startBoardExecution(
  request: BoardExecutionRequest,
  config: BoardExecutionConfig,
): StartBoardExecutionResult {
  // ── Validate request ───────────────────────────────────────
  if (!request.endUserPrompt || request.endUserPrompt.trim().length === 0) {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'endUserPrompt is required and must not be empty.' },
    };
  }

  if (request.endUserPrompt.length > MAX_END_USER_PROMPT_LENGTH) {
    return {
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: `endUserPrompt exceeds the maximum allowed length of ${MAX_END_USER_PROMPT_LENGTH.toLocaleString()} characters.`,
      },
    };
  }

  if (!request.endUserId || request.endUserId.trim().length === 0) {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'endUserId is required.' },
    };
  }

  if (!request.boardTemplateId || request.boardTemplateId.trim().length === 0) {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'boardTemplateId is required.' },
    };
  }

  // ── Validate boardTemplateId format (path traversal defense) ─
  if (/[/\\]|\.\.|\x00/.test(request.boardTemplateId)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_BOARD_TEMPLATE',
        message: 'boardTemplateId contains invalid characters (/, \\, .., or null bytes).',
      },
    };
  }

  // ── Validate AI is enabled ─────────────────────────────────
  if (!config.aiEnabled) {
    return {
      ok: false,
      error: { code: 'AI_DISABLED', message: 'AI features are not enabled for this deployment.' },
    };
  }

  // ── Validate board-execution capability ────────────────────
  if (!config.allowedAiCapabilities.includes('board-execution')) {
    return {
      ok: false,
      error: {
        code: 'CAPABILITY_DENIED',
        message: "This deployment does not have the 'board-execution' AI capability enabled.",
      },
    };
  }

  // ── Validate board template is allowed ─────────────────────
  if (!config.allowedBoardTemplateIds.includes(request.boardTemplateId)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_BOARD_TEMPLATE',
        message: `Board template '${request.boardTemplateId}' is not allowed for this deployment.`,
      },
    };
  }

  // ── Validate board template exists ─────────────────────────
  const template = validateBoardTemplate(config.workingDir, request.boardTemplateId);
  if (!template) {
    return {
      ok: false,
      error: {
        code: 'BOARD_TEMPLATE_NOT_FOUND',
        message: `Board template '${request.boardTemplateId}' not found in project.`,
      },
    };
  }

  // ── Rate limit checks ─────────────────────────────────────
  const rateLimitError = checkRateLimit(config);
  if (rateLimitError) {
    return { ok: false, error: rateLimitError };
  }

  // ── Verify API key ─────────────────────────────────────────
  const credential = readOwnerApiCredential();
  if (!credential || credential.type !== 'api-key') {
    return {
      ok: false,
      error: {
        code: 'EXECUTION_FAILED',
        message: 'Deploy requires an Anthropic API key. Add your key in Deploy \u2192 AI Config or set ANTHROPIC_API_KEY in your environment.',
      },
    };
  }

  // ── Create job and launch background execution ─────────────
  const job = createJob(request);
  job.progress.issuesTotal = template.issueCount;

  recordExecutionStart(config.deploymentId);

  // Fire-and-forget — execution runs in background, errors captured in job
  runBoardExecution(job, config, credential.key).catch(() => {});

  return { ok: true, jobId: job.jobId };
}

/**
 * Get the current status of a board execution job.
 *
 * Optionally pass endUserId to enforce isolation — returns null if the
 * job belongs to a different end user.
 *
 * @returns Job status or null if not found / access denied.
 */
export function getBoardExecutionStatus(
  jobId: string,
  endUserId?: string,
): BoardExecutionStatusResult | null {
  const job = jobs.get(jobId);
  if (!job) return null;

  // Enforce end-user isolation when endUserId is provided
  if (endUserId !== undefined && job.endUserId !== endUserId) {
    return null;
  }

  return {
    jobId: job.jobId,
    status: job.status,
    progress: { ...job.progress },
    result: job.result,
    error: job.error,
  };
}

/**
 * Get the current rate limit state for a deployment's board executions.
 * Useful for status/monitoring endpoints.
 */
export function getDeploymentBoardExecutionState(deploymentId: string): {
  executionsInLastMinute: number;
  activeExecutions: number;
} {
  const bucket = getBucket(deploymentId);
  pruneTimestamps(bucket);
  return {
    executionsInLastMinute: bucket.timestamps.length,
    activeExecutions: bucket.activeExecutions,
  };
}

/**
 * Reset rate limit state for a deployment's board executions.
 * Call when a deployment is deleted.
 */
export function resetDeploymentBoardExecutionRateLimit(
  deploymentId: string,
): void {
  rateBuckets.delete(deploymentId);
}

/**
 * Sweep stale isolated directories left behind by crashed executions.
 *
 * Board execution creates temp dirs prefixed with 'mstro-board-exec-'.
 * If the process crashes before cleanup, these dirs leak. This function
 * removes any that are older than the retention window + buffer.
 *
 * Safe to call on startup or periodically.
 */
export function sweepStaleIsolatedDirs(): number {
  const prefix = 'mstro-board-exec-';
  const maxAgeMs = JOB_RETENTION_MS * 2; // 10 minutes — generous buffer
  let swept = 0;

  try {
    const tmpDir = tmpdir();
    const entries = readdirSync(tmpDir);
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;

      const fullPath = join(tmpDir, entry);
      try {
        // Extract timestamp from dir name: mstro-board-exec-<random>
        // Use filesystem stat for age instead of parsing name
        const { mtimeMs } = statSync(fullPath);
        if (now - mtimeMs > maxAgeMs) {
          cleanupIsolatedDir(fullPath);
          swept++;
        }
      } catch {
        // Can't stat or clean — skip
      }
    }
  } catch {
    // Can't read tmpdir — skip
  }

  return swept;
}
