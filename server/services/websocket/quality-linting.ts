// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { relative } from 'node:path';
import { chunkFileList, filesByExt, runCommand, type SourceFile } from './quality-tools.js';
import { biomeDiagToFinding, type Ecosystem, isBiomeComplexityDiagnostic, isEslintComplexityRule, type QualityFinding } from './quality-types.js';

const NODE_LINT_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const PY_LINT_EXTS = ['.py', '.pyi'];

interface LintAccumulator {
  errors: number;
  warnings: number;
  findings: QualityFinding[];
  ran: boolean;
}

function newLintAccumulator(): LintAccumulator {
  return { errors: 0, warnings: 0, findings: [], ran: false };
}

function processBiomeDiagnostic(d: Record<string, unknown>, acc: LintAccumulator): void {
  if (isBiomeComplexityDiagnostic(d)) return;
  if (d.severity === 'error') acc.errors++;
  else acc.warnings++;
  acc.findings.push(biomeDiagToFinding(d, 'linting'));
}

function parseBiomeDiagnostics(stdout: string, acc: LintAccumulator): void {
  const parsed = JSON.parse(stdout);
  if (!parsed.diagnostics) return;
  for (const d of parsed.diagnostics) {
    processBiomeDiagnostic(d, acc);
  }
}

async function lintWithBiome(dirPath: string, acc: LintAccumulator, files: SourceFile[]): Promise<void> {
  const targets = filesByExt(files, NODE_LINT_EXTS);
  if (targets.length === 0) return;

  for (const chunk of chunkFileList(targets)) {
    const result = await runCommand('npx', ['@biomejs/biome', 'lint', '--reporter=json', ...chunk], dirPath);
    if (result.exitCode > 1) return;

    acc.ran = true;
    try {
      parseBiomeDiagnostics(result.stdout, acc);
    } catch {
      acc.errors += (result.stdout.match(/error/gi) || []).length;
      acc.warnings += (result.stdout.match(/warning/gi) || []).length;
      acc.ran = acc.errors > 0 || acc.warnings > 0 || result.exitCode === 0;
    }
  }
}

function processEslintMessage(
  msg: Record<string, unknown>,
  filePath: string,
  dirPath: string,
  acc: LintAccumulator,
): void {
  if (isEslintComplexityRule(msg.ruleId as string)) return;
  if (msg.severity === 2) acc.errors++;
  else acc.warnings++;
  acc.findings.push({
    severity: msg.severity === 2 ? 'high' : 'medium',
    category: 'lint',
    file: relative(dirPath, filePath),
    line: (msg.line as number) ?? null,
    title: (msg.ruleId as string) || 'Lint issue',
    description: (msg.message as string) || '',
  });
}

async function lintWithEslint(dirPath: string, acc: LintAccumulator, files: SourceFile[]): Promise<void> {
  const targets = filesByExt(files, NODE_LINT_EXTS);
  if (targets.length === 0) return;

  for (const chunk of chunkFileList(targets)) {
    const result = await runCommand('npx', ['eslint', '--format=json', ...chunk], dirPath);
    acc.ran = true;
    try {
      const parsed = JSON.parse(result.stdout);
      for (const file of parsed) {
        for (const msg of file.messages || []) {
          processEslintMessage(msg, file.filePath, dirPath, acc);
        }
      }
    } catch {
      acc.errors += (result.stderr.match(/error/gi) || []).length;
      acc.warnings += (result.stderr.match(/warning/gi) || []).length;
    }
  }
}

async function lintNode(
  dirPath: string,
  acc: LintAccumulator,
  installed: Set<string> | null,
  files: SourceFile[],
): Promise<void> {
  // Use installed tools list to decide which linter to run, not config file presence.
  // This fixes monorepo scenarios where the config is in a subdirectory.
  const hasBiome = !installed || installed.has('biome');
  const hasEslint = !installed || installed.has('eslint');

  if (hasBiome) {
    await lintWithBiome(dirPath, acc, files);
    if (acc.ran) return;
  }
  if (hasEslint) {
    await lintWithEslint(dirPath, acc, files);
  }
}

function processRuffItem(item: Record<string, unknown>, dirPath: string, acc: LintAccumulator): void {
  const code = item.code as string | undefined;
  const sev = code?.startsWith('E') ? 'high' : 'medium';
  if (sev === 'high') acc.errors++;
  else acc.warnings++;
  const location = item.location as Record<string, unknown> | undefined;
  acc.findings.push({
    severity: sev,
    category: 'lint',
    file: item.filename ? relative(dirPath, item.filename as string) : '',
    line: (location?.row as number) ?? null,
    title: code || 'Lint issue',
    description: (item.message as string) || '',
  });
}

async function lintPython(dirPath: string, acc: LintAccumulator, files: SourceFile[]): Promise<void> {
  const targets = filesByExt(files, PY_LINT_EXTS);
  if (targets.length === 0) return;

  for (const chunk of chunkFileList(targets)) {
    const result = await runCommand('ruff', ['check', '--output-format=json', ...chunk], dirPath);
    if (result.exitCode !== 0 && !result.stdout.trim().startsWith('[')) continue;

    acc.ran = true;
    try {
      const parsed = JSON.parse(result.stdout);
      for (const item of parsed) processRuffItem(item, dirPath, acc);
    } catch { /* ignore */ }
  }
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
    category: 'lint',
    file: (span?.file_name as string) || '',
    line: (span?.line_start as number) ?? null,
    title: (code?.code as string) || 'Clippy',
    description: (message.message as string) || '',
  });
}

async function lintRust(dirPath: string, acc: LintAccumulator): Promise<void> {
  const result = await runCommand('cargo', ['clippy', '--message-format=json', '--', '-W', 'clippy::all'], dirPath);
  if (result.exitCode > 1) return;

  acc.ran = true;
  for (const line of result.stdout.split('\n')) {
    try {
      const msg = JSON.parse(line);
      processClippyMessage(msg, acc);
    } catch { /* not JSON line */ }
  }
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

export async function analyzeLinting(
  dirPath: string,
  ecosystems: Ecosystem[],
  files: SourceFile[],
  installedToolNames?: string[],
): Promise<{ score: number; findings: QualityFinding[]; available: boolean; issueCount: number }> {
  const acc = newLintAccumulator();
  const installed = installedToolNames ? new Set(installedToolNames) : null;

  if (ecosystems.includes('node')) await lintNode(dirPath, acc, installed, files);
  if (ecosystems.includes('python')) await lintPython(dirPath, acc, files);
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
