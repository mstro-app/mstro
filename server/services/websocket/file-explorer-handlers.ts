// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { spawn } from 'node:child_process';
import { join, relative } from 'node:path';
import {
  createDirectory,
  createFile,
  deleteFile,
  listDirectory,
  renameFile,
  writeFile
} from '../files.js';
import { validatePathWithinWorkingDir } from '../pathUtils.js';
import { readFileContent } from './file-utils.js';
import type { HandlerContext } from './handler-context.js';
import type { WebSocketMessage, WebSocketResponse, WSContext } from './types.js';

export function handleFileMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'control' | 'view'): void {
  switch (msg.type) {
    case 'autocomplete':
      if (!msg.data?.partialPath) throw new Error('Partial path is required');
      ctx.send(ws, { type: 'autocomplete', tabId, data: { completions: ctx.autocompleteService.getFileCompletions(msg.data.partialPath, workingDir) } });
      break;
    case 'readFile':
      handleReadFile(ctx, ws, msg, tabId, workingDir, permission);
      break;
    case 'recordSelection':
      if (msg.data?.filePath) ctx.recordFileSelection(msg.data.filePath);
      break;
  }
}

function handleReadFile(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'control' | 'view'): void {
  if (!msg.data?.filePath) throw new Error('File path is required');
  const isSandboxed = permission === 'control' || permission === 'view';
  if (isSandboxed) {
    const validation = validatePathWithinWorkingDir(msg.data.filePath, workingDir);
    if (!validation.valid) {
      ctx.send(ws, { type: 'fileContent', tabId, data: { path: msg.data.filePath, fileName: msg.data.filePath.split('/').pop() || '', content: '', error: 'Sandboxed: path outside project directory' } });
      return;
    }
  }
  ctx.send(ws, { type: 'fileContent', tabId, data: readFileContent(msg.data.filePath, workingDir) });
}

function sendFileResult(ctx: HandlerContext, ws: WSContext, type: WebSocketResponse['type'], tabId: string, result: { success: boolean; path?: string; error?: string }, successData?: Record<string, unknown>): void {
  const data = result.success
    ? { success: true, path: result.path, ...successData }
    : { success: false, path: result.path, error: result.error };
  ctx.send(ws, { type, tabId, data });
}

export function handleFileExplorerMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'control' | 'view'): void {
  const isSandboxed = permission === 'control' || permission === 'view';
  const handlers: Record<string, () => void> = {
    listDirectory: () => {
      if (isSandboxed && msg.data?.dirPath) {
        const validation = validatePathWithinWorkingDir(msg.data.dirPath, workingDir);
        if (!validation.valid) {
          ctx.send(ws, { type: 'directoryListing', tabId, data: { success: false, path: msg.data.dirPath, error: 'Sandboxed: path outside project directory' } });
          return;
        }
      }
      handleListDirectory(ctx, ws, msg, tabId, workingDir);
    },
    writeFile: () => handleWriteFile(ctx, ws, msg, tabId, workingDir),
    createFile: () => handleCreateFile(ctx, ws, msg, tabId, workingDir),
    createDirectory: () => handleCreateDirectory(ctx, ws, msg, tabId, workingDir),
    deleteFile: () => handleDeleteFile(ctx, ws, msg, tabId, workingDir),
    renameFile: () => handleRenameFile(ctx, ws, msg, tabId, workingDir),
    notifyFileOpened: () => handleNotifyFileOpened(ctx, ws, msg, workingDir),
    searchFileContents: () => handleSearchFileContents(ctx, ws, msg, tabId, workingDir),
    cancelSearch: () => handleCancelSearch(ctx, tabId),
    findDefinition: () => handleFindDefinition(ctx, ws, msg, tabId, workingDir),
  };
  const handler = handlers[msg.type];
  if (!handler) return;

  try {
    handler();
  } catch (error: unknown) {
    // Send a domain-specific fileError so the web client can resolve pending
    // promises instead of letting the generic handler send { type: 'error' }
    // which no file-explorer listener handles (causing orphaned promises).
    const errorMessage = error instanceof Error ? error.message : String(error);
    ctx.send(ws, {
      type: 'fileError',
      tabId,
      data: { operation: msg.type, path: msg.data?.dirPath || msg.data?.filePath || '', error: errorMessage },
    });
  }
}

function handleListDirectory(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  if (msg.data?.dirPath === undefined) throw new Error('Directory path is required');
  const result = listDirectory(msg.data.dirPath, workingDir, msg.data.showHidden ?? false);
  ctx.send(ws, { type: 'directoryListing', tabId, data: result.success ? { success: true, path: msg.data.dirPath, entries: result.entries } : { success: false, path: msg.data.dirPath, error: result.error } });
}

