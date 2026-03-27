// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface QualityTool {
  name: string;
  installed: boolean;
  installCommand: string;
  category: 'linter' | 'formatter' | 'complexity' | 'general';
}

export interface CategoryScore {
  name: string;
  score: number;
  weight: number;
  effectiveWeight: number;
  available: boolean;
  issueCount?: number;
  details?: Record<string, unknown>;
}

export interface QualityFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  file: string;
  line: number | null;
  title: string;
  description: string;
  suggestion?: string;
}

export interface QualityResults {
  overall: number;
  grade: string;
  categories: CategoryScore[];
  findings: QualityFinding[];
  codeReview: QualityFinding[];
  analyzedFiles: number;
  totalLines: number;
  timestamp: string;
  ecosystem: string[];
}

export interface ScanProgress {
  step: string;
  current: number;
  total: number;
}

type Ecosystem = 'node' | 'python' | 'rust' | 'go' | 'unknown';

interface ToolSpec {
  name: string;
  check: string[];
  category: QualityTool['category'];
  installCmd: string;
}

// ============================================================================
// Constants
// ============================================================================

const ECOSYSTEM_TOOLS: Record<Ecosystem, ToolSpec[]> = {
  node: [
    { name: 'eslint', check: ['npx', 'eslint', '--version'], category: 'linter', installCmd: 'npm install -D eslint' },
    { name: 'biome', check: ['npx', '@biomejs/biome', '--version'], category: 'linter', installCmd: 'npm install -D @biomejs/biome' },
    { name: 'prettier', check: ['npx', 'prettier', '--version'], category: 'formatter', installCmd: 'npm install -D prettier' },
    { name: 'typescript', check: ['npx', 'tsc', '--version'], category: 'general', installCmd: 'npm install -D typescript' },
  ],
  python: [
    { name: 'ruff', check: ['ruff', '--version'], category: 'linter', installCmd: 'pip install ruff' },
    { name: 'black', check: ['black', '--version'], category: 'formatter', installCmd: 'pip install black' },
    { name: 'radon', check: ['radon', '--version'], category: 'complexity', installCmd: 'pip install radon' },
  ],
  rust: [
    { name: 'clippy', check: ['cargo', 'clippy', '--version'], category: 'linter', installCmd: 'rustup component add clippy' },
    { name: 'rustfmt', check: ['rustfmt', '--version'], category: 'formatter', installCmd: 'rustup component add rustfmt' },
  ],
  go: [
    { name: 'golangci-lint', check: ['golangci-lint', '--version'], category: 'linter', installCmd: 'go install github.com/golangci-lint/golangci-lint/cmd/golangci-lint@latest' },
    { name: 'gofmt', check: ['gofmt', '-h'], category: 'formatter', installCmd: '(built-in with Go)' },
  ],
  unknown: [],
};

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi',
  '.rs',
  '.go',
  '.java', '.kt',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.c', '.cpp', '.h', '.hpp',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  'target', 'vendor', '.venv', 'venv', '.tox', 'coverage',
  '.mstro', '.cache', '.turbo', '.output',
]);

const FILE_LENGTH_THRESHOLD = 300;
const FUNCTION_LENGTH_THRESHOLD = 50;
const TOTAL_STEPS = 7;

// ============================================================================
// Ecosystem Detection
// ============================================================================

export function detectEcosystem(dirPath: string): Ecosystem[] {
  const ecosystems: Ecosystem[] = [];
  try {
    const files = readdirSync(dirPath);
    if (files.includes('package.json')) ecosystems.push('node');
    if (files.includes('pyproject.toml') || files.includes('setup.py') || files.includes('requirements.txt')) ecosystems.push('python');
    if (files.includes('Cargo.toml')) ecosystems.push('rust');
    if (files.includes('go.mod')) ecosystems.push('go');
  } catch {
    // Directory not readable
  }
  if (ecosystems.length === 0) ecosystems.push('unknown');
  return ecosystems;
}

// ============================================================================
// Tool Detection
// ============================================================================

