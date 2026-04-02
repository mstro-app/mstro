// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { spawn } from 'node:child_process';
import { relative } from 'node:path';
import type { HandlerContext } from './handler-context.js';
import type { WebSocketMessage, WSContext } from './types.js';

type SearchMatch = { filePath: string; line: number; column: number; lineContent: string; contextBefore: string[]; contextAfter: string[] };

function appendGlobArgs(args: string[], globStr: string, prefix: string): void {
  for (const glob of globStr.split(',')) {
    const trimmed = glob.trim();
    if (trimmed) args.push('--glob', `${prefix}${trimmed}`);
  }
}

function buildRgArgs(query: string, options: Record<string, unknown>): string[] {
  const args: string[] = ['--json', '--no-heading'];
  if (!options.caseSensitive) args.push('-i');
  if (options.wholeWord) args.push('-w');
  if (!options.regex) args.push('-F');
  args.push('-C', options.contextLines !== undefined ? String(options.contextLines) : '1');
  if (options.includeGlob) appendGlobArgs(args, options.includeGlob as string, '');
  if (options.excludeGlob) appendGlobArgs(args, options.excludeGlob as string, '!');
  args.push('--', query, '.');
  return args;
}

/** Process a single JSON line from rg output. Returns true if search should stop (maxResults reached). */
function processRgSearchLine(
  line: string,
  workingDir: string,
  batch: SearchMatch[],
  seenFiles: Set<string>,
  contextMap: Map<string, { before: string[]; after: string[] }>,
  counters: { totalMatches: number; fileCount: number },
  maxResults: number,
  flushBatch: () => void,
): boolean {
  try {
    const parsed = JSON.parse(line);
    if (parsed.type === 'match') {
      return processRgMatch(parsed, workingDir, batch, seenFiles, contextMap, counters, maxResults, flushBatch);
    }
    if (parsed.type === 'context') {
      appendRgContext(parsed, workingDir, batch);
    }
  } catch {
    // Skip malformed JSON lines
  }
  return false;
}

function processRgMatch(
  parsed: { data: { path: { text: string }; line_number: number; lines: { text: string }; submatches?: Array<{ start: number }> } },
  workingDir: string,
  batch: SearchMatch[],
  seenFiles: Set<string>,
  contextMap: Map<string, { before: string[]; after: string[] }>,
  counters: { totalMatches: number; fileCount: number },
  maxResults: number,
  flushBatch: () => void,
): boolean {
  const filePath = relative(workingDir, parsed.data.path.text);
  const lineNumber = parsed.data.line_number;
  const lineContent = parsed.data.lines.text.replace(/\n$/, '');
  const column = parsed.data.submatches?.[0]?.start ?? 0;

  if (!seenFiles.has(filePath)) {
    seenFiles.add(filePath);
    counters.fileCount++;
  }
  counters.totalMatches++;

  const key = `${filePath}:${lineNumber}`;
  const ctxLines = contextMap.get(key) || { before: [], after: [] };
  batch.push({ filePath, line: lineNumber, column: column + 1, lineContent, contextBefore: ctxLines.before, contextAfter: [] });

  if (counters.totalMatches >= maxResults) {
    flushBatch();
    return true;
  }
  if (batch.length >= 50) flushBatch();
  return false;
}

function appendRgContext(
  parsed: { data: { path: { text: string }; line_number: number; lines: { text: string } } },
  workingDir: string,
  batch: SearchMatch[],
): void {
  const filePath = relative(workingDir, parsed.data.path.text);
  const lineNumber = parsed.data.line_number;
  const lineContent = parsed.data.lines.text.replace(/\n$/, '');

  const lastMatch = batch[batch.length - 1];
  if (!lastMatch || lastMatch.filePath !== filePath) return;
  if (lineNumber < lastMatch.line) {
    lastMatch.contextBefore.push(lineContent);
  } else {
    lastMatch.contextAfter.push(lineContent);
  }
}

