// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Stall Assessor
 *
 * Intelligently determines whether a silent Claude Code process is
 * legitimately working or genuinely stalled. Uses a two-layer approach:
 *
 * 1. Fast heuristic: known long-running patterns (Task subagents, parallel
 *    tool calls) get an automatic extension without any API call.
 *
 * 2. Haiku assessment: for ambiguous cases, spawns a quick Claude Haiku
 *    call to evaluate the situation and recommend an extension (or kill).
 */

import { type ChildProcess, spawn } from 'node:child_process';

export interface StallContext {
  /** The original user prompt being executed */
  originalPrompt: string;
  /** How long the process has been silent (ms) */
  silenceMs: number;
  /** Name of the last tool that started executing */
  lastToolName?: string;
  /** Summarized input of the last tool call */
  lastToolInputSummary?: string;
  /** Number of tool calls started but not yet returned */
  pendingToolCount: number;
  /** Total tool calls made so far this session */
  totalToolCalls: number;
  /** Total wall-clock time since process started (ms) */
  elapsedTotalMs: number;
}

export interface StallVerdict {
  /** Whether to extend the deadline or proceed with kill */
  action: 'extend' | 'kill';
  /** Additional time to grant (ms), only meaningful when action is 'extend' */
  extensionMs: number;
  /** Human-readable reason for the verdict */
  reason: string;
}

/**
 * Fast heuristic for known long-running patterns.
 * Returns a verdict immediately if the pattern is recognized, null otherwise.
 */
function quickHeuristic(ctx: StallContext): StallVerdict | null {
  // Task/subagent launches are known to produce long silence periods.
  // The parent Claude process emits nothing while waiting for subagent results.
  if (ctx.lastToolName === 'Task' && ctx.pendingToolCount > 0) {
    const extensionMin = Math.min(30, 10 + ctx.pendingToolCount * 5);
    return {
      action: 'extend',
      extensionMs: extensionMin * 60_000,
      reason: `${ctx.pendingToolCount} Task subagent(s) still executing — extending ${extensionMin} min`,
    };
  }

  // Multiple parallel tool calls (e.g., parallel Bash, parallel Read/Grep)
  if (ctx.pendingToolCount >= 3) {
    return {
      action: 'extend',
      extensionMs: 15 * 60_000,
      reason: `${ctx.pendingToolCount} parallel tool calls in progress — extending 15 min`,
    };
  }

  // WebSearch/WebFetch can be slow depending on the site
  if (
    ctx.lastToolName === 'WebSearch' ||
    ctx.lastToolName === 'WebFetch'
  ) {
    return {
      action: 'extend',
      extensionMs: 5 * 60_000,
      reason: `${ctx.lastToolName} in progress — extending 5 min`,
    };
  }

  return null;
}

/**
 * Main assessment entry point. Tries the fast heuristic first,
 * falls back to a Haiku model call for ambiguous cases.
 */
export async function assessStall(
  ctx: StallContext,
  claudeCommand: string,
  verbose: boolean,
): Promise<StallVerdict> {
  // Layer 1: fast heuristic
  const quick = quickHeuristic(ctx);
  if (quick) {
    if (verbose) {
      console.log(`[STALL-ASSESS] Heuristic verdict: ${quick.reason}`);
    }
    return quick;
  }

  // Layer 2: Haiku assessment
  try {
    if (verbose) {
      console.log('[STALL-ASSESS] Running Haiku assessment...');
    }
    return await runHaikuAssessment(ctx, claudeCommand, verbose);
  } catch (err) {
    if (verbose) {
      console.log(`[STALL-ASSESS] Haiku assessment failed: ${err}`);
    }
    // If Haiku fails (timeout, auth issue, etc.), extend cautiously
    return {
      action: 'extend',
      extensionMs: 10 * 60_000,
      reason: 'Stall assessment unavailable — extending 10 min as precaution',
    };
  }
}

function buildAssessmentPrompt(ctx: StallContext): string {
  const silenceMin = Math.round(ctx.silenceMs / 60_000);
  const totalMin = Math.round(ctx.elapsedTotalMs / 60_000);

  // Truncate prompt to avoid huge payloads
  const promptPreview = ctx.originalPrompt.length > 500
    ? `${ctx.originalPrompt.slice(0, 500)}...`
    : ctx.originalPrompt;

  return [
    'You are a process health monitor. A Claude Code subprocess has been silent (no stdout) and you must determine if it is working or stalled.',
    '',
    `Silent for: ${silenceMin} minutes`,
    `Total runtime: ${totalMin} minutes`,
    `Last tool before silence: ${ctx.lastToolName || 'none'}`,
    ctx.lastToolInputSummary ? `Last tool input: ${ctx.lastToolInputSummary}` : '',
    `Pending tool calls: ${ctx.pendingToolCount}`,
    `Total tool calls this session: ${ctx.totalToolCalls}`,
    `Task being executed: ${promptPreview}`,
    '',
    'Respond in EXACTLY this format (3 lines, no extra text):',
    'VERDICT: WORKING or STALLED',
    'MINUTES: <number 5-30, only if WORKING, how many more minutes to allow>',
    'REASON: <brief one-line explanation>',
  ].filter(Boolean).join('\n');
}

function parseAssessmentResponse(output: string): StallVerdict {
  const lines = output.trim().split('\n');
  let verdict = 'STALLED';
  let minutes = 10;
  let reason = 'Assessment inconclusive';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('VERDICT:')) {
      verdict = trimmed.slice('VERDICT:'.length).trim().toUpperCase();
    } else if (trimmed.startsWith('MINUTES:')) {
      const parsed = parseInt(trimmed.slice('MINUTES:'.length).trim(), 10);
      if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 60) {
        minutes = parsed;
      }
    } else if (trimmed.startsWith('REASON:')) {
      reason = trimmed.slice('REASON:'.length).trim();
    }
  }

  if (verdict.includes('WORKING')) {
    return {
      action: 'extend',
      extensionMs: minutes * 60_000,
      reason,
    };
  }

  return {
    action: 'kill',
    extensionMs: 0,
    reason,
  };
}

const HAIKU_TIMEOUT_MS = 30_000;

function runHaikuAssessment(
  ctx: StallContext,
  claudeCommand: string,
  verbose: boolean,
): Promise<StallVerdict> {
  const prompt = buildAssessmentPrompt(ctx);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let settled = false;

    const proc: ChildProcess = spawn(
      claudeCommand,
      ['--print', '--model', 'haiku', prompt],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        reject(new Error('Haiku assessment timed out'));
      }
    }, HAIKU_TIMEOUT_MS);

    proc.stdout!.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr!.on('data', (data) => {
      if (verbose) {
        console.log(`[STALL-ASSESS] haiku stderr: ${data.toString().trim()}`);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code !== 0 || !stdout.trim()) {
        reject(new Error(`Haiku exited with code ${code}, output: ${stdout.trim()}`));
        return;
      }

      if (verbose) {
        console.log(`[STALL-ASSESS] Haiku response: ${stdout.trim()}`);
      }

      resolve(parseAssessmentResponse(stdout));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}