async function checkToolInstalled(check: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(check[0], check.slice(1), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

export async function detectTools(dirPath: string): Promise<{ tools: QualityTool[]; ecosystem: string[] }> {
  const ecosystems = detectEcosystem(dirPath);
  const tools: QualityTool[] = [];

  for (const eco of ecosystems) {
    const specs = ECOSYSTEM_TOOLS[eco] || [];
    for (const spec of specs) {
      const installed = await checkToolInstalled(spec.check, dirPath);
      tools.push({
        name: spec.name,
        installed,
        installCommand: spec.installCmd,
        category: spec.category,
      });
    }
  }

  return { tools, ecosystem: ecosystems };
}

// ============================================================================
// Tool Installation
// ============================================================================

export async function installTools(
  dirPath: string,
  toolNames?: string[],
): Promise<{ tools: QualityTool[]; ecosystem: string[] }> {
  const { tools } = await detectTools(dirPath);
  const toInstall = tools.filter((t) => !t.installed && (!toolNames || toolNames.includes(t.name)));

  const failures: string[] = [];
  for (const tool of toInstall) {
    if (tool.installCommand.startsWith('(')) continue; // built-in, skip
    const parts = tool.installCommand.split(' ');
    const result = await runCommand(parts[0], parts.slice(1), dirPath);
    if (result.exitCode !== 0) {
      failures.push(`${tool.name}: ${result.stderr || `exited with code ${result.exitCode}`}`);
    }
  }

  // Re-detect after install
  const detected = await detectTools(dirPath);

  if (failures.length > 0) {
    const stillMissing = detected.tools.filter((t) => !t.installed).map((t) => t.name);
    if (stillMissing.length > 0) {
      throw new Error(`Failed to install: ${stillMissing.join(', ')}. ${failures.join('; ')}`);
    }
  }

  return detected;
}

// ============================================================================
// File Scanning
// ============================================================================

interface SourceFile {
  path: string;
  relativePath: string;
  lines: number;
  content: string;
}

function tryStatSync(path: string): ReturnType<typeof statSync> | null {
  try { return statSync(path); } catch { return null; }
}

function tryReadFile(path: string): string | null {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

function tryReaddirSync(dir: string): string[] | null {
  try { return readdirSync(dir); } catch { return null; }
}

function tryReadSourceFile(fullPath: string, rootPath: string): SourceFile | null {
  const content = tryReadFile(fullPath);
  if (!content) return null;
  return {
    path: fullPath,
    relativePath: relative(rootPath, fullPath),
    lines: content.split('\n').length,
    content,
  };
}

function processEntry(entry: string, dir: string, rootPath: string, stack: string[], files: SourceFile[]): void {
  if (IGNORE_DIRS.has(entry)) return;
  const fullPath = join(dir, entry);
  const stat = tryStatSync(fullPath);
  if (!stat) return;

  if (stat.isDirectory()) { stack.push(fullPath); return; }
  if (!stat.isFile() || !SOURCE_EXTENSIONS.has(extname(entry).toLowerCase())) return;

  const sourceFile = tryReadSourceFile(fullPath, rootPath);
  if (sourceFile) files.push(sourceFile);
}

function collectSourceFiles(dirPath: string, rootPath: string): SourceFile[] {
  const files: SourceFile[] = [];
  const stack = [dirPath];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = tryReaddirSync(dir);
    if (!entries) continue;

    for (const entry of entries) {
      processEntry(entry, dir, rootPath, stack, files);
    }
  }

  return files;
}

// ============================================================================
// Command Runner
// ============================================================================

function runCommand(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    proc.on('error', (err) => resolve({ stdout: '', stderr: err.message, exitCode: 1 }));
  });
}

// ============================================================================
// Linting Analysis
// ============================================================================

interface LintAccumulator {
  errors: number;
  warnings: number;
  findings: QualityFinding[];
  ran: boolean;
}

function newLintAccumulator(): LintAccumulator {
  return { errors: 0, warnings: 0, findings: [], ran: false };
}

function biomeSeverity(severity: string): QualityFinding['severity'] {
  if (severity === 'error') return 'high';
  if (severity === 'warning') return 'medium';
  return 'low';
}

function processBiomeDiagnostic(d: Record<string, unknown>, acc: LintAccumulator): void {
  const sev = biomeSeverity(d.severity as string);
  if (d.severity === 'error') acc.errors++;
  else acc.warnings++;
  const location = d.location as Record<string, unknown> | undefined;
  const span = (location?.span as Record<string, unknown>) ?? {};
  const start = (span.start as Record<string, unknown>) ?? {};
  const message = d.message as Record<string, unknown> | string | undefined;
  acc.findings.push({
    severity: sev,
    category: 'linting',
    file: (location?.path as string) || '',
    line: (start.line as number) ?? null,
    title: (d.category as string) || 'Lint issue',
    description: (typeof message === 'object' ? (message?.text as string) : message) || '',
  });
}

