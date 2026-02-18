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
  /** Names of all currently pending tools (toolId -> toolName) */
  pendingToolNames?: Set<string>;
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
 * When toolWatchdogActive is true, defers entirely to the watchdog for any
 * pending tool calls — the watchdog has per-tool adaptive timeouts that are
 * more precise than the stall detector's silence-based approach.
 */
function quickHeuristic(ctx: StallContext, toolWatchdogActive = false): StallVerdict | null {
  const pendingNames = ctx.pendingToolNames ?? new Set<string>();
  const hasPendingTools = ctx.pendingToolCount > 0;

  // When the watchdog is active and tools are pending, always defer.
  // The watchdog manages per-tool timeouts; the stall detector should only
  // fire when no tools are running and there's genuine silence.
  if (toolWatchdogActive && hasPendingTools) {
    const toolList = pendingNames.size > 0
      ? Array.from(pendingNames).join(', ')
      : `${ctx.pendingToolCount} tool(s)`;
    return {
      action: 'extend',
      extensionMs: 15 * 60_000,
      reason: `Watchdog active, deferring — pending: ${toolList}`,
    };
  }

  // Task/subagent launches are known to produce long silence periods.
  // The parent Claude process emits nothing while waiting for subagent results.
  // Check pendingToolNames (reliable) first, fall back to lastToolName (legacy).
  const hasTaskPending = pendingNames.has('Task') || (ctx.lastToolName === 'Task' && hasPendingTools);
  if (hasTaskPending) {
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

  // WebSearch/WebFetch: skip when watchdog handles them more precisely
  if (
    !toolWatchdogActive &&
    (ctx.lastToolName === 'WebSearch' || ctx.lastToolName === 'WebFetch')
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
  toolWatchdogActive = false,
): Promise<StallVerdict> {
  // Layer 1: fast heuristic
  const quick = quickHeuristic(ctx, toolWatchdogActive);
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

/**
 * Assess a specific tool timeout using Haiku.
 * Used by ToolWatchdog as a tiebreaker before killing a tool.
 */
export async function assessToolTimeout(
  toolName: string,
  toolInput: Record<string, unknown>,
  elapsedMs: number,
  claudeCommand: string,
  verbose: boolean,
): Promise<StallVerdict> {
  const elapsedSec = Math.round(elapsedMs / 1000);

  // Summarize what the tool is doing
  let inputSummary = '';
  if (toolInput.url) {
    inputSummary = `URL: ${String(toolInput.url).slice(0, 200)}`;
  } else if (toolInput.query) {
    inputSummary = `Query: ${String(toolInput.query).slice(0, 200)}`;
  } else if (toolInput.command) {
    inputSummary = `Command: ${String(toolInput.command).slice(0, 200)}`;
  } else if (toolInput.prompt) {
    inputSummary = `Prompt: ${String(toolInput.prompt).slice(0, 200)}`;
  } else {
    inputSummary = JSON.stringify(toolInput).slice(0, 200);
  }

  const toolDescriptions: Record<string, string> = {
    WebFetch: 'fetches a URL, converts HTML to markdown, and runs a Haiku summarization pass',
    WebSearch: 'performs a web search and returns results',
    Task: 'spawns a subagent that runs autonomously with its own tools',
    Bash: 'executes a shell command',
  };
  const toolDesc = toolDescriptions[toolName] || `executes the ${toolName} tool`;

  const prompt = [
    `You are a process health monitor. A ${toolName} tool call has been running for ${elapsedSec}s.`,
    `${toolName} ${toolDesc}.`,
    `Tool input: ${inputSummary}`,
    '',
    `Is this tool call likely still working, or is it hung/frozen?`,
    'Consider: network latency, server response times, anti-bot protections, large page sizes, complex operations.',
    '',
    'Respond in EXACTLY this format (3 lines, no extra text):',
    'VERDICT: WORKING or STALLED',
    'MINUTES: <number 1-10, only if WORKING, how many more minutes to allow>',
    'REASON: <brief one-line explanation>',
  ].join('\n');

  try {
    if (verbose) {
      console.log(`[TOOL-ASSESS] Running Haiku assessment for ${toolName} (${elapsedSec}s elapsed)...`);
    }

    return await spawnHaikuVerdict(prompt, claudeCommand, verbose, 'TOOL-ASSESS');
  } catch (err) {
    if (verbose) {
      console.log(`[TOOL-ASSESS] Haiku assessment failed: ${err}`);
    }
    // On failure, default to kill (the tool has already exceeded its timeout)
    return {
      action: 'kill',
      extensionMs: 0,
      reason: `Tool timeout assessment failed: ${err}`,
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

/** Low-level Haiku spawner: runs a prompt through `claude --print --model haiku` and returns parsed verdict */
function spawnHaikuVerdict(
  prompt: string,
  claudeCommand: string,
  verbose: boolean,
  label = 'STALL-ASSESS',
): Promise<StallVerdict> {
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
        console.log(`[${label}] haiku stderr: ${data.toString().trim()}`);
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
        console.log(`[${label}] Haiku response: ${stdout.trim()}`);
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

function runHaikuAssessment(
  ctx: StallContext,
  claudeCommand: string,
  verbose: boolean,
): Promise<StallVerdict> {
  return spawnHaikuVerdict(buildAssessmentPrompt(ctx), claudeCommand, verbose);
}
