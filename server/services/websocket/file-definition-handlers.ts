// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { spawn } from 'node:child_process';
import { join, relative } from 'node:path';
import type { HandlerContext } from './handler-context.js';
import type { WebSocketMessage, WSContext } from './types.js';

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

export function handleFindDefinition(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  const symbol = msg.data?.symbol;
  const language = msg.data?.language || 'typescript';
  const currentFile = msg.data?.currentFile || '';

  if (!symbol) {
    ctx.send(ws, { type: 'definitionResult', tabId, data: { definitions: [], symbol: '' } });
    return;
  }

  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