function parseBiomeDiagnostics(stdout: string, acc: LintAccumulator): void {
  const parsed = JSON.parse(stdout);
  if (!parsed.diagnostics) return;
  for (const d of parsed.diagnostics) {
    processBiomeDiagnostic(d, acc);
  }
}

async function lintWithBiome(dirPath: string, acc: LintAccumulator): Promise<void> {
  const result = await runCommand('npx', ['@biomejs/biome', 'lint', '--reporter=json', '.'], dirPath);
  if (result.exitCode > 1) return;

  acc.ran = true;
  try {
    parseBiomeDiagnostics(result.stdout, acc);
  } catch {
    // JSON parse failed, try line counting
    acc.errors += (result.stdout.match(/error/gi) || []).length;
    acc.warnings += (result.stdout.match(/warning/gi) || []).length;
    acc.ran = acc.errors > 0 || acc.warnings > 0 || result.exitCode === 0;
  }
}

async function lintWithEslint(dirPath: string, acc: LintAccumulator): Promise<void> {
  const result = await runCommand('npx', ['eslint', '--format=json', '.'], dirPath);
  acc.ran = true;
  try {
    const parsed = JSON.parse(result.stdout);
    for (const file of parsed) {
      for (const msg of file.messages || []) {
        if (msg.severity === 2) acc.errors++;
        else acc.warnings++;
        acc.findings.push({
          severity: msg.severity === 2 ? 'high' : 'medium',
          category: 'linting',
          file: relative(dirPath, file.filePath),
          line: msg.line ?? null,
          title: msg.ruleId || 'Lint issue',
          description: msg.message,
        });
      }
    }
  } catch {
    acc.errors += (result.stderr.match(/error/gi) || []).length;
    acc.warnings += (result.stderr.match(/warning/gi) || []).length;
  }
}

async function lintNode(dirPath: string, acc: LintAccumulator): Promise<void> {
  const biomeConfig = existsSync(join(dirPath, 'biome.json')) || existsSync(join(dirPath, 'biome.jsonc'));
  if (biomeConfig) {
    await lintWithBiome(dirPath, acc);
  } else {
    await lintWithEslint(dirPath, acc);
  }
}

async function lintPython(dirPath: string, acc: LintAccumulator): Promise<void> {
  const result = await runCommand('ruff', ['check', '--output-format=json', '.'], dirPath);
  if (result.exitCode > 1) return;

  acc.ran = true;
  try {
    const parsed = JSON.parse(result.stdout);
    for (const item of parsed) {
      const sev = item.code?.startsWith('E') ? 'high' : 'medium';
      if (sev === 'high') acc.errors++;
      else acc.warnings++;
      acc.findings.push({
        severity: sev,
        category: 'linting',
        file: item.filename ? relative(dirPath, item.filename) : '',
        line: item.location?.row ?? null,
        title: item.code || 'Lint issue',
        description: item.message || '',
      });
    }
  } catch { /* ignore */ }
}

function processClippyMessage(msg: Record<string, unknown>, acc: LintAccumulator): void {
  if (msg.reason !== 'compiler-message' || !msg.message) return;
  const message = msg.message as Record<string, unknown>;
  const level = message.level as string;
  if (level === 'error') acc.errors++;
  else if (level === 'warning') acc.warnings++;
  const spans = message.spans as Array<Record<string, unknown>> | undefined;
  const span = spans?.[0];
  const code = message.code as Record<string, unknown> | undefined;
  acc.findings.push({
    severity: level === 'error' ? 'high' : 'medium',
    category: 'linting',
    file: (span?.file_name as string) || '',
    line: (span?.line_start as number) ?? null,
    title: (code?.code as string) || 'Clippy',
    description: (message.message as string) || '',
  });
}

function parseClippyOutput(stdout: string, acc: LintAccumulator): void {
  for (const line of stdout.split('\n')) {
    try {
      const msg = JSON.parse(line);
      processClippyMessage(msg, acc);
    } catch { /* not JSON line */ }
  }
}