export function handleSearchFileContents(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  const query = msg.data?.query;
  if (!query) {
    ctx.send(ws, { type: 'contentSearchError', tabId, data: { error: 'Search query is required' } });
    return;
  }

  handleCancelSearch(ctx, tabId);

  const options = msg.data.options || {};
  const startTime = Date.now();
  let totalMatches = 0;
  let fileCount = 0;
  const seenFiles = new Set<string>();
  const maxResults = options.maxResults || 5000;
  let batch: SearchMatch[] = [];

  const args = buildRgArgs(query, options);

  const rgProcess = spawn('rg', args, { cwd: workingDir, stdio: ['ignore', 'pipe', 'pipe'] });
  ctx.activeSearches.set(tabId, rgProcess);

  let buffer = '';
  const contextMap = new Map<string, { before: string[]; after: string[] }>();

  const flushBatch = () => {
    if (batch.length > 0) {
      ctx.send(ws, { type: 'contentSearchResults', tabId, data: { matches: batch, partial: true } });
      batch = [];
    }
  };

  const searchState = { totalMatches, fileCount };

  rgProcess.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      if (processRgSearchLine(line, workingDir, batch, seenFiles, contextMap, searchState, maxResults, flushBatch)) {
        rgProcess.kill();
        return;
      }
    }
    totalMatches = searchState.totalMatches;
    fileCount = searchState.fileCount;
  });

  rgProcess.stderr?.on('data', (chunk: Buffer) => {
    const errText = chunk.toString().trim();
    if (errText && !errText.includes('No files were searched')) {
      console.error(`[Search] rg stderr: ${errText}`);
    }
  });

  rgProcess.on('close', (_code) => {
    ctx.activeSearches.delete(tabId);
    flushBatch();

    ctx.send(ws, {
      type: 'contentSearchComplete',
      tabId,
      data: {
        totalMatches,
        fileCount,
        truncated: totalMatches >= maxResults,
        durationMs: Date.now() - startTime,
      },
    });
  });

  rgProcess.on('error', (err) => {
    ctx.activeSearches.delete(tabId);
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      handleSearchFallback(ctx, ws, query, options, tabId, workingDir);
    } else {
      ctx.send(ws, { type: 'contentSearchError', tabId, data: { error: err.message } });
    }
  });
}

/** Process a single grep output line. Returns true if search should stop. */
function processGrepLine(
  line: string,
  batch: SearchMatch[],
  seenFiles: Set<string>,
  counters: { totalMatches: number; fileCount: number },
  maxResults: number,
  flushBatch: () => void,
): boolean {
  const match = line.match(/^\.\/(.+?):(\d+):(.*)$/);
  if (!match) return false;

  const filePath = match[1];
  const lineNumber = parseInt(match[2], 10);
  const lineContent = match[3];

  if (!seenFiles.has(filePath)) {
    seenFiles.add(filePath);
    counters.fileCount++;
  }
  counters.totalMatches++;

  batch.push({ filePath, line: lineNumber, column: 1, lineContent, contextBefore: [], contextAfter: [] });

  if (counters.totalMatches >= maxResults) {
    flushBatch();
    return true;
  }
  if (batch.length >= 50) flushBatch();
  return false;
}

function handleSearchFallback(ctx: HandlerContext, ws: WSContext, query: string, options: Record<string, unknown>, tabId: string, workingDir: string): void {
  const startTime = Date.now();
  const args: string[] = ['-rn'];
  if (!options.caseSensitive) args.push('-i');
  if (options.includeGlob) {
    for (const glob of String(options.includeGlob).split(',')) {
      const trimmed = glob.trim();
      if (trimmed) args.push(`--include=${trimmed}`);
    }
  }
  args.push('--', query, '.');

  const grepProcess = spawn('grep', args, { cwd: workingDir, stdio: ['ignore', 'pipe', 'pipe'] });
  ctx.activeSearches.set(tabId, grepProcess);

  let buffer = '';
  let totalMatches = 0;
  let fileCount = 0;
  const seenFiles = new Set<string>();
  const maxResults = (options.maxResults as number) || 5000;
  let batch: SearchMatch[] = [];
  const grepState = { totalMatches, fileCount };

  const flushGrepBatch = () => {
    if (batch.length > 0) {
      ctx.send(ws, { type: 'contentSearchResults', tabId, data: { matches: batch, partial: true } });
      batch = [];
    }
  };

  grepProcess.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      if (processGrepLine(line, batch, seenFiles, grepState, maxResults, flushGrepBatch)) {
        grepProcess.kill();
        return;
      }
    }
    totalMatches = grepState.totalMatches;
    fileCount = grepState.fileCount;
  });

  grepProcess.on('close', () => {
    ctx.activeSearches.delete(tabId);
    if (batch.length > 0) {
      ctx.send(ws, { type: 'contentSearchResults', tabId, data: { matches: batch, partial: true } });
    }
    ctx.send(ws, {
      type: 'contentSearchComplete',
      tabId,
      data: { totalMatches, fileCount, truncated: totalMatches >= maxResults, durationMs: Date.now() - startTime },
    });
  });

  grepProcess.on('error', (err) => {
    ctx.activeSearches.delete(tabId);
    ctx.send(ws, { type: 'contentSearchError', tabId, data: { error: `Search unavailable: ${err.message}` } });
  });
}

export function handleCancelSearch(ctx: HandlerContext, tabId: string): void {
  const process = ctx.activeSearches.get(tabId);
  if (process) {
    process.kill();
    ctx.activeSearches.delete(tabId);
  }
}
