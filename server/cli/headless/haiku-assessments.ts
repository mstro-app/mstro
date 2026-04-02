// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Haiku-based AI assessments for the headless runner.
 *
 * Provides context loss detection, approval classification, premature completion detection,
 * best result comparison, and error classification via lightweight Haiku calls.
 *
 * The low-level Haiku spawner is also exported for use by stall-assessor.ts.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { hlog } from './headless-logger.js';

// ========== Haiku Infrastructure ==========

const HAIKU_TIMEOUT_MS = 30_000;

/** Low-level Haiku spawner: runs a prompt through `claude --print --model haiku` and returns raw text */
export function spawnHaikuRaw(
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

    proc.stdout!.on('data', (data) => { stdout += data.toString(); });
    proc.stderr!.on('data', (data) => {
      if (verbose) hlog(`[${label}] haiku stderr: ${data.toString().trim()}`);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0 || !stdout.trim()) {
        reject(new Error(`Haiku exited with code ${code}, output: ${stdout.trim()}`));
        return;
      }
      if (verbose) hlog(`[${label}] Haiku response: ${stdout.trim()}`);
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
export function parseVerdictResponse(raw: string): { verdict: string; reason: string } {
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

// ========== Context Loss Assessment ==========

export interface ContextLossVerdict {
  contextLost: boolean;
  reason: string;
}

export interface ContextLossContext {
  assistantResponse: string;
  effectiveTimeouts: number;
  nativeTimeoutCount: number;
  successfulToolCalls: number;
  thinkingOutputLength: number;
  hasSuccessfulWrite: boolean;
}

export async function assessContextLoss(
  ctx: ContextLossContext,
  claudeCommand: string,
  verbose: boolean,
): Promise<ContextLossVerdict> {
  const prompt = [
    'You are analyzing whether a Claude Code agent lost context after experiencing tool timeouts.',
    '',
    'Session signals:',
    `- ${ctx.effectiveTimeouts} tool(s) timed out (${ctx.nativeTimeoutCount} native timeouts)`,
    `- ${ctx.successfulToolCalls} tool calls completed successfully`,
    `- ${ctx.thinkingOutputLength > 0 ? 'Extended thinking was active' : 'No extended thinking'}`,
    `- ${ctx.hasSuccessfulWrite ? 'At least one file write succeeded' : 'No file writes succeeded'}`,
    '',
    `Final response text (last 500 chars):`,
    ctx.assistantResponse.slice(-500),
    '',
    'CONTEXT_LOST signs: "How can I help you?", generic greeting, no reference to the task,',
    'confusion about what to do, asking for task description, repeating the same action.',
    '',
    'CONTEXT_OK signs: references specific files/code, describes completed work, plans next steps,',
    'summarizes results, mentions the timeout and adjusts approach.',
    '',
    'IMPORTANT: If successful file writes happened AND the response references specific work,',
    'the agent likely recovered — favor CONTEXT_OK.',
    '',
    'Respond in EXACTLY this format (2 lines, no extra text):',
    'VERDICT: CONTEXT_LOST or CONTEXT_OK',
    'REASON: <brief one-line explanation>',
  ].join('\n');

  try {
    if (verbose) hlog('[CONTEXT-ASSESS] Running Haiku assessment...');
    const raw = await spawnHaikuRaw(prompt, claudeCommand, verbose, 'CONTEXT-ASSESS');
    const parsed = parseVerdictResponse(raw);
    const contextLost = parsed.verdict.includes('LOST');
    if (verbose) hlog(`[CONTEXT-ASSESS] Verdict: ${contextLost ? 'LOST' : 'OK'} — ${parsed.reason}`);
    return { contextLost, reason: parsed.reason };
  } catch (err) {
    if (verbose) hlog(`[CONTEXT-ASSESS] Haiku assessment failed: ${err}`);
    return { contextLost: false, reason: `Assessment failed: ${err}` };
  }
}

// ========== Approval Prompt Assessment ==========

export interface ApprovalVerdict {
  isApproval: boolean;
  reason: string;
}

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
    if (verbose) hlog('[APPROVAL-ASSESS] Running Haiku assessment...');
    const raw = await spawnHaikuRaw(prompt, claudeCommand, verbose, 'APPROVAL-ASSESS');
    const parsed = parseVerdictResponse(raw);
    const isApproval = parsed.verdict.includes('APPROVAL');
    if (verbose) hlog(`[APPROVAL-ASSESS] Verdict: ${isApproval ? 'APPROVAL' : 'NEW_TASK'} — ${parsed.reason}`);
    return { isApproval, reason: parsed.reason };
  } catch (err) {
    if (verbose) hlog(`[APPROVAL-ASSESS] Haiku assessment failed: ${err}`);
    return { isApproval: false, reason: `Assessment failed: ${err}` };
  }
}

// ========== Premature Completion Assessment ==========

export interface PrematureCompletionContext {
  responseTail: string;
  successfulToolCalls: number;
  hasThinking: boolean;
  responseLength: number;
}

export interface PrematureCompletionVerdict {
  isIncomplete: boolean;
  reason: string;
}

export async function assessPrematureCompletion(
  ctx: PrematureCompletionContext,
  claudeCommand: string,
  verbose: boolean,
): Promise<PrematureCompletionVerdict> {
  const prompt = [
    'You are analyzing the FINAL output of a Claude Code agent that just exited normally.',
    'Determine whether the agent finished its task or stopped prematurely mid-work.',
    '',
    'Session signals:',
    `- ${ctx.successfulToolCalls} tool calls completed successfully`,
    `- Response length: ${ctx.responseLength} characters`,
    `- Extended thinking: ${ctx.hasThinking ? 'YES' : 'NO'}`,
    '',
    `Final response text (last ${ctx.responseTail.length} chars):`,
    ctx.responseTail,
    '',
    'INCOMPLETE signals: "Now I\'ll...", "Let me fix...", "Next I\'ll...", "Moving on to...",',
    '"I\'ll continue with...", announcing next steps that were never executed,',
    'describing work that will happen next but no tool call followed.',
    '',
    'COMPLETE signals: summarizing what was done, confirming changes, reporting results,',
    'asking the user a question, past-tense descriptions of completed work,',
    '"all done", "changes applied", referencing finished state.',
    '',
    'Respond in EXACTLY this format (2 lines, no extra text):',
    'VERDICT: COMPLETE or INCOMPLETE',
    'REASON: <brief one-line explanation>',
  ].join('\n');

  try {
    if (verbose) hlog(`[PREMATURE-ASSESS] Running Haiku assessment (${ctx.successfulToolCalls} tools, ${ctx.responseLength} chars)...`);
    const raw = await spawnHaikuRaw(prompt, claudeCommand, verbose, 'PREMATURE-ASSESS');
    const parsed = parseVerdictResponse(raw);
    const isIncomplete = parsed.verdict.includes('INCOMPLETE');
    if (verbose) hlog(`[PREMATURE-ASSESS] Verdict: ${isIncomplete ? 'INCOMPLETE' : 'COMPLETE'} — ${parsed.reason}`);
    return { isIncomplete, reason: parsed.reason };
  } catch (err) {
    if (verbose) hlog(`[PREMATURE-ASSESS] Haiku assessment failed: ${err}`);
    return { isIncomplete: false, reason: `Assessment failed: ${err}` };
  }
}

// ========== Best Result Comparison ==========

export interface BestResultContext {
  originalPrompt: string;
  resultA: { successfulToolCalls: number; responseLength: number; hasThinking: boolean; responseTail: string };
  resultB: { successfulToolCalls: number; responseLength: number; hasThinking: boolean; responseTail: string };
}

export interface BestResultVerdict {
  winner: 'A' | 'B';
  reason: string;
}

export async function assessBestResult(
  ctx: BestResultContext,
  claudeCommand: string,
  verbose: boolean,
): Promise<BestResultVerdict> {
  const promptPreview = ctx.originalPrompt.length > 300 ? `${ctx.originalPrompt.slice(0, 300)}...` : ctx.originalPrompt;

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
    if (verbose) hlog('[BEST-RESULT] Running Haiku assessment...');
    const raw = await spawnHaikuRaw(prompt, claudeCommand, verbose, 'BEST-RESULT');
    const parsed = parseVerdictResponse(raw);
    const winner: 'A' | 'B' = parsed.verdict.includes('B') ? 'B' : 'A';
    if (verbose) hlog(`[BEST-RESULT] Verdict: ${winner} — ${parsed.reason}`);
    return { winner, reason: parsed.reason };
  } catch (err) {
    if (verbose) hlog(`[BEST-RESULT] Haiku assessment failed: ${err}`);
    return { winner: 'A', reason: `Assessment failed: ${err}` };
  }
}

// ========== Error Classification ==========

export interface ErrorClassification {
  errorCode: string;
  message: string;
}

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
    if (verbose) hlog('[ERROR-CLASSIFY] Running Haiku assessment...');
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
    if (verbose) hlog(`[ERROR-CLASSIFY] Verdict: ${category} — ${message}`);
    return { errorCode: category, message };
  } catch (err) {
    if (verbose) hlog(`[ERROR-CLASSIFY] Haiku assessment failed: ${err}`);
    return null;
  }
}
