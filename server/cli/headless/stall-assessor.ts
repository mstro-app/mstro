// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Stall Assessor — Two-layer stall detection (heuristic + Haiku AI).
 *
 * 1. Fast heuristic: known long-running patterns get automatic extensions.
 * 2. Haiku assessment: ambiguous cases get a quick AI evaluation.
 *
 * Other Haiku-based assessments (context loss, approval, premature completion,
 * best result, error classification) live in haiku-assessments.ts.
 */

import { spawnHaikuRaw } from './haiku-assessments.js';
import { hlog } from './headless-logger.js';

export type { ApprovalVerdict, BestResultContext, BestResultVerdict, ContextLossContext, ContextLossVerdict, ErrorClassification, PrematureCompletionContext, PrematureCompletionVerdict } from './haiku-assessments.js';
// Re-export assessment functions for backward compatibility
export { assessApproval, assessBestResult, assessContextLoss, assessPrematureCompletion, classifyError } from './haiku-assessments.js';

export interface StallContext {
  originalPrompt: string;
  silenceMs: number;
  lastToolName?: string;
  lastToolInputSummary?: string;
  pendingToolCount: number;
  pendingToolNames?: Set<string>;
  totalToolCalls: number;
  elapsedTotalMs: number;
  tokenSilenceMs?: number;
}

export interface StallVerdict {
  action: 'extend' | 'kill';
  extensionMs: number;
  reason: string;
}

// ========== Fast Heuristic ==========

function hasSubagentPending(pendingNames: Set<string>, lastToolName: string | undefined, hasPendingTools: boolean): boolean {
  return pendingNames.has('Task') || pendingNames.has('Agent')
    || ((lastToolName === 'Task' || lastToolName === 'Agent') && hasPendingTools);
}

function checkAgentTeamsWaiting(ctx: StallContext, hasPendingTools: boolean): StallVerdict | null {
  if (
    !hasPendingTools &&
    ctx.totalToolCalls > 0 &&
    ctx.originalPrompt.includes('team_name')
  ) {
    return {
      action: 'extend',
      extensionMs: 30 * 60_000,
      reason: 'Agent Teams lead waiting for teammate idle notifications — extending 30 min',
    };
  }
  return null;
}

function quickHeuristic(ctx: StallContext, toolWatchdogActive = false): StallVerdict | null {
  const pendingNames = ctx.pendingToolNames ?? new Set<string>();
  const hasPendingTools = ctx.pendingToolCount > 0;

  if (ctx.tokenSilenceMs !== undefined && ctx.tokenSilenceMs < 60_000) {
    return {
      action: 'extend',
      extensionMs: 10 * 60_000,
      reason: `Tokens still flowing (last activity ${Math.round(ctx.tokenSilenceMs / 1000)}s ago) — process is alive`,
    };
  }

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

  if (hasSubagentPending(pendingNames, ctx.lastToolName, hasPendingTools)) {
    const extensionMin = Math.min(30, 10 + ctx.pendingToolCount * 5);
    return {
      action: 'extend',
      extensionMs: extensionMin * 60_000,
      reason: `${ctx.pendingToolCount} Task subagent(s) still executing — extending ${extensionMin} min`,
    };
  }

  const agentTeamsVerdict = checkAgentTeamsWaiting(ctx, hasPendingTools);
  if (agentTeamsVerdict) return agentTeamsVerdict;

  if (ctx.pendingToolCount >= 3) {
    return {
      action: 'extend',
      extensionMs: 15 * 60_000,
      reason: `${ctx.pendingToolCount} parallel tool calls in progress — extending 15 min`,
    };
  }

  if (!toolWatchdogActive && (ctx.lastToolName === 'WebSearch' || ctx.lastToolName === 'WebFetch')) {
    return {
      action: 'extend',
      extensionMs: 5 * 60_000,
      reason: `${ctx.lastToolName} in progress — extending 5 min`,
    };
  }

  return null;
}

// ========== Haiku Stall Assessment ==========

function buildAssessmentPrompt(ctx: StallContext): string {
  const silenceMin = Math.round(ctx.silenceMs / 60_000);
  const totalMin = Math.round(ctx.elapsedTotalMs / 60_000);
  const promptPreview = ctx.originalPrompt.length > 500
    ? `${ctx.originalPrompt.slice(0, 500)}...`
    : ctx.originalPrompt;
  const tokenLine = ctx.tokenSilenceMs !== undefined
    ? `Token activity: last token event ${Math.round(ctx.tokenSilenceMs / 1000)}s ago (tokens flowing = process alive)`
    : 'Token activity: no token events observed';

  return [
    'You are a process health monitor. A Claude Code subprocess has been silent (no stdout) and you must determine if it is working or stalled.',
    '',
    `Silent for: ${silenceMin} minutes`,
    `Total runtime: ${totalMin} minutes`,
    `Last tool before silence: ${ctx.lastToolName || 'none'}`,
    ctx.lastToolInputSummary ? `Last tool input: ${ctx.lastToolInputSummary}` : '',
    `Pending tool calls: ${ctx.pendingToolCount}`,
    `Total tool calls this session: ${ctx.totalToolCalls}`,
    tokenLine,
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
    return { action: 'extend', extensionMs: minutes * 60_000, reason };
  }
  return { action: 'kill', extensionMs: 0, reason };
}