function handleWriteFile(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  if (!msg.data?.filePath) throw new Error('File path is required');
  if (msg.data.content === undefined) throw new Error('Content is required');
  const result = writeFile(msg.data.filePath, msg.data.content, workingDir);
  sendFileResult(ctx, ws, 'fileWritten', tabId, result);
  if (result.success) {
    ctx.broadcastToOthers(ws, {
      type: 'fileContentChanged',
      data: { path: result.path, content: msg.data.content }
    });
  }
}

function handleCreateFile(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  if (!msg.data?.filePath) throw new Error('File path is required');
  const result = createFile(msg.data.filePath, workingDir);
  sendFileResult(ctx, ws, 'fileCreated', tabId, result);
  if (result.success && result.path) {
    const name = result.path.split('/').pop() || 'unknown';
    ctx.broadcastToOthers(ws, {
      type: 'fileCreated',
      data: { path: result.path, name, size: 0, modifiedAt: new Date().toISOString() }
    });
  }
}

function handleCreateDirectory(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  if (!msg.data?.dirPath) throw new Error('Directory path is required');
  const result = createDirectory(msg.data.dirPath, workingDir);
  sendFileResult(ctx, ws, 'directoryCreated', tabId, result);
  if (result.success && result.path) {
    const name = result.path.split('/').pop() || 'unknown';
    ctx.broadcastToOthers(ws, {
      type: 'directoryCreated',
      data: { path: result.path, name }
    });
  }
}

function handleDeleteFile(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  if (!msg.data?.filePath) throw new Error('File path is required');
  const result = deleteFile(msg.data.filePath, workingDir);
  sendFileResult(ctx, ws, 'fileDeleted', tabId, result);
  if (result.success && result.path) {
    ctx.broadcastToOthers(ws, {
      type: 'fileDeleted',
      data: { path: result.path }
    });
  }
}

function handleRenameFile(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  if (!msg.data?.oldPath) throw new Error('Old path is required');
  if (!msg.data?.newPath) throw new Error('New path is required');
  const result = renameFile(msg.data.oldPath, msg.data.newPath, workingDir);
  const renamedName = result.path?.split('/').pop() || 'unknown';
  sendFileResult(ctx, ws, 'fileRenamed', tabId, result, { oldPath: msg.data.oldPath, newPath: result.path, name: renamedName });
  if (result.success && result.path) {
    const name = result.path.split('/').pop() || 'unknown';
    ctx.broadcastToOthers(ws, {
      type: 'fileRenamed',
      data: { oldPath: msg.data.oldPath, newPath: result.path, name }
    });
  }
}

function handleNotifyFileOpened(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, workingDir: string): void {
  if (!msg.data?.filePath) return;
  const fileData = readFileContent(msg.data.filePath, workingDir);
  if (!fileData.error) {
    ctx.broadcastToOthers(ws, {
      type: 'fileOpened',
      data: {
        path: msg.data.filePath,
        fileName: fileData.fileName,
        content: fileData.content
      }
    });
  }
}

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

type SearchMatch = { filePath: string; line: number; column: number; lineContent: string; contextBefore: string[]; contextAfter: string[] };

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