async function lintRust(dirPath: string, acc: LintAccumulator): Promise<void> {
  const result = await runCommand('cargo', ['clippy', '--message-format=json', '--', '-W', 'clippy::all'], dirPath);
  if (result.exitCode > 1) return;

  acc.ran = true;
  parseClippyOutput(result.stdout, acc);
}

function computeLintScore(totalErrors: number, totalWarnings: number, totalLines: number): number {
  const kloc = Math.max(totalLines / 1000, 1);
  const penaltyRaw = totalErrors * 10 + totalWarnings * 3;
  const penaltyPerKloc = penaltyRaw / kloc;

  let score: number;
  if (penaltyPerKloc === 0) score = 100;
  else if (penaltyPerKloc <= 5) score = 100 - penaltyPerKloc * 2;
  else if (penaltyPerKloc <= 20) score = 90 - (penaltyPerKloc - 5) * 2;
  else if (penaltyPerKloc <= 50) score = 60 - (penaltyPerKloc - 20) * 1.5;
  else score = Math.max(0, 15 - (penaltyPerKloc - 50) * 0.3);

  return Math.round(Math.max(0, Math.min(100, score)));
}

async function analyzeLinting(
  dirPath: string,
  ecosystems: Ecosystem[],
  files: SourceFile[],
): Promise<{ score: number; findings: QualityFinding[]; available: boolean; issueCount: number }> {
  const acc = newLintAccumulator();

  if (ecosystems.includes('node')) await lintNode(dirPath, acc);
  if (ecosystems.includes('python')) await lintPython(dirPath, acc);
  if (ecosystems.includes('rust')) await lintRust(dirPath, acc);

  if (!acc.ran) {
    return { score: 0, findings: [], available: false, issueCount: 0 };
  }

  const totalLines = files.reduce((sum, f) => sum + f.lines, 0);
  const score = computeLintScore(acc.errors, acc.warnings, totalLines);

  return {
    score,
    findings: acc.findings.slice(0, 100),
    available: true,
    issueCount: acc.errors + acc.warnings,
  };
}

// ============================================================================
// Formatting Analysis
// ============================================================================

async function analyzeFormatting(
  dirPath: string,
  ecosystems: Ecosystem[],
  files: SourceFile[],
): Promise<{ score: number; available: boolean; issueCount: number }> {
  let totalFiles = 0;
  let passingFiles = 0;
  let ran = false;

  if (ecosystems.includes('node')) {
    const result = await runCommand('npx', ['prettier', '--check', '.'], dirPath);
    ran = true;
    // prettier --check outputs filenames of unformatted files to stdout
    const unformatted = result.stdout.split('\n').filter((l) => l.trim() && !l.startsWith('Checking'));
    const nodeFiles = files.filter((f) => ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(f.path)));
    totalFiles += nodeFiles.length;
    passingFiles += Math.max(0, nodeFiles.length - unformatted.length);
  }

  if (ecosystems.includes('python')) {
    const result = await runCommand('black', ['--check', '--quiet', '.'], dirPath);
    ran = true;
    const pyFiles = files.filter((f) => ['.py', '.pyi'].includes(extname(f.path)));
    totalFiles += pyFiles.length;
    if (result.exitCode === 0) {
      passingFiles += pyFiles.length;
    } else {
      const wouldReformat = (result.stderr.match(/would reformat/gi) || []).length;
      passingFiles += Math.max(0, pyFiles.length - wouldReformat);
    }
  }

  if (ecosystems.includes('rust')) {
    const result = await runCommand('cargo', ['fmt', '--check'], dirPath);
    ran = true;
    const rsFiles = files.filter((f) => extname(f.path) === '.rs');
    totalFiles += rsFiles.length;
    if (result.exitCode === 0) passingFiles += rsFiles.length;
  }

  if (!ran || totalFiles === 0) {
    return { score: 0, available: false, issueCount: 0 };
  }

  const score = Math.round((passingFiles / totalFiles) * 100);
  return { score, available: true, issueCount: totalFiles - passingFiles };
}

// ============================================================================
// File Length Analysis
// ============================================================================