async function spawnHaikuVerdict(
  prompt: string,
  claudeCommand: string,
  verbose: boolean,
  label = 'STALL-ASSESS',
): Promise<StallVerdict> {
  const raw = await spawnHaikuRaw(prompt, claudeCommand, verbose, label);
  return parseAssessmentResponse(raw);
}

// ========== Public API ==========

export async function assessStall(
  ctx: StallContext,
  claudeCommand: string,
  verbose: boolean,
  toolWatchdogActive = false,
): Promise<StallVerdict> {
  const quick = quickHeuristic(ctx, toolWatchdogActive);
  if (quick) {
    if (verbose) hlog(`[STALL-ASSESS] Heuristic verdict: ${quick.reason}`);
    return quick;
  }

  try {
    if (verbose) hlog('[STALL-ASSESS] Running Haiku assessment...');
    return await spawnHaikuVerdict(buildAssessmentPrompt(ctx), claudeCommand, verbose);
  } catch (err) {
    if (verbose) hlog(`[STALL-ASSESS] Haiku assessment failed: ${err}`);
    return { action: 'extend', extensionMs: 10 * 60_000, reason: 'Stall assessment unavailable — extending 10 min as precaution' };
  }
}

export async function assessToolTimeout(
  toolName: string,
  toolInput: Record<string, unknown>,
  elapsedMs: number,
  claudeCommand: string,
  verbose: boolean,
  tokenSilenceMs?: number,
): Promise<StallVerdict> {
  const elapsedSec = Math.round(elapsedMs / 1000);

  let inputSummary = '';
  if (toolInput.url) inputSummary = `URL: ${String(toolInput.url).slice(0, 200)}`;
  else if (toolInput.query) inputSummary = `Query: ${String(toolInput.query).slice(0, 200)}`;
  else if (toolInput.command) inputSummary = `Command: ${String(toolInput.command).slice(0, 200)}`;
  else if (toolInput.prompt) inputSummary = `Prompt: ${String(toolInput.prompt).slice(0, 200)}`;
  else inputSummary = JSON.stringify(toolInput).slice(0, 200);

  const toolDescriptions: Record<string, string> = {
    WebFetch: 'fetches a URL, converts HTML to markdown, and runs a Haiku summarization pass',
    WebSearch: 'performs a web search and returns results',
    Task: 'spawns a subagent that runs autonomously with its own tools',
    Agent: 'spawns a subagent that runs autonomously with its own tools',
    Bash: 'executes a shell command',
  };
  const toolDesc = toolDescriptions[toolName] || `executes the ${toolName} tool`;

  const tokenLine = tokenSilenceMs !== undefined
    ? `Token activity: last token event ${Math.round(tokenSilenceMs / 1000)}s ago (recent tokens = process is alive and processing)`
    : 'Token activity: no token events observed';

  const prompt = [
    `You are a process health monitor. A ${toolName} tool call has been running for ${elapsedSec}s.`,
    `${toolName} ${toolDesc}.`,
    `Tool input: ${inputSummary}`,
    tokenLine,
    '',
    `Is this tool call likely still working, or is it hung/frozen?`,
    'Consider: network latency, server response times, anti-bot protections, large page sizes, complex operations.',
    'IMPORTANT: If tokens were active recently (< 60s ago), the process is likely still alive and processing — strongly favor WORKING.',
    '',
    'Respond in EXACTLY this format (3 lines, no extra text):',
    'VERDICT: WORKING or STALLED',
    'MINUTES: <number 1-10, only if WORKING, how many more minutes to allow>',
    'REASON: <brief one-line explanation>',
  ].join('\n');

  try {
    if (verbose) hlog(`[TOOL-ASSESS] Running Haiku assessment for ${toolName} (${elapsedSec}s elapsed)...`);
    return await spawnHaikuVerdict(prompt, claudeCommand, verbose, 'TOOL-ASSESS');
  } catch (err) {
    if (verbose) hlog(`[TOOL-ASSESS] Haiku assessment failed: ${err}`);
    return { action: 'kill', extensionMs: 0, reason: `Tool timeout assessment failed: ${err}` };
  }
}
