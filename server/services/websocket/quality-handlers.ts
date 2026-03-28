// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { join } from 'node:path';
import { runWithFileLogger } from '../../cli/headless/headless-logger.js';
import { HeadlessRunner } from '../../cli/headless/index.js';
import type { ToolUseEvent } from '../../cli/headless/types.js';
import type { HandlerContext } from './handler-context.js';
import { QualityPersistence } from './quality-persistence.js';
import { detectTools, installTools, runQualityScan } from './quality-service.js';
import type { WebSocketMessage, WSContext } from './types.js';

const TOOL_MESSAGES: Record<string, string> = {
  Read: 'Reading files to understand issues...',
  Edit: 'Applying fixes...',
  Write: 'Writing fixes...',
  Grep: 'Searching for related code...',
  Bash: 'Running verification...',
};

function createToolProgressCallback(ctx: HandlerContext, ws: WSContext, reportPath: string) {
  const seenTools = new Set<string>();
  return (event: ToolUseEvent) => {
    if (event.type === 'tool_start' && event.toolName && !seenTools.has(event.toolName)) {
      seenTools.add(event.toolName);
      const message = TOOL_MESSAGES[event.toolName];
      if (message) {
        ctx.send(ws, { type: 'qualityFixProgress', data: { path: reportPath, message } });
      }
    }
    if (event.type === 'tool_complete' && event.toolName === 'Edit' && event.completeInput?.file_path) {
      ctx.send(ws, {
        type: 'qualityFixProgress',
        data: { path: reportPath, message: `Fixed ${String(event.completeInput.file_path).split('/').slice(-2).join('/')}` },
      });
    }
  };
}

const persistenceCache = new Map<string, QualityPersistence>();
const activeReviews = new Set<string>();

function getPersistence(workingDir: string): QualityPersistence {
  let persistence = persistenceCache.get(workingDir);
  if (!persistence) {
    persistence = new QualityPersistence(workingDir);
    persistenceCache.set(workingDir, persistence);
  }
  return persistence;
}

export function handleQualityMessage(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  _tabId: string,
  workingDir: string,
): void {
  const handlers: Record<string, () => void> = {
    qualityDetectTools: () => handleDetectTools(ctx, ws, msg, workingDir),
    qualityScan: () => handleScan(ctx, ws, msg, workingDir),
    qualityInstallTools: () => handleInstallTools(ctx, ws, msg, workingDir),
    qualityCodeReview: () => handleCodeReview(ctx, ws, msg, workingDir),
    qualityFixIssues: () => handleFixIssues(ctx, ws, msg, workingDir),
    qualityLoadState: () => handleLoadState(ctx, ws, workingDir),
    qualitySaveDirectories: () => handleSaveDirectories(ctx, ws, msg, workingDir),
  };

  const handler = handlers[msg.type];
  if (!handler) return;

  try {
    handler();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: msg.data?.path || workingDir, error: errMsg },
    });
  }
}

function resolvePath(workingDir: string, dirPath?: string): string {
  if (!dirPath || dirPath === '.' || dirPath === './') return workingDir;
  if (dirPath.startsWith('/')) return dirPath;
  return join(workingDir, dirPath);
}

