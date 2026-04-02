// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { existsSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { runCommand, type SourceFile } from './quality-tools.js';
import { biomeDiagToFinding, type Ecosystem, FUNCTION_LENGTH_THRESHOLD, isBiomeComplexityDiagnostic, isEslintComplexityRule, type QualityFinding } from './quality-types.js';

// ============================================================================
// Function Length Analysis
// ============================================================================

interface FunctionInfo {
  name: string;
  file: string;
  startLine: number;
  lines: number;
}

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

export function analyzeFunctionLength(files: SourceFile[]): { score: number; findings: QualityFinding[]; issueCount: number } {
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
// Complexity Analysis (Biome, ESLint, radon)
// ============================================================================

function computeComplexityScore(findings: QualityFinding[]): number {
  let penalty = 0;
  for (const f of findings) {
    if (f.severity === 'high' || f.severity === 'critical') penalty += 8;
    else if (f.severity === 'medium') penalty += 5;
    else penalty += 3;
  }
  return Math.max(0, 100 - penalty);
}

async function complexityFromBiome(dirPath: string): Promise<QualityFinding[] | null> {
  const hasBiomeConfig = existsSync(join(dirPath, 'biome.json')) || existsSync(join(dirPath, 'biome.jsonc'));
  if (!hasBiomeConfig) return null;

  const result = await runCommand('npx', ['@biomejs/biome', 'lint', '--reporter=json', '.'], dirPath);
  if (result.exitCode > 1) return null;

  try {
    const parsed = JSON.parse(result.stdout);
    if (!parsed.diagnostics) return [];
    return parsed.diagnostics
      .filter(isBiomeComplexityDiagnostic)
      .map((d: Record<string, unknown>) => biomeDiagToFinding(d, 'complexity'));
  } catch {
    return null;
  }
}

async function complexityFromEslint(dirPath: string): Promise<QualityFinding[] | null> {
  const result = await runCommand('npx', ['eslint', '--format=json', '.'], dirPath);
  if (result.exitCode > 1 && !result.stdout.trim().startsWith('[')) return null;

  const findings: QualityFinding[] = [];
  try {
    const parsed = JSON.parse(result.stdout);
    for (const file of parsed) {
      for (const msg of file.messages || []) {
        if (!isEslintComplexityRule(msg.ruleId)) continue;
        findings.push({
          severity: msg.severity === 2 ? 'high' : 'medium',
          category: 'complexity',
          file: relative(dirPath, file.filePath),
          line: msg.line ?? null,
          title: msg.ruleId || 'complexity',
          description: msg.message,
        });
      }
    }
  } catch {
    return null;
  }

  return findings;
}

function radonFuncToFinding(filePath: string, func: Record<string, unknown>): QualityFinding | null {
  const cc = func.complexity as number;
  if (cc <= 10) return null;
  return {
    severity: cc > 20 ? 'high' : cc > 15 ? 'medium' : 'low',
    category: 'complexity',
    file: filePath,
    line: (func.lineno as number) ?? null,
    title: `${func.name}() has cyclomatic complexity ${cc}`,
    description: `Complexity of ${cc} exceeds threshold of 10. Rank: ${func.rank}. Consider refactoring.`,
  };
}

async function complexityFromRadon(dirPath: string): Promise<QualityFinding[] | null> {
  const result = await runCommand('radon', ['cc', '--json', '.'], dirPath);
  if (result.exitCode !== 0 && !result.stdout.trim().startsWith('{')) return null;

  try {
    const parsed = JSON.parse(result.stdout) as Record<string, Array<Record<string, unknown>>>;
    const findings: QualityFinding[] = [];
    for (const [filePath, functions] of Object.entries(parsed)) {
      for (const func of functions) {
        const finding = radonFuncToFinding(filePath, func);
        if (finding) findings.push(finding);
      }
    }
    return findings;
  } catch {
    return null;
  }
}

async function analyzeNodeComplexity(
  dirPath: string,
  installed: Set<string> | null,
): Promise<QualityFinding[] | null> {
  const hasCapableTool = !installed || installed.has('biome') || installed.has('eslint');
  if (!hasCapableTool) return null;

  const hasBiomeConfig = existsSync(join(dirPath, 'biome.json')) || existsSync(join(dirPath, 'biome.jsonc'));
  if (hasBiomeConfig) {
    const findings = await complexityFromBiome(dirPath);
    if (findings) return findings;
  }
  return complexityFromEslint(dirPath);
}

async function analyzePythonComplexity(
  dirPath: string,
  installed: Set<string> | null,
): Promise<QualityFinding[] | null> {
  const hasRadon = !installed || installed.has('radon');
  if (!hasRadon) return null;
  return complexityFromRadon(dirPath);
}

export async function analyzeComplexity(
  dirPath: string,
  ecosystems: Ecosystem[],
  installedToolNames?: string[],
): Promise<{ score: number; findings: QualityFinding[]; issueCount: number; available: boolean }> {
  const allFindings: QualityFinding[] = [];
  const installed = installedToolNames ? new Set(installedToolNames) : null;
  let canAnalyze = false;

  for (const ecosystem of ecosystems) {
    const analyze = ecosystem === 'node' ? analyzeNodeComplexity : ecosystem === 'python' ? analyzePythonComplexity : null;
    if (!analyze) continue;
    const findings = await analyze(dirPath, installed);
    if (findings) {
      canAnalyze = true;
      allFindings.push(...findings);
    }
  }

  if (!canAnalyze) {
    return { score: 0, findings: [], issueCount: 0, available: false };
  }

  return {
    score: allFindings.length > 0 ? computeComplexityScore(allFindings) : 100,
    findings: allFindings.slice(0, 50),
    issueCount: allFindings.length,
    available: true,
  };
}