function analyzeFileLength(files: SourceFile[]): { score: number; findings: QualityFinding[]; issueCount: number } {
  if (files.length === 0) return { score: 100, findings: [], issueCount: 0 };

  const findings: QualityFinding[] = [];
  let totalScore = 0;

  for (const file of files) {
    const ratio = Math.max(1, file.lines / FILE_LENGTH_THRESHOLD);
    const fileScore = 100 / ratio ** 1.5;
    totalScore += fileScore;

    if (file.lines > FILE_LENGTH_THRESHOLD) {
      findings.push({
        severity: file.lines > FILE_LENGTH_THRESHOLD * 3 ? 'high' : file.lines > FILE_LENGTH_THRESHOLD * 2 ? 'medium' : 'low',
        category: 'file-length',
        file: file.relativePath,
        line: null,
        title: `File has ${file.lines} lines (threshold: ${FILE_LENGTH_THRESHOLD})`,
        description: `This file exceeds the recommended length of ${FILE_LENGTH_THRESHOLD} lines by ${file.lines - FILE_LENGTH_THRESHOLD} lines.`,
      });
    }
  }

  const score = Math.round(totalScore / files.length);
  return { score: Math.min(100, score), findings: findings.slice(0, 50), issueCount: findings.length };
}

// ============================================================================
// Function Length Analysis
// ============================================================================

interface FunctionInfo {
  name: string;
  file: string;
  startLine: number;
  lines: number;
}

// Match function declarations, arrow functions assigned to const/let, and methods
const JS_FUNC_PATTERN = /^(\s*)(export\s+)?(async\s+)?function\s+(\w+)|^(\s*)(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?\(|^(\s*)(public|private|protected)?\s*(async\s+)?(\w+)\s*\(/;

function countBraceDeltas(line: string): number {
  let delta = 0;
  for (const ch of line) {
    if (ch === '{') delta++;
    else if (ch === '}') delta--;
  }
  return delta;
}

function matchJsFuncStart(line: string): { name: string; indent: number } | null {
  const match = JS_FUNC_PATTERN.exec(line);
  if (!match) return null;
  const name = match[4] || match[8] || match[13] || 'anonymous';
  const indent = (match[1] || match[5] || match[10] || '').length;
  return { name, indent };
}

function extractJsFunctions(file: SourceFile): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const lines = file.content.split('\n');
  let braceDepth = 0;
  let currentFunc: { name: string; startLine: number; indent: number } | null = null;
  let funcStartBraceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!currentFunc) {
      const funcStart = matchJsFuncStart(lines[i]);
      if (funcStart) {
        currentFunc = { name: funcStart.name, startLine: i + 1, indent: funcStart.indent };
        funcStartBraceDepth = braceDepth;
      }
    }

    braceDepth += countBraceDeltas(lines[i]);

    if (currentFunc && braceDepth <= funcStartBraceDepth && i > currentFunc.startLine - 1) {
      functions.push({
        name: currentFunc.name,
        file: file.relativePath,
        startLine: currentFunc.startLine,
        lines: i + 1 - currentFunc.startLine + 1,
      });
      currentFunc = null;
    }
  }

  return functions;
}

function extractPyFunctions(file: SourceFile): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const lines = file.content.split('\n');
  const defPattern = /^(\s*)(async\s+)?def\s+(\w+)/;
  let currentFunc: { name: string; startLine: number; indent: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const match = defPattern.exec(lines[i]);
    if (match) {
      if (currentFunc) {
        functions.push({
          name: currentFunc.name,
          file: file.relativePath,
          startLine: currentFunc.startLine,
          lines: i - currentFunc.startLine + 1,
        });
      }
      currentFunc = { name: match[3], startLine: i + 1, indent: match[1].length };
    } else if (currentFunc && lines[i].trim() && !lines[i].startsWith(' '.repeat(currentFunc.indent + 1)) && !lines[i].startsWith('\t')) {
      functions.push({
        name: currentFunc.name,
        file: file.relativePath,
        startLine: currentFunc.startLine,
        lines: i - currentFunc.startLine + 1,
      });
      currentFunc = null;
    }
  }
  if (currentFunc) {
    functions.push({
      name: currentFunc.name,
      file: file.relativePath,
      startLine: currentFunc.startLine,
      lines: lines.length - currentFunc.startLine + 1,
    });
  }

  return functions;
}

function extractFunctions(file: SourceFile): FunctionInfo[] {
  const ext = extname(file.path).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return extractJsFunctions(file);
  if (['.py', '.pyi'].includes(ext)) return extractPyFunctions(file);
  return [];
}

