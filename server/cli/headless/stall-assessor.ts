// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Stall Assessor & Haiku Assessment Hub
 *
 * Provides Haiku-based intelligent assessment for:
 * - Stall detection (is a silent process working or hung?)
 * - Context loss detection (did Claude lose context after timeouts?)
 * - Approval prompt classification (is a user message an approval or new task?)
 * - Best result comparison (which retry attempt produced better work?)
 * - Error classification (what kind of error is in stderr?)
 *
 * Stall detection uses a two-layer approach:
 * 1. Fast heuristic: known long-running patterns get automatic extensions.
 * 2. Haiku assessment: ambiguous cases get a quick AI evaluation.
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

// ========== Context Loss Assessment ==========

export interface ContextLossVerdict {
  /** Whether the agent lost context and needs recovery */
  contextLost: boolean;
  /** Human-readable reason for the verdict */
  reason: string;
}

/** Enriched context for Haiku-based context loss assessment */
export interface ContextLossContext {
  assistantResponse: string;
  effectiveTimeouts: number;
  nativeTimeoutCount: number;
  successfulToolCalls: number;
  thinkingOutputLength: number;
  hasSuccessfulWrite: boolean;
}

/**
 * Assess whether a Claude Code session lost context after tool timeouts.
 * Uses Haiku with enriched context signals — replaces brittle hardcoded
 * thresholds (200 chars thinking, 2x ratio, 500 chars response) with
 * a single LLM call that sees the full picture.
 *
 * Only call this when effectiveTimeouts > 0.
 */
