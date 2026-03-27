// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { join } from 'node:path';
import { HeadlessRunner } from '../../cli/headless/index.js';
import type { HandlerContext } from './handler-context.js';
import { QualityPersistence } from './quality-persistence.js';
import { detectTools, installTools, runQualityScan } from './quality-service.js';
import type { WebSocketMessage, WSContext } from './types.js';

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
    const results = await runQualityScan(dirPath, (progress) => {
      ctx.send(ws, {
        type: 'qualityScanProgress',
        data: { path: reportPath, progress },
      });
    });
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

const CODE_REVIEW_PROMPT = `You are an expert code review agent. Your task is to perform a comprehensive, language-agnostic code review of the project in the current working directory.

## Review Process

1. **Discover**: Use Glob to find source files (e.g. "src/**/*.{ts,tsx,js,py,rs,go,java,rb,php}"). Understand the project structure.
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
    const runner = new HeadlessRunner({
      workingDir: dirPath,
      directPrompt: CODE_REVIEW_PROMPT,
      stallWarningMs: 120_000,
      stallKillMs: 600_000,
      stallHardCapMs: 900_000,
    });

    const result = await runner.run();

    const responseText = result.assistantResponse || '';
    const { findings, summary } = parseCodeReviewResponse(responseText);

    ctx.send(ws, {
      type: 'qualityCodeReview',
      data: { path: reportPath, findings, summary },
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
