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

export function buildCodeReviewPrompt(dirPath: string, cliFindings?: Array<{ severity: string; category: string; file: string; line: number | null; title: string; description: string }>): string {
  const cliFindingsSection = cliFindings && cliFindings.length > 0
    ? `\n## CLI Tool Findings (already detected)\n\nThe following issues were found by automated CLI tools (linters, formatters, complexity analyzers). Review these for context — they are already included in the final report. Focus your analysis on DEEPER issues these tools cannot detect.\n\n${cliFindings.slice(0, 50).map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.category} — ${f.file}${f.line ? `:${f.line}` : ''} — ${f.title}: ${f.description}`).join('\n')}\n${cliFindings.length > 50 ? `\n...and ${cliFindings.length - 50} more issues from CLI tools.\n` : ''}`
    : '';

  return `You are a senior staff engineer performing a rigorous, honest code review. Your job is to surface the most impactful quality bottlenecks — the issues a principal engineer would flag in a code review. Be critical and objective. Do NOT inflate scores.

IMPORTANT: Your current working directory is "${dirPath}". Only review files within this directory.
${cliFindingsSection}
## Review Process

1. **Discover**: Use Glob to find source files (e.g. "**/*.{ts,tsx,js,py,rs,go,java,rb,php}"). Understand the project structure.
2. **Read**: Read the most important files — entry points, core modules, handlers, services. Prioritize files with recent git changes (\`git diff --name-only HEAD~5\` via Bash if available).
3. **Analyze**: Look for real, actionable issues across ALL of these categories:

   ### Architecture
   - What is the current architecture (monolith, microservices, layered, etc.)?
   - Are there architectural violations? (e.g., presentation layer directly accessing data layer, circular dependencies between modules)
   - Is there proper separation of concerns?
   - Are there god objects or god modules that do too much?

   ### SOLID / OOP Principles
   - **SRP**: Classes/modules with multiple unrelated responsibilities
   - **OCP**: Code that requires modification instead of extension for new features
   - **LSP**: Subtypes that don't properly substitute for their base types
   - **ISP**: Interfaces/contracts that force implementations to depend on methods they don't use
   - **DIP**: High-level modules directly depending on low-level modules instead of abstractions

   ### Security
   - Injection vulnerabilities (SQL, XSS, command), hardcoded secrets/credentials, auth bypasses, insecure crypto, path traversal, SSRF, unsafe deserialization

   ### Bugs & Logic
   - Null/undefined errors, race conditions, logic errors, unhandled edge cases, off-by-one errors, resource leaks, incorrect error handling, incorrect algorithms

   ### Performance
   - N+1 queries, unnecessary re-renders, missing memoization, blocking I/O in hot paths, unbounded data structures, missing pagination

## Rules

- Only report findings you are >80% confident about. No speculative or low-confidence issues.
- Focus on architecture, SOLID violations, bugs, and security over style nits.
- Each finding MUST reference a specific file and line number. Do not report vague or file-level issues.
- Limit to the 25 most important findings, ranked by severity.
- Do NOT modify any files. This is a read-only review.
- Be HONEST about the overall quality. A codebase with serious issues should score low.

## Scoring Guidelines

After your analysis, provide an honest overall quality score (0-100) and letter grade:
- **A (90-100)**: Excellent — clean architecture, minimal issues, well-tested, follows best practices
- **B (80-89)**: Good — solid code with minor issues, mostly well-structured
- **C (70-79)**: Adequate — functional but has notable quality issues that should be addressed
- **D (60-69)**: Below average — significant issues in architecture, testing, or code quality
- **F (0-59)**: Poor — serious problems: security vulnerabilities, broken architecture, major bugs, or unmaintainable code

Consider ALL findings (both CLI tool findings and your own) when determining the score. The score should reflect the overall state of the codebase honestly. A project with 50+ linting errors, formatting issues, complex functions, AND architectural problems should NOT score above 70.

## Output

After your analysis, output EXACTLY one JSON code block with your findings. No other text after the JSON block.

\`\`\`json
{
  "score": 72,
  "grade": "C",
  "scoreRationale": "Brief explanation of why this score was given, referencing key issues",
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "category": "architecture|oop|security|bugs|performance|logic",
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
const VALID_CATEGORIES = new Set(['architecture', 'oop', 'security', 'bugs', 'performance', 'logic', 'maintainability']);

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

export interface CodeReviewResult {
  findings: CodeReviewFinding[];
  summary: string;
  score: number | null;
  grade: string | null;
  scoreRationale: string | null;
}

export function parseCodeReviewResponse(response: string): CodeReviewResult {
  const jsonStr = extractJson(response);

  try {
    const parsed = JSON.parse(jsonStr);
    const rawFindings: Record<string, unknown>[] = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings = rawFindings.map(normalizeFinding).filter((f): f is CodeReviewFinding => f !== null);
    const summary = typeof parsed.summary === 'string' ? parsed.summary : `Found ${findings.length} issue(s).`;
    const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : null;
    const grade = typeof parsed.grade === 'string' ? parsed.grade : null;
    const scoreRationale = typeof parsed.scoreRationale === 'string' ? parsed.scoreRationale : null;
    return { findings, summary, score, grade, scoreRationale };
  } catch {
    return { findings: [], summary: 'Failed to parse code review results.', score: null, grade: null, scoreRationale: null };
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

    // Load CLI findings from the existing report to pass to the AI reviewer
    let cliFindings: Array<{ severity: string; category: string; file: string; line: number | null; title: string; description: string }> | undefined;
    try {
      const persistence = getPersistence(workingDir);
      const existingReport = persistence.loadReport(reportPath);
      if (existingReport?.findings) {
        cliFindings = existingReport.findings;
      }
    } catch {
      // Continue without CLI findings if persistence fails
    }

    const runner = new HeadlessRunner({
      workingDir: dirPath,
      directPrompt: buildCodeReviewPrompt(dirPath, cliFindings),
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
    const reviewResult = parseCodeReviewResponse(responseText);

    // Use AI-determined score if available, otherwise fall back to recomputation
    let updatedResults: import('./quality-service.js').QualityResults | null = null;
    try {
      const persistence = getPersistence(workingDir);
      const existingReport = persistence.loadReport(reportPath);
      if (existingReport) {
        if (reviewResult.score !== null && reviewResult.grade !== null) {
          // Use the AI-determined score and grade directly
          updatedResults = {
            ...existingReport,
            overall: reviewResult.score,
            grade: reviewResult.grade,
            codeReview: reviewResult.findings as unknown as typeof existingReport.codeReview,
            scoreRationale: reviewResult.scoreRationale ?? undefined,
          };
        } else {
          // Fallback: recompute with weighted formula
          updatedResults = recomputeWithAiReview(existingReport, reviewResult.findings);
          updatedResults = { ...updatedResults, codeReview: reviewResult.findings as unknown as typeof updatedResults.codeReview };
        }
        persistence.saveReport(reportPath, updatedResults);
        persistence.appendHistory(updatedResults, reportPath);
      }
      persistence.saveCodeReview(reportPath, reviewResult.findings as unknown as Record<string, unknown>[], reviewResult.summary);
    } catch {
      // Persistence failure should not break the review flow
    }

    ctx.send(ws, {
      type: 'qualityCodeReview',
      data: { path: reportPath, findings: reviewResult.findings, summary: reviewResult.summary, results: updatedResults },
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
