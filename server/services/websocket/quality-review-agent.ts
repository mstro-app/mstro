// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Quality Review Agent — AI-powered code review using Claude Code headless runner.
 *
 * Builds the review prompt, runs the agent, parses findings, and persists results.
 */

import { runWithFileLogger } from '../../cli/headless/headless-logger.js';
import { HeadlessRunner } from '../../cli/headless/index.js';
import type { ToolUseEvent } from '../../cli/headless/types.js';
import type { HandlerContext } from './handler-context.js';
import type { QualityPersistence } from './quality-persistence.js';
import { recomputeWithAiReview } from './quality-service.js';
import type { WSContext } from './types.js';

// ── Types ─────────────────────────────────────────────────────

export interface CodeReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'security' | 'bugs' | 'performance' | 'maintainability';
  file: string;
  line: number | null;
  title: string;
  description: string;
  suggestion?: string;
}

// ── Prompt ────────────────────────────────────────────────────

export function buildCodeReviewPrompt(dirPath: string): string {
  return `You are an expert code review agent. Your task is to perform a comprehensive, language-agnostic code review of the project in the current working directory.

IMPORTANT: Your current working directory is "${dirPath}". Only review files within this directory. Do NOT traverse parent directories or review files outside this path.

## Review Process

1. **Discover**: Use Glob to find source files (e.g. "**/*.{ts,tsx,js,py,rs,go,java,rb,php}"). Understand the project structure. Only search within the current directory.
2. **Read**: Read the most important files — entry points, core modules, handlers, services. Prioritize files with recent git changes (\`git diff --name-only HEAD~5\` via Bash if available).
3. **Analyze**: Look for real, actionable issues across these categories:
   - **security**: Injection vulnerabilities (SQL, XSS, command), hardcoded secrets/credentials, auth bypasses, insecure crypto, path traversal, SSRF, unsafe deserialization
   - **bugs**: Null/undefined errors, race conditions, logic errors, unhandled edge cases, off-by-one errors, resource leaks, incorrect error handling
   - **performance**: N+1 queries, unnecessary re-renders, missing memoization, blocking I/O in hot paths, unbounded data structures, missing pagination
   - **maintainability**: God functions (>100 lines), deep nesting (>4 levels), duplicated logic, missing error handling at system boundaries, tight coupling

## Rules

- Only report findings you are >80% confident about. No speculative or low-confidence issues.
- Focus on bugs and security over style. Skip formatting, naming preferences, and minor nits.
- Each finding MUST reference a specific file and line number. Do not report vague or file-level issues.
- Limit to the 20 most important findings, ranked by severity.
- Do NOT modify any files. This is a read-only review.

## Output

After your analysis, output EXACTLY one JSON code block with your findings. No other text after the JSON block.

\`\`\`json
{
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "category": "security|bugs|performance|maintainability",
      "file": "relative/path/to/file.ts",
      "line": 42,
      "title": "Short title describing the issue",
      "description": "What the problem is and why it matters.",
      "suggestion": "How to fix it."
    }
  ],
  "summary": "Brief 1-2 sentence summary of overall code quality."
}
\`\`\``;
}

// ── Response parsing ──────────────────────────────────────────

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const VALID_CATEGORIES = new Set(['security', 'bugs', 'performance', 'maintainability']);

function normalizeFinding(f: Record<string, unknown>): CodeReviewFinding | null {
  if (typeof f.file !== 'string' || typeof f.title !== 'string') return null;
  return {
    severity: VALID_SEVERITIES.has(f.severity as string) ? f.severity as CodeReviewFinding['severity'] : 'medium',
    category: VALID_CATEGORIES.has(f.category as string) ? f.category as CodeReviewFinding['category'] : 'maintainability',
    file: f.file as string,
    line: typeof f.line === 'number' ? f.line : null,
    title: f.title as string,
    description: typeof f.description === 'string' ? f.description : '',
    suggestion: typeof f.suggestion === 'string' ? f.suggestion : undefined,
  };
}

function extractJson(response: string): string {
  const fencedJson = response.match(/```json\s*([\s\S]*?)```/);
  if (fencedJson) return fencedJson[1].trim();

  const fencedPlain = response.match(/```\s*([\s\S]*?)```/);
  if (fencedPlain) return fencedPlain[1].trim();

  const braceMatch = response.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0].trim();

  return response.trim();
}