function analyzeFunctionLength(files: SourceFile[]): { score: number; findings: QualityFinding[]; issueCount: number } {
  const allFunctions: FunctionInfo[] = [];
  for (const file of files) {
    allFunctions.push(...extractFunctions(file));
  }

  if (allFunctions.length === 0) return { score: 100, findings: [], issueCount: 0 };

  const findings: QualityFinding[] = [];
  let totalScore = 0;

  for (const func of allFunctions) {
    const ratio = Math.max(1, func.lines / FUNCTION_LENGTH_THRESHOLD);
    const funcScore = 100 / ratio ** 1.5;
    totalScore += funcScore;

    if (func.lines > FUNCTION_LENGTH_THRESHOLD) {
      findings.push({
        severity: func.lines > FUNCTION_LENGTH_THRESHOLD * 3 ? 'high' : func.lines > FUNCTION_LENGTH_THRESHOLD * 2 ? 'medium' : 'low',
        category: 'function-length',
        file: func.file,
        line: func.startLine,
        title: `${func.name}() has ${func.lines} lines (threshold: ${FUNCTION_LENGTH_THRESHOLD})`,
        description: `Function "${func.name}" exceeds the recommended length by ${func.lines - FUNCTION_LENGTH_THRESHOLD} lines.`,
      });
    }
  }

  const score = Math.round(totalScore / allFunctions.length);
  return { score: Math.min(100, score), findings: findings.slice(0, 50), issueCount: findings.length };
}

// ============================================================================
// Cyclomatic Complexity (Heuristic)
// ============================================================================

function countCyclomaticComplexity(funcContent: string): number {
  let cc = 1; // base
  cc += (funcContent.match(/\bif\b/g) || []).length;
  cc += (funcContent.match(/\belse\s+if\b/g) || []).length;
  cc += (funcContent.match(/\bfor\b/g) || []).length;
  cc += (funcContent.match(/\bwhile\b/g) || []).length;
  cc += (funcContent.match(/\bcase\b/g) || []).length;
  cc += (funcContent.match(/\bcatch\b/g) || []).length;
  cc += (funcContent.match(/&&|\|\|/g) || []).length;
  cc += (funcContent.match(/\?\s*[^:]/g) || []).length; // ternary
  return cc;
}

function complexityToScore(cc: number): number {
  if (cc <= 5) return 100;
  if (cc <= 10) return 100 - (cc - 5) * 5;
  if (cc <= 15) return 75 - (cc - 10) * 5;
  if (cc <= 20) return 50 - (cc - 15) * 5;
  return Math.max(0, 25 - (cc - 20) * 2.5);
}

function getFuncContent(file: SourceFile, func: FunctionInfo): string {
  return file.content.split('\n').slice(func.startLine - 1, func.startLine - 1 + func.lines).join('\n');
}

function complexitySeverity(cc: number): QualityFinding['severity'] {
  if (cc > 20) return 'high';
  if (cc > 15) return 'medium';
  return 'low';
}

interface ComplexityAccumulator {
  weightedScore: number;
  weight: number;
  findings: QualityFinding[];
}

function analyzeFunc(file: SourceFile, func: FunctionInfo, acc: ComplexityAccumulator): void {
  const funcContent = getFuncContent(file, func);
  const cc = countCyclomaticComplexity(funcContent);
  const funcScore = complexityToScore(cc);

  acc.weightedScore += funcScore * func.lines;
  acc.weight += func.lines;

  if (cc > 10) {
    acc.findings.push({
      severity: complexitySeverity(cc),
      category: 'complexity',
      file: func.file,
      line: func.startLine,
      title: `${func.name}() has cyclomatic complexity ${cc}`,
      description: `Complexity of ${cc} exceeds the recommended threshold of 10. Consider refactoring into smaller functions.`,
    });
  }
}

function analyzeComplexity(files: SourceFile[]): { score: number; findings: QualityFinding[]; issueCount: number } {
  const acc: ComplexityAccumulator = { weightedScore: 0, weight: 0, findings: [] };

  for (const file of files) {
    const functions = extractFunctions(file);
    for (const func of functions) {
      analyzeFunc(file, func, acc);
    }
  }

  if (acc.weight === 0) return { score: 100, findings: [], issueCount: 0 };

  const score = Math.round(acc.weightedScore / acc.weight);
  return { score: Math.min(100, score), findings: acc.findings.slice(0, 50), issueCount: acc.findings.length };
}

