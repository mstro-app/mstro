// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Progress log writer: ensures output directories exist and appends
 * per-wave markdown entries to the board or PM-dir progress.md.
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateIssuePath, type WarnFn } from './issue-writer.js';
import type { Issue } from './types.js';

/** Create the board's or PM dir's `out/` directory if it doesn't exist. */
export async function ensureOutputDirs(pmDir: string | null, boardDir: string | null): Promise<void> {
  if (boardDir) {
    const boardOutDir = join(boardDir, 'out');
    if (!existsSync(boardOutDir)) await mkdir(boardOutDir, { recursive: true });
    return;
  }
  if (pmDir) {
    const outDir = join(pmDir, 'out');
    if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
  }
}

/**
 * Append a wave summary section to progress.md (creating the file with a
 * `# Board Progress` header if missing). Reads each issue's on-disk status
 * to partition completed vs failed.
 */
export async function appendProgressEntry(
  pmDir: string | null,
  boardDir: string | null,
  issues: Issue[],
  waveStart: number,
  warn: WarnFn,
): Promise<void> {
  if (!pmDir) return;

  const progressPath = boardDir ? join(boardDir, 'progress.md') : join(pmDir, 'progress.md');
  const durationMin = Math.round((Date.now() - waveStart) / 60_000);
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);

  const { completed, failed } = await partitionByOnDiskStatus(pmDir, issues);

  const lines = [
    '',
    `## ${timestamp} — Wave [${issues.map(i => i.id).join(', ')}]`,
    '',
    `- **Duration**: ${durationMin} min`,
    `- **Completed**: ${completed.length}/${issues.length}${completed.length > 0 ? ` (${completed.join(', ')})` : ''}`,
  ];
  if (failed.length > 0) {
    lines.push(`- **Failed**: ${failed.join(', ')}`);
  }
  lines.push('');

  await writeProgressLines(progressPath, lines, warn);
}

async function partitionByOnDiskStatus(
  pmDir: string,
  issues: Issue[],
): Promise<{ completed: string[]; failed: string[] }> {
  const completed: string[] = [];
  const failed: string[] = [];
  for (const issue of issues) {
    try {
      const content = await readFile(validateIssuePath(issue.path, pmDir), 'utf-8');
      const statusMatch = content.match(/^status:\s*(\S+)/m);
      if (statusMatch?.[1] === 'done') completed.push(issue.id);
      else failed.push(issue.id);
    } catch {
      failed.push(issue.id);
    }
  }
  return { completed, failed };
}

async function writeProgressLines(filePath: string, lines: string[], warn: WarnFn): Promise<void> {
  try {
    if (existsSync(filePath)) {
      await appendFile(filePath, `\n${lines.join('\n')}`, 'utf-8');
    } else {
      await writeFile(filePath, `# Board Progress\n${lines.join('\n')}`, 'utf-8');
    }
  } catch (err) {
    warn(`Warning: failed to write progress log: ${err instanceof Error ? err.message : String(err)}`);
  }
}
