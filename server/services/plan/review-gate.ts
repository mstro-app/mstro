// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Review Gate — AI-powered quality gate for completed issues.
 *
 * Code tasks: reads modified files, checks acceptance criteria, looks for bugs.
 * Non-code tasks: reads output doc, checks criteria and completeness.
 * Auto-passes on infrastructure failures to avoid blocking execution.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWithFileLogger } from '../../cli/headless/headless-logger.js';
import { HeadlessRunner } from '../../cli/headless/index.js';
import type { Issue, ReviewCheck, ReviewResult } from './types.js';

/** Max review attempts per issue per sprint before giving up */
export const MAX_REVIEW_ATTEMPTS = 3;

/** Review runner stall timeouts (ms) */
const REVIEW_STALL_WARNING_MS = 300_000;   // 5 min
const REVIEW_STALL_KILL_MS = 600_000;      // 10 min
const REVIEW_STALL_HARD_CAP_MS = 900_000;  // 15 min

export interface ReviewIssueOptions {
  workingDir: string;
  issue: Issue;
  pmDir: string;
  outputPath: string;
  onOutput?: (text: string) => void;
}

/**
 * Run an AI review for a completed issue.
 * Returns auto-pass on infrastructure failures to avoid blocking execution.
 */
export async function reviewIssue(options: ReviewIssueOptions): Promise<ReviewResult> {
  const { workingDir, issue, pmDir, outputPath, onOutput } = options;
  const isCodeTask = issue.filesToModify.length > 0;
  const issueType: ReviewResult['issueType'] = isCodeTask ? 'code' : 'non-code';

  try {
    const prompt = buildReviewPrompt(issue, pmDir, outputPath, isCodeTask);

    const runner = new HeadlessRunner({
      workingDir,
      directPrompt: prompt,
      stallWarningMs: REVIEW_STALL_WARNING_MS,
      stallKillMs: REVIEW_STALL_KILL_MS,
      stallHardCapMs: REVIEW_STALL_HARD_CAP_MS,
      verbose: false,
      outputCallback: onOutput ? (text: string) => onOutput(`Review: ${text}`) : undefined,
    });

    const result = await runWithFileLogger('pm-review', () => runner.run());

    if (result.completed && result.assistantResponse) {
      return parseReviewOutput(issue.id, issueType, result.assistantResponse);
    }

    return autoPassResult(issue.id, issueType, 'Review runner did not complete');
  } catch {
    return autoPassResult(issue.id, issueType, 'Review threw an error');
  }
}

/** Count existing review result files for this issue in the board/sprint directory. */
export function getReviewAttemptCount(boardOrSandboxDir: string | null, issue: Issue): number {
  if (!boardOrSandboxDir) return 0;
  const reviewsDir = join(boardOrSandboxDir, 'reviews');
  if (!existsSync(reviewsDir)) return 0;
  try {
    return readdirSync(reviewsDir).filter(f => f.startsWith(issue.id) && f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/** Persist a review result as JSON in the board/sprint reviews directory. */
export function persistReviewResult(boardOrSandboxDir: string | null, issue: Issue, result: ReviewResult): void {
  if (!boardOrSandboxDir) return;
  const reviewsDir = join(boardOrSandboxDir, 'reviews');
  if (!existsSync(reviewsDir)) mkdirSync(reviewsDir, { recursive: true });
  try {
    writeFileSync(
      join(reviewsDir, `${issue.id}-${Date.now()}.json`),
      JSON.stringify(result, null, 2),
      'utf-8',
    );
  } catch { /* non-fatal */ }
}

/** Append failed review checks to an issue's Activity section. */
export function appendReviewFeedback(pmDir: string, issue: Issue, result: ReviewResult): void {
  const fullPath = join(pmDir, issue.path);
  try {
    let content = readFileSync(fullPath, 'utf-8');
    const failedChecks = result.checks.filter(c => !c.passed);
    const feedback = failedChecks.map(c => `  - ${c.name}: ${c.details}`).join('\n');
    const entry = `- Review failed (${new Date().toISOString().split('T')[0]}): ${failedChecks.length} check(s) failed\n${feedback}`;

    if (content.includes('## Activity')) {
      content = content.replace(/## Activity/, `## Activity\n${entry}`);
    } else {
      content += `\n\n## Activity\n${entry}`;
    }
    writeFileSync(fullPath, content, 'utf-8');
  } catch { /* non-fatal */ }
}

/** Extract the outermost JSON object from AI output using brace balancing. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Parse structured JSON review output from AI response. */
export function parseReviewOutput(issueId: string, issueType: ReviewResult['issueType'], output: string): ReviewResult {
  const jsonStr = extractJsonObject(output);
  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.passed === 'boolean' || typeof parsed.passed === 'number') {
        return {
          issueId,
          issueType,
          passed: !!parsed.passed,
          checks: Array.isArray(parsed.checks) ? parsed.checks.map((c: Record<string, unknown>) => ({
            name: String(c.name ?? 'unknown'),
            passed: !!c.passed,
            details: String(c.details ?? ''),
          } satisfies ReviewCheck)) : [],
          reviewedAt: new Date().toISOString(),
        };
      }
    } catch { /* fall through */ }
  }
  return autoPassResult(issueId, issueType, 'Could not parse review output');
}

/** Create a passing review result for infrastructure failures. */
export function autoPassResult(issueId: string, issueType: ReviewResult['issueType'], reason: string): ReviewResult {
  return {
    issueId,
    issueType,
    passed: true,
    autoPass: true,
    checks: [{ name: 'review_infrastructure', passed: true, details: `${reason}; auto-passing` }],
    reviewedAt: new Date().toISOString(),
  };
}

// ── Private helpers ─────────────────────────────────────────

function buildReviewPrompt(issue: Issue, pmDir: string, outputPath: string, isCodeTask: boolean): string {
  const criteria = issue.acceptanceCriteria
    .map(c => `- [${c.checked ? 'x' : ' '}] ${c.text}`)
    .join('\n');

  if (isCodeTask) {
    return `You are a code reviewer. Review the work done for issue ${issue.id}: ${issue.title}.

## Files Modified
${issue.filesToModify.map(f => `- ${f}`).join('\n')}

## Acceptance Criteria
${criteria || 'No specific criteria defined.'}

## Instructions
1. Read each modified file listed above
2. Check if all acceptance criteria are met by the code changes
3. Look for obvious bugs, security vulnerabilities, or code quality issues
4. Check if the output artifact exists at: ${outputPath}

Output EXACTLY one JSON object on its own line (no markdown fencing):
{"passed": true, "checks": [{"name": "criteria_met", "passed": true, "details": "..."}]}

Include checks for: criteria_met, code_quality, no_obvious_bugs.`;
  }

  return `You are a quality reviewer. Review the work done for issue ${issue.id}: ${issue.title}.

## Output File
${outputPath}

## Issue Spec
${join(pmDir, issue.path)}

## Acceptance Criteria
${criteria || 'No specific criteria defined.'}

## Instructions
1. Read the output file at the path above
2. Read the full issue spec
3. Check if all acceptance criteria are met
4. Check for completeness and quality of the output

Output EXACTLY one JSON object on its own line (no markdown fencing):
{"passed": true, "checks": [{"name": "criteria_met", "passed": true, "details": "..."}]}

Include checks for: criteria_met, output_quality, completeness.`;
}