async function handleLoadState(
  ctx: HandlerContext,
  ws: WSContext,
  workingDir: string,
): Promise<void> {
  try {
    const persistence = getPersistence(workingDir);
    const state = persistence.loadState();
    ctx.send(ws, {
      type: 'qualityStateLoaded',
      data: state,
    });
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: '.', error: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function handleSaveDirectories(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  workingDir: string,
): Promise<void> {
  try {
    const persistence = getPersistence(workingDir);
    const directories: Array<{ path: string; label: string }> = msg.data?.directories || [];
    persistence.saveConfig(directories);
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: '.', error: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function handleDetectTools(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  workingDir: string,
): Promise<void> {
  const dirPath = resolvePath(workingDir, msg.data?.path);
  try {
    const { tools, ecosystem } = await detectTools(dirPath);
    ctx.send(ws, {
      type: 'qualityToolsDetected',
      data: { path: msg.data?.path || '.', tools, ecosystem },
    });
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: msg.data?.path || '.', error: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function handleScan(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  workingDir: string,
): Promise<void> {
  const dirPath = resolvePath(workingDir, msg.data?.path);
  const reportPath = msg.data?.path || '.';

  try {
    // Detect installed tools so the scan can skip unavailable categories
    const { tools: detectedTools } = await detectTools(dirPath);
    const installedToolNames = detectedTools.filter((t) => t.installed).map((t) => t.name);

    const results = await runQualityScan(dirPath, (progress) => {
      ctx.send(ws, {
        type: 'qualityScanProgress',
        data: { path: reportPath, progress },
      });
    }, installedToolNames);
    ctx.send(ws, {
      type: 'qualityScanResults',
      data: { path: reportPath, results },
    });

    // Persist report and append to history
    try {
      const persistence = getPersistence(workingDir);
      persistence.saveReport(reportPath, results);
      persistence.appendHistory(results, reportPath);
    } catch {
      // Persistence failure should not break the scan flow
    }
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: reportPath, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function handleInstallTools(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  workingDir: string,
): Promise<void> {
  const dirPath = resolvePath(workingDir, msg.data?.path);
  const reportPath = msg.data?.path || '.';
  const toolNames: string[] | undefined = msg.data?.tools;

  try {
    ctx.send(ws, {
      type: 'qualityInstallProgress',
      data: { path: reportPath, installing: true },
    });

    const { tools, ecosystem } = await installTools(dirPath, toolNames);

    ctx.send(ws, {
      type: 'qualityInstallComplete',
      data: { path: reportPath, tools, ecosystem },
    });
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: reportPath, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

// ============================================================================
// Code Review Agent
// ============================================================================

function buildCodeReviewPrompt(dirPath: string): string {
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

interface CodeReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'security' | 'bugs' | 'performance' | 'maintainability';
  file: string;
  line: number | null;
  title: string;
  description: string;
  suggestion?: string;
}

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
  // Try ```json ... ``` first, then plain ``` ... ```, then largest {...} block
  const fencedJson = response.match(/```json\s*([\s\S]*?)```/);
  if (fencedJson) return fencedJson[1].trim();

  const fencedPlain = response.match(/```\s*([\s\S]*?)```/);
  if (fencedPlain) return fencedPlain[1].trim();

  const braceMatch = response.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0].trim();

  return response.trim();
}

function parseCodeReviewResponse(response: string): { findings: CodeReviewFinding[]; summary: string } {
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

async function handleCodeReview(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  workingDir: string,
): Promise<void> {
  const dirPath = resolvePath(workingDir, msg.data?.path);
  const reportPath = msg.data?.path || '.';

  if (activeReviews.has(dirPath)) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: reportPath, error: 'A code review is already running for this directory.' },
    });
    return;
  }

  activeReviews.add(dirPath);
  try {
    // Send initial progress
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

    ctx.send(ws, {
      type: 'qualityCodeReview',
      data: { path: reportPath, findings, summary },
    });

    // Persist code review results
    try {
      const persistence = getPersistence(workingDir);
      persistence.saveCodeReview(reportPath, findings as unknown as Record<string, unknown>[], summary);
    } catch {
      // Persistence failure should not break the review flow
    }
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: reportPath, error: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    activeReviews.delete(dirPath);
  }
}

// ============================================================================
// Fix Issues Agent
// ============================================================================

interface FindingForFix {
  severity: string;
  category: string;
  file: string;
  line: number | null;
  title: string;
  description: string;
  suggestion?: string;
}

function buildFixPrompt(findings: FindingForFix[], section?: string): string {
  const filtered = section ? findings.filter((f) => f.category === section) : findings;
  const sorted = filtered.sort((a, b) => {
    const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
  });

  const issueList = sorted.slice(0, 30).map((f, i) => {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    const parts = [`${i + 1}. [${f.severity.toUpperCase()}] ${loc} — ${f.title}`];
    if (f.description) parts.push(`   ${f.description}`);
    if (f.suggestion) parts.push(`   Suggestion: ${f.suggestion}`);
    return parts.join('\n');
  }).join('\n\n');

  return `You are a code quality fix agent. Fix the following quality issues in the codebase.

## Issues to Fix (${sorted.length} total, showing top ${Math.min(30, sorted.length)})

${issueList}

## Rules

- Fix each issue by editing the relevant file at the specified location.
- For complexity issues: refactor into smaller functions. For long files: split or extract modules. For long functions: break into smaller functions.
- For security issues: apply the suggested fix or use secure coding best practices.
- For bugs: fix the root cause, not just the symptom.
- For linting/formatting: apply the standard for the project.
- Do NOT introduce new issues. Make minimal, focused changes.
- After fixing, verify the changes compile/pass linting if tools are available.
- Work through the issues systematically from most to least severe.`;
}

const activeFixes = new Set<string>();

async function handleFixIssues(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  workingDir: string,
): Promise<void> {
  const dirPath = resolvePath(workingDir, msg.data?.path);
  const reportPath = msg.data?.path || '.';
  const section: string | undefined = msg.data?.section;
  const findings: FindingForFix[] = msg.data?.findings || [];

  if (activeFixes.has(dirPath)) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: reportPath, error: 'A fix operation is already running for this directory.' },
    });
    return;
  }

  if (findings.length === 0) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: reportPath, error: 'No findings to fix.' },
    });
    return;
  }

  activeFixes.add(dirPath);
  try {
    ctx.send(ws, {
      type: 'qualityFixProgress',
      data: { path: reportPath, message: 'Starting Claude Code to fix issues...' },
    });

    const prompt = buildFixPrompt(findings, section);

    const runner = new HeadlessRunner({
      workingDir: dirPath,
      directPrompt: prompt,
      stallWarningMs: 120_000,
      stallKillMs: 600_000,
      stallHardCapMs: 900_000,
      toolUseCallback: createToolProgressCallback(ctx, ws, reportPath),
    });

    await runWithFileLogger('code-review-fix', () => runner.run());

    ctx.send(ws, {
      type: 'qualityFixProgress',
      data: { path: reportPath, message: 'Fixes applied. Re-running quality checks...' },
    });

    // Re-run quality scan after fixing
    const { tools: detectedTools } = await detectTools(dirPath);
    const installedToolNames = detectedTools.filter((t) => t.installed).map((t) => t.name);

    const results = await runQualityScan(dirPath, (progress) => {
      ctx.send(ws, {
        type: 'qualityScanProgress',
        data: { path: reportPath, progress },
      });
    }, installedToolNames);

    ctx.send(ws, {
      type: 'qualityFixComplete',
      data: { path: reportPath, results },
    });

    // Persist
    try {
      const persistence = getPersistence(workingDir);
      persistence.saveReport(reportPath, results);
      persistence.appendHistory(results, reportPath);
    } catch {
      // Persistence failure should not break the fix flow
    }
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: reportPath, error: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    activeFixes.delete(dirPath);
  }
}