function handleSearchFileContents(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
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

function handleCancelSearch(ctx: HandlerContext, tabId: string): void {
  const process = ctx.activeSearches.get(tabId);
  if (process) {
    process.kill();
    ctx.activeSearches.delete(tabId);
  }
}

type DefinitionEntry = { filePath: string; line: number; column: number; lineContent: string; kind: string };

function classifyDefinitionKind(lineContent: string): string {
  if (/\b(function|def|func|fn)\b/.test(lineContent)) return 'function';
  if (/\bclass\b/.test(lineContent)) return 'class';
  if (/\binterface\b/.test(lineContent)) return 'interface';
  if (/\btype\b/.test(lineContent)) return 'type';
  if (/\b(enum|struct|trait)\b/.test(lineContent)) return 'enum';
  return 'variable';
}

/** Parse a single JSON line from rg definition search. Returns true if max definitions reached. */
function parseDefinitionLine(line: string, workingDir: string, definitions: DefinitionEntry[]): boolean {
  try {
    const parsed = JSON.parse(line);
    if (parsed.type !== 'match') return false;

    const filePath = relative(workingDir, join(workingDir, parsed.data.path.text));
    const lineContent = parsed.data.lines.text.replace(/\n$/, '');
    const column = parsed.data.submatches?.[0]?.start ?? 0;

    definitions.push({
      filePath,
      line: parsed.data.line_number,
      column: column + 1,
      lineContent,
      kind: classifyDefinitionKind(lineContent),
    });
    return definitions.length >= 20;
  } catch {
    return false;
  }
}

function sortDefinitionsByProximity(definitions: DefinitionEntry[], currentFile: string): void {
  const currentDir = currentFile ? currentFile.substring(0, currentFile.lastIndexOf('/')) : '';
  definitions.sort((a, b) => {
    const exactDiff = (a.filePath === currentFile ? 0 : 1) - (b.filePath === currentFile ? 0 : 1);
    if (exactDiff !== 0) return exactDiff;
    const dirDiff = (a.filePath.startsWith(`${currentDir}/`) ? 0 : 1) - (b.filePath.startsWith(`${currentDir}/`) ? 0 : 1);
    if (dirDiff !== 0) return dirDiff;
    return a.filePath.split('/').length - b.filePath.split('/').length;
  });
}

function handleFindDefinition(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  const symbol = msg.data?.symbol;
  const language = msg.data?.language || 'typescript';
  const currentFile = msg.data?.currentFile || '';

  if (!symbol) {
    ctx.send(ws, { type: 'definitionResult', tabId, data: { definitions: [], symbol: '' } });
    return;
  }

  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const DEFINITION_PATTERNS: Record<string, (s: string) => string[]> = {
    typescript: (s) => [
      `(function|const|let|var|class|interface|type|enum)\\s+${s}\\b`,
      `export\\s+(default\\s+)?(function|const|let|var|class|interface|type|enum)\\s+${s}\\b`,
    ],
    javascript: (s) => [
      `(function|const|let|var|class)\\s+${s}\\b`,
      `export\\s+(default\\s+)?(function|const|let|var|class)\\s+${s}\\b`,
    ],
    python: (s) => [
      `(def|class)\\s+${s}\\b`,
      `${s}\\s*=`,
    ],
    go: (s) => [
      `func\\s+(\\(\\w+\\s+\\*?\\w+\\)\\s+)?${s}\\b`,
      `type\\s+${s}\\b`,
      `var\\s+${s}\\b`,
    ],
    rust: (s) => [
      `(fn|struct|enum|trait|type|const|static|mod)\\s+${s}\\b`,
      `impl\\s+${s}\\b`,
    ],
    swift: (s) => [
      `(func|class|struct|enum|protocol|typealias|actor)\\s+${s}\\b`,
      `(let|var)\\s+${s}\\b`,
      `extension\\s+${s}\\b`,
    ],
    kotlin: (s) => [
      `(fun|class|object|interface|typealias|enum\\s+class)\\s+${s}\\b`,
      `(val|var)\\s+${s}\\b`,
    ],
    java: (s) => [
      `(class|interface|enum)\\s+${s}\\b`,
      `(public|private|protected|static)?\\s*(void|int|String|boolean|\\w+)\\s+${s}\\s*\\(`,
    ],
    ruby: (s) => [
      `(def|class|module)\\s+${s}\\b`,
    ],
  };

  const LANGUAGE_GLOBS: Record<string, string> = {
    typescript: '*.{ts,tsx}',
    javascript: '*.{js,jsx,mjs,cjs}',
    python: '*.py',
    go: '*.go',
    rust: '*.rs',
    swift: '*.swift',
    kotlin: '*.{kt,kts}',
    java: '*.java',
    ruby: '*.rb',
  };

  const patterns = DEFINITION_PATTERNS[language] || DEFINITION_PATTERNS.typescript;
  const combinedPattern = patterns(escapedSymbol).join('|');
  const fileGlob = LANGUAGE_GLOBS[language] || LANGUAGE_GLOBS.typescript;

  const args = [
    '--json', '-n',
    '--glob', fileGlob,
    '--glob', '!node_modules/**',
    '--glob', '!dist/**',
    '--glob', '!build/**',
    '--glob', '!.git/**',
    '--glob', '!*.min.*',
    '--glob', '!*.bundle.*',
    '-e', combinedPattern, '.',
  ];

  const rgProcess = spawn('rg', args, { cwd: workingDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let rgBuffer = '';
  const definitions: Array<{ filePath: string; line: number; column: number; lineContent: string; kind: string }> = [];

  rgProcess.stdout?.on('data', (chunk: Buffer) => {
    rgBuffer += chunk.toString();
    const lines = rgBuffer.split('\n');
    rgBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      if (parseDefinitionLine(line, workingDir, definitions)) {
        rgProcess.kill();
        return;
      }
    }
  });

  rgProcess.on('close', () => {
    sortDefinitionsByProximity(definitions, currentFile);

    ctx.send(ws, {
      type: 'definitionResult',
      tabId,
      data: { definitions: definitions.slice(0, 10), symbol },
    });
  });

  rgProcess.on('error', (_err) => {
    ctx.send(ws, { type: 'definitionResult', tabId, data: { definitions: [], symbol } });
  });
}