// ============================================================================
// Scoring
// ============================================================================

function computeGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

interface CategoryWeights {
  linting: number;
  formatting: number;
  complexity: number;
  fileLength: number;
  functionLength: number;
}

const DEFAULT_WEIGHTS: CategoryWeights = {
  linting: 0.30,
  formatting: 0.15,
  complexity: 0.25,
  fileLength: 0.15,
  functionLength: 0.15,
};

function computeOverallScore(categories: CategoryScore[]): number {
  const available = categories.filter((c) => c.available);
  if (available.length === 0) return 0;

  const totalWeight = available.reduce((sum, c) => sum + c.weight, 0);
  let weighted = 0;
  for (const cat of available) {
    const effectiveWeight = cat.weight / totalWeight;
    cat.effectiveWeight = effectiveWeight;
    weighted += cat.score * effectiveWeight;
  }

  return Math.round(Math.max(0, Math.min(100, weighted)));
}

// ============================================================================
// Main Scan
// ============================================================================

export type ProgressCallback = (progress: ScanProgress) => void;

export async function runQualityScan(
  dirPath: string,
  onProgress?: ProgressCallback,
): Promise<QualityResults> {
  const ecosystems = detectEcosystem(dirPath);

  const progress = (step: string, current: number) => {
    onProgress?.({ step, current, total: TOTAL_STEPS });
  };

  // Step 1: Collect source files
  progress('Collecting source files', 1);
  const files = collectSourceFiles(dirPath, dirPath);

  // Step 2: Run linting
  progress('Running linters', 2);
  const lintResult = await analyzeLinting(dirPath, ecosystems, files);

  // Step 3: Check formatting
  progress('Checking formatting', 3);
  const fmtResult = await analyzeFormatting(dirPath, ecosystems, files);

  // Step 4: Analyze complexity
  progress('Analyzing complexity', 4);
  const complexityResult = analyzeComplexity(files);

  // Step 5: Check file lengths
  progress('Checking file lengths', 5);
  const fileLengthResult = analyzeFileLength(files);

  // Step 6: Check function lengths
  progress('Checking function lengths', 6);
  const funcLengthResult = analyzeFunctionLength(files);

  // Step 7: Compute scores
  progress('Computing scores', 7);

  const categories: CategoryScore[] = [
    {
      name: 'Linting',
      score: lintResult.score,
      weight: DEFAULT_WEIGHTS.linting,
      effectiveWeight: DEFAULT_WEIGHTS.linting,
      available: lintResult.available,
      issueCount: lintResult.issueCount,
    },
    {
      name: 'Formatting',
      score: fmtResult.score,
      weight: DEFAULT_WEIGHTS.formatting,
      effectiveWeight: DEFAULT_WEIGHTS.formatting,
      available: fmtResult.available,
      issueCount: fmtResult.issueCount,
    },
    {
      name: 'Complexity',
      score: complexityResult.score,
      weight: DEFAULT_WEIGHTS.complexity,
      effectiveWeight: DEFAULT_WEIGHTS.complexity,
      available: true,
      issueCount: complexityResult.issueCount,
    },
    {
      name: 'File Length',
      score: fileLengthResult.score,
      weight: DEFAULT_WEIGHTS.fileLength,
      effectiveWeight: DEFAULT_WEIGHTS.fileLength,
      available: true,
      issueCount: fileLengthResult.issueCount,
    },
    {
      name: 'Function Length',
      score: funcLengthResult.score,
      weight: DEFAULT_WEIGHTS.functionLength,
      effectiveWeight: DEFAULT_WEIGHTS.functionLength,
      available: true,
      issueCount: funcLengthResult.issueCount,
    },
  ];

  const overall = computeOverallScore(categories);
  const allFindings = [
    ...lintResult.findings,
    ...complexityResult.findings,
    ...fileLengthResult.findings,
    ...funcLengthResult.findings,
  ];

  return {
    overall,
    grade: computeGrade(overall),
    categories,
    findings: allFindings.slice(0, 200),
    codeReview: [],
    analyzedFiles: files.length,
    totalLines: files.reduce((sum, f) => sum + f.lines, 0),
    timestamp: new Date().toISOString(),
    ecosystem: ecosystems,
  };
}