export function parseCodeReviewResponse(response: string): { findings: CodeReviewFinding[]; summary: string } {
  const jsonStr = extractJson(response);

  try {
    const parsed = JSON.parse(jsonStr);
    const rawFindings: Record<string, unknown>[] = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings = rawFindings.map(normalizeFinding).filter((f): f is CodeReviewFinding => f !== null);
    const summary = typeof parsed.summary === 'string' ? parsed.summary : `Found ${findings.length} issue(s).`;
    return { findings, summary };
  } catch {
    return { findings: [], summary: 'Failed to parse code review results.' };
  }
}

// ── Progress tracking ─────────────────────────────────────────

const TOOL_START_MESSAGES: Record<string, string> = {
  Glob: 'Discovering project files...',
  Read: 'Reading source files...',
  Grep: 'Searching codebase...',
  Bash: 'Running analysis command...',
};

function getToolCompleteMessage(event: ToolUseEvent): string | null {
  const input = event.completeInput;
  if (!input) return null;
  if (event.toolName === 'Read' && input.file_path) {
    return `Reviewed ${String(input.file_path).split('/').slice(-2).join('/')}`;
  }
  if (event.toolName === 'Grep' && input.pattern) {
    return `Searched for "${String(input.pattern).slice(0, 40)}"`;
  }
  return null;
}

function createCodeReviewProgressTracker() {
  const seenToolStarts = new Set<string>();

  return (event: ToolUseEvent): string | null => {
    if (event.type === 'tool_start' && event.toolName) {
      if (seenToolStarts.has(event.toolName)) return null;
      seenToolStarts.add(event.toolName);
      return TOOL_START_MESSAGES[event.toolName] ?? null;
    }
    if (event.type === 'tool_complete') return getToolCompleteMessage(event);
    return null;
  };
}

// ── Handler ───────────────────────────────────────────────────

export async function handleCodeReview(
  ctx: HandlerContext,
  ws: WSContext,
  reportPath: string,
  dirPath: string,
  workingDir: string,
  activeReviews: Set<string>,
  getPersistence: (dir: string) => QualityPersistence,
): Promise<void> {
  if (activeReviews.has(dirPath)) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: reportPath, error: 'A code review is already running for this directory.' },
    });
    return;
  }

  activeReviews.add(dirPath);
  try {
    ctx.send(ws, {
      type: 'qualityCodeReviewProgress',
      data: { path: reportPath, message: 'Starting AI code review...' },
    });

    const runner = new HeadlessRunner({
      workingDir: dirPath,
      directPrompt: buildCodeReviewPrompt(dirPath),
      stallWarningMs: 120_000,
      stallKillMs: 600_000,
      stallHardCapMs: 900_000,
      toolUseCallback: (() => {
        const getProgressMessage = createCodeReviewProgressTracker();
        return (event: ToolUseEvent) => {
          const message = getProgressMessage(event);
          if (message) {
            ctx.send(ws, {
              type: 'qualityCodeReviewProgress',
              data: { path: reportPath, message },
            });
          }
        };
      })(),
    });

    ctx.send(ws, {
      type: 'qualityCodeReviewProgress',
      data: { path: reportPath, message: 'Claude is analyzing your codebase...' },
    });

    const result = await runWithFileLogger('code-review', () => runner.run());

    ctx.send(ws, {
      type: 'qualityCodeReviewProgress',
      data: { path: reportPath, message: 'Generating review report...' },
    });

    const responseText = result.assistantResponse || '';
    const { findings, summary } = parseCodeReviewResponse(responseText);

    // Recompute overall score with AI review findings included
    let updatedResults: import('./quality-service.js').QualityResults | null = null;
    try {
      const persistence = getPersistence(workingDir);
      const existingReport = persistence.loadReport(reportPath);
      if (existingReport) {
        updatedResults = recomputeWithAiReview(existingReport, findings);
        updatedResults = { ...updatedResults, codeReview: findings as unknown as typeof updatedResults.codeReview };
        persistence.saveReport(reportPath, updatedResults);
        persistence.appendHistory(updatedResults, reportPath);
      }
      persistence.saveCodeReview(reportPath, findings as unknown as Record<string, unknown>[], summary);
    } catch {
      // Persistence failure should not break the review flow
    }

    ctx.send(ws, {
      type: 'qualityCodeReview',
      data: { path: reportPath, findings, summary, results: updatedResults },
    });
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: reportPath, error: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    activeReviews.delete(dirPath);
  }
}
