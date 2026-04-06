// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Quality Fix Agent — AI-powered issue fixing using Claude Code headless runner.
 *
 * Builds the fix prompt, runs the agent, re-scans, and persists updated results.
 */

import { runWithFileLogger } from '../../cli/headless/headless-logger.js';
import { HeadlessRunner } from '../../cli/headless/index.js';
import type { ToolUseEvent } from '../../cli/headless/types.js';
import type { HandlerContext } from './handler-context.js';
import type { QualityPersistence } from './quality-persistence.js';
import { detectTools, runQualityScan } from './quality-service.js';
import type { WSContext } from './types.js';

// ── Types ─────────────────────────────────────────────────────

export interface FindingForFix {
  severity: string;
  category: string;
  file: string;
  line: number | null;
  title: string;
  description: string;
  suggestion?: string;
}

// ── Progress callback ─────────────────────────────────────────

const TOOL_MESSAGES: Record<string, string> = {
  Read: 'Reading files to understand issues...',
  Edit: 'Applying fixes...',
  Write: 'Writing fixes...',
  Grep: 'Searching for related code...',
  Bash: 'Running verification...',
};

export function createToolProgressCallback(ctx: HandlerContext, ws: WSContext, reportPath: string) {
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

// ── Prompt ────────────────────────────────────────────────────

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

// ── Handler ───────────────────────────────────────────────────

const activeFixes = new Set<string>();

export async function handleFixIssues(
  ctx: HandlerContext,
  ws: WSContext,
  reportPath: string,
  dirPath: string,
  workingDir: string,
  section: string | undefined,
  findings: FindingForFix[],
  getPersistence: (dir: string) => QualityPersistence,
  sandboxed?: boolean,
): Promise<void> {
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
      sandboxed,
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