export async function assessContextLoss(
  ctx: ContextLossContext,
  claudeCommand: string,
  verbose: boolean,
): Promise<ContextLossVerdict> {
  const tail = ctx.assistantResponse.slice(-800);

  const prompt = [
    'You are analyzing a Claude Code agent session that experienced tool timeouts.',
    'Determine whether the agent lost context (needs recovery) or is still productively working.',
    '',
    'Session signals:',
    `- ${ctx.effectiveTimeouts} tools timed out (${ctx.nativeTimeoutCount} detected in text stream, ${ctx.effectiveTimeouts - ctx.nativeTimeoutCount} detected structurally)`,
    `- ${ctx.successfulToolCalls} tools completed successfully`,
    `- Thinking output: ${ctx.thinkingOutputLength} characters`,
    `- Response length: ${ctx.assistantResponse.length} characters`,
    `- Successful file writes (Edit/Write/MultiEdit): ${ctx.hasSuccessfulWrite ? 'YES' : 'NO'}`,
    '',
    `Final response (last ${tail.length} chars):`,
    tail,
    '',
    'WORKING signals: continued tool calls after timeouts, substantial thinking about the task, producing code/analysis, writing files, referencing the original task.',
    'STALLED signals: asking "how can I help?", starting fresh, offering generic help, not referencing the original task, very short response with no substance, task abandoned mid-research.',
    '',
    'Respond in EXACTLY this format (2 lines, no extra text):',
    'VERDICT: WORKING or STALLED',
    'REASON: <brief one-line explanation>',
  ].join('\n');

  try {
    if (verbose) {
      console.log(`[CONTEXT-ASSESS] Running Haiku assessment (${ctx.effectiveTimeouts} timeouts, ${ctx.successfulToolCalls} successes, ${ctx.thinkingOutputLength} thinking chars)...`);
    }

    const raw = await spawnHaikuRaw(prompt, claudeCommand, verbose, 'CONTEXT-ASSESS');
    const parsed = parseVerdictResponse(raw);
    const contextLost = parsed.verdict === 'STALLED';

    if (verbose) {
      console.log(`[CONTEXT-ASSESS] Verdict: ${contextLost ? 'LOST' : 'CONTINUED'} — ${parsed.reason}`);
    }

    return { contextLost, reason: parsed.reason };
  } catch (err) {
    if (verbose) {
      console.log(`[CONTEXT-ASSESS] Haiku assessment failed: ${err}`);
    }
    // On failure, assume context was lost (safer to retry than to show a confused response)
    return {
      contextLost: true,
      reason: `Context loss assessment failed: ${err}`,
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

/** Low-level Haiku spawner: runs a prompt through `claude --print --model haiku` and returns raw text */
function spawnHaikuRaw(
  prompt: string,
  claudeCommand: string,
  verbose: boolean,
  label: string,
): Promise<string> {
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

      resolve(stdout.trim());
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** Parse VERDICT/REASON format from Haiku response */
function parseVerdictResponse(raw: string): { verdict: string; reason: string } {
  const lines = raw.split('\n');
  let verdict = 'STALLED';
  let reason = 'Assessment inconclusive';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('VERDICT:')) {
      verdict = trimmed.slice('VERDICT:'.length).trim().toUpperCase();
    } else if (trimmed.startsWith('REASON:')) {
      reason = trimmed.slice('REASON:'.length).trim();
    }
  }

  return { verdict, reason };
}

/** Haiku spawner that returns a parsed StallVerdict (for stall assessment) */
async function spawnHaikuVerdict(
  prompt: string,
  claudeCommand: string,
  verbose: boolean,
  label = 'STALL-ASSESS',
): Promise<StallVerdict> {
  const raw = await spawnHaikuRaw(prompt, claudeCommand, verbose, label);
  return parseAssessmentResponse(raw);
}

function runHaikuAssessment(
  ctx: StallContext,
  claudeCommand: string,
  verbose: boolean,
): Promise<StallVerdict> {
  return spawnHaikuVerdict(buildAssessmentPrompt(ctx), claudeCommand, verbose);
}

// ========== Approval Prompt Assessment ==========

export interface ApprovalVerdict {
  isApproval: boolean;
  reason: string;
}

/**
 * Assess whether a user message is an approval/continuation or a new task.
 * Uses Haiku to classify intent — handles natural language variations that
 * regex patterns miss ("sounds good", "yep do it", "option 2", etc.).
 */
export async function assessApproval(
  userMessage: string,
  claudeCommand: string,
  verbose: boolean,
): Promise<ApprovalVerdict> {
  const prompt = [
    'You are classifying a user message in a multi-turn conversation with a coding assistant.',
    'The assistant previously proposed a plan or asked a question, and the user is now responding.',
    '',
    `User's message: "${userMessage}"`,
    '',
    'Is this an approval/continuation (user agrees, says yes, wants to proceed) or a new task/question?',
    '',
    'APPROVAL signs: "yes", "sure", "go ahead", "sounds good", "do it", "yep", "option 2", "the first one", "proceed", references to previous proposal, short affirmative with modifications ("yes but use TypeScript").',
    'NEW_TASK signs: asks a different question, gives new detailed instructions, changes topic, provides new requirements unrelated to any proposal.',
    '',
    'Respond in EXACTLY this format (2 lines, no extra text):',
    'VERDICT: APPROVAL or NEW_TASK',
    'REASON: <brief one-line explanation>',
  ].join('\n');

  try {
    if (verbose) {
      console.log('[APPROVAL-ASSESS] Running Haiku assessment...');
    }

    const raw = await spawnHaikuRaw(prompt, claudeCommand, verbose, 'APPROVAL-ASSESS');
    const parsed = parseVerdictResponse(raw);
    const isApproval = parsed.verdict.includes('APPROVAL');

    if (verbose) {
      console.log(`[APPROVAL-ASSESS] Verdict: ${isApproval ? 'APPROVAL' : 'NEW_TASK'} — ${parsed.reason}`);
    }

    return { isApproval, reason: parsed.reason };
  } catch (err) {
    if (verbose) {
      console.log(`[APPROVAL-ASSESS] Haiku assessment failed: ${err}`);
    }
    // On failure, assume not an approval (safer to treat as new task)
    return { isApproval: false, reason: `Assessment failed: ${err}` };
  }
}

// ========== Best Result Comparison ==========

export interface BestResultContext {
  originalPrompt: string;
  resultA: {
    successfulToolCalls: number;
    responseLength: number;
    hasThinking: boolean;
    responseTail: string;
  };
  resultB: {
    successfulToolCalls: number;
    responseLength: number;
    hasThinking: boolean;
    responseTail: string;
  };
}

export interface BestResultVerdict {
  winner: 'A' | 'B';
  reason: string;
}

/**
 * Compare two retry results and determine which made more meaningful progress.
 * Uses Haiku to evaluate quality — replaces arbitrary numeric scoring
 * (tool count * 10 + response length / 50 + thinking bonus).
 */
export async function assessBestResult(
  ctx: BestResultContext,
  claudeCommand: string,
  verbose: boolean,
): Promise<BestResultVerdict> {
  const promptPreview = ctx.originalPrompt.length > 300
    ? `${ctx.originalPrompt.slice(0, 300)}...`
    : ctx.originalPrompt;

  const prompt = [
    'You are comparing two AI assistant responses from retry attempts to determine which made more meaningful progress on the user\'s task.',
    '',
    `Original task: ${promptPreview}`,
    '',
    `Response A: ${ctx.resultA.successfulToolCalls} successful tool calls, ${ctx.resultA.responseLength} chars, ${ctx.resultA.hasThinking ? 'has' : 'no'} thinking output`,
    `Last 500 chars of A: ${ctx.resultA.responseTail}`,
    '',
    `Response B: ${ctx.resultB.successfulToolCalls} successful tool calls, ${ctx.resultB.responseLength} chars, ${ctx.resultB.hasThinking ? 'has' : 'no'} thinking output`,
    `Last 500 chars of B: ${ctx.resultB.responseTail}`,
    '',
    'Which response made more meaningful progress? Consider:',
    '- Did it actually work on the task (tool calls, code changes) vs just talking about it?',
    '- Is it confused/lost context ("How can I help?") vs engaged with the original task?',
    '- Quality of analysis and output, not just quantity.',
    '',
    'Respond in EXACTLY this format (2 lines, no extra text):',
    'VERDICT: A or B',
    'REASON: <brief one-line explanation>',
  ].join('\n');

  try {
    if (verbose) {
      console.log('[BEST-RESULT] Running Haiku assessment...');
    }

    const raw = await spawnHaikuRaw(prompt, claudeCommand, verbose, 'BEST-RESULT');
    const parsed = parseVerdictResponse(raw);
    const winner: 'A' | 'B' = parsed.verdict.includes('B') ? 'B' : 'A';

    if (verbose) {
      console.log(`[BEST-RESULT] Verdict: ${winner} — ${parsed.reason}`);
    }

    return { winner, reason: parsed.reason };
  } catch (err) {
    if (verbose) {
      console.log(`[BEST-RESULT] Haiku assessment failed: ${err}`);
    }
    // On failure, prefer A (the previously-tracked best result)
    return { winner: 'A', reason: `Assessment failed: ${err}` };
  }
}

// ========== Error Classification ==========

export interface ErrorClassification {
  errorCode: string;
  message: string;
}

/**
 * Classify an unrecognized error from stderr using Haiku.
 * Called as a fallback when regex patterns in output-utils.ts don't match.
 * Returns null if the stderr content isn't a real error (just warnings/debug info).
 */
export async function classifyError(
  stderrContent: string,
  claudeCommand: string,
  verbose: boolean,
): Promise<ErrorClassification | null> {
  const tail = stderrContent.slice(-500);
  if (!tail.trim()) return null;

  const prompt = [
    'You are classifying an error message from the Claude Code CLI that did not match known patterns.',
    '',
    `stderr (last ${tail.length} chars):`,
    tail,
    '',
    'Classify into one of these categories:',
    '- AUTH_REQUIRED: Authentication/login issues',
    '- API_KEY_INVALID: API key problems',
    '- QUOTA_EXCEEDED: Usage limits, billing, subscription',
    '- RATE_LIMITED: Too many requests, throttling',
    '- NETWORK_ERROR: Connection, DNS, timeout issues',
    '- SSL_ERROR: Certificate/TLS problems',
    '- SERVICE_UNAVAILABLE: Backend down (502/503/504)',
    '- INTERNAL_ERROR: Server errors (500)',
    '- CONTEXT_TOO_LONG: Token/context limit exceeded',
    '- SESSION_NOT_FOUND: Invalid/expired session',
    '- UNKNOWN: Cannot determine, not a real error, or just warnings/debug output',
    '',
    'If the stderr content is just warnings, debug info, or not an actual error, use UNKNOWN.',
    '',
    'Respond in EXACTLY this format (2 lines, no extra text):',
    'CATEGORY: <one of the above>',
    'MESSAGE: <brief user-friendly description of the error>',
  ].join('\n');

  try {
    if (verbose) {
      console.log('[ERROR-CLASSIFY] Running Haiku assessment...');
    }

    const raw = await spawnHaikuRaw(prompt, claudeCommand, verbose, 'ERROR-CLASSIFY');
    const lines = raw.split('\n');
    let category = 'UNKNOWN';
    let message = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('CATEGORY:')) {
        category = trimmed.slice('CATEGORY:'.length).trim().toUpperCase();
      } else if (trimmed.startsWith('MESSAGE:')) {
        message = trimmed.slice('MESSAGE:'.length).trim();
      }
    }

    if (category === 'UNKNOWN' || !message) return null;

    if (verbose) {
      console.log(`[ERROR-CLASSIFY] Verdict: ${category} — ${message}`);
    }

    return { errorCode: category, message };
  } catch (err) {
    if (verbose) {
      console.log(`[ERROR-CLASSIFY] Haiku assessment failed: ${err}`);
    }
    return null;
  }
}
