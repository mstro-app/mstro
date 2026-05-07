// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { extname, relative } from 'node:path';
import { chunkFileList, filesByExt, isTestFile, runCommand, type SourceFile } from './quality-tools.js';
import { biomeDiagToFinding, type Ecosystem, FUNCTION_LENGTH_THRESHOLD, isBiomeComplexityDiagnostic, isEslintComplexityRule, type QualityFinding } from './quality-types.js';

const NODE_COMPLEXITY_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const PY_COMPLEXITY_EXTS = ['.py', '.pyi'];

// ============================================================================
// Function Length Analysis
// ============================================================================

interface FunctionInfo {
  name: string;
  file: string;
  startLine: number;
  lines: number;
  /** Approximate cyclomatic complexity (count of decision points). */
  branches: number;
}

/**
 * Decision-point keywords that approximate cyclomatic complexity. We count
 * occurrences as a cheap proxy — McCabe's exact metric requires AST parsing,
 * but the keyword count is highly correlated and good enough to distinguish
 * "long but linear" (a flat sequence of statements) from "long and branchy"
 * (deeply nested control flow).
 *
 * The user's task 2 requirement: "a 1000 line file might be just fine, not
 * a violation at all, while another 1000 line file might be a severe mix of
 * concerns" — same applies to functions. A long config-builder with one
 * return statement is fine; a long monster with 40 if-branches is not.
 */
const BRANCH_KEYWORDS = /\b(?:if|else if|elif|for|while|case|catch|\?\s*\w|&&|\|\||\?\?)\b/g;

function countBranches(body: string): number {
  return (body.match(BRANCH_KEYWORDS) || []).length;
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
      const startLine = currentFunc.startLine;
      const endLine = i + 1;
      const body = lines.slice(startLine - 1, endLine).join('\n');
      functions.push({
        name: currentFunc.name,
        file: file.relativePath,
        startLine,
        lines: endLine - startLine + 1,
        branches: countBranches(body),
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

  const recordFunction = (name: string, startLine: number, endLine: number) => {
    const body = lines.slice(startLine - 1, endLine).join('\n');
    functions.push({
      name,
      file: file.relativePath,
      startLine,
      lines: endLine - startLine + 1,
      branches: countBranches(body),
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const match = defPattern.exec(lines[i]);
    if (match) {
      if (currentFunc) recordFunction(currentFunc.name, currentFunc.startLine, i);
      currentFunc = { name: match[3], startLine: i + 1, indent: match[1].length };
    } else if (currentFunc && lines[i].trim() && !lines[i].startsWith(' '.repeat(currentFunc.indent + 1)) && !lines[i].startsWith('\t')) {
      recordFunction(currentFunc.name, currentFunc.startLine, i);
      currentFunc = null;
    }
  }
  if (currentFunc) {
    recordFunction(currentFunc.name, currentFunc.startLine, lines.length);
  }

  return functions;
}

function extractFunctions(file: SourceFile): FunctionInfo[] {
  const ext = extname(file.path).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return extractJsFunctions(file);
  if (['.py', '.pyi'].includes(ext)) return extractPyFunctions(file);
  return [];
}

/**
 * Map a function's branch density (decision points per N lines) to a
 * severity level for the function-length finding. Returns `null` to suppress
 * the finding for a long but linear function — e.g., a config-builder with
 * one return statement and 200 lines of property assignments.
 *
 * Heuristic: McCabe's cyclomatic complexity threshold is ~10. Above that,
 * functions are hard to test. We grade severity by branches-per-50-lines so
 * a 100-line function with 5 branches looks the same as a 50-line function
 * with 5 branches (both ~industry "consider refactoring" zone).
 *
 * Functions absurdly long (>5x threshold) emit a finding regardless of
 * branchiness — a 250-line function is too much to read in one sitting even
 * if it's "linear."
 */
function severityFromBranchiness(branches: number, lines: number): QualityFinding['severity'] | null {
  const branchesPer50 = (branches * 50) / Math.max(1, lines);
  const isAbsurd = lines > FUNCTION_LENGTH_THRESHOLD * 5;
  if (branchesPer50 < 3 && !isAbsurd) return null; // Long but linear — not really a violation.
  if (branchesPer50 < 6) return 'low';
  if (branchesPer50 < 10) return 'medium';
  return 'high';
}

export function analyzeFunctionLength(files: SourceFile[]): { score: number; findings: QualityFinding[]; issueCount: number } {
  const allFunctions: FunctionInfo[] = [];
  for (const file of files) {
    // Test files are exempt: a long `it()`/`describe()` body is normal and
    // splitting it produces churn without improving readability. Linting
    // and other quality checks still apply — only structural-length defers.
    if (isTestFile(file.relativePath)) continue;
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
      const severity = severityFromBranchiness(func.branches, func.lines);
      if (!severity) continue; // Long but linear — not flagged.

      findings.push({
        severity,
        category: 'function-length',
        file: func.file,
        line: func.startLine,
        title: `${func.name}() has ${func.lines} lines, ~${func.branches} branches`,
        description:
          `Function "${func.name}" exceeds the ${FUNCTION_LENGTH_THRESHOLD}-line threshold by ${func.lines - FUNCTION_LENGTH_THRESHOLD} lines ` +
          `with approximately ${func.branches} decision points (cyclomatic complexity proxy). ` +
          (severity === 'high'
            ? 'High branchiness makes this hard to test and review — extract sub-functions or simplify control flow.'
            : 'Long but with manageable branching — consider extracting helpers if the function does multiple things.'),
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

async function complexityFromBiome(dirPath: string, files: SourceFile[]): Promise<QualityFinding[] | null> {
  const targets = filesByExt(files, NODE_COMPLEXITY_EXTS);
  if (targets.length === 0) return [];

  const findings: QualityFinding[] = [];
  for (const chunk of chunkFileList(targets)) {
    const result = await runCommand('npx', ['@biomejs/biome', 'lint', '--reporter=json', ...chunk], dirPath);
    if (result.exitCode > 1) return null;

    try {
      const parsed = JSON.parse(result.stdout);
      if (!parsed.diagnostics) continue;
      for (const d of parsed.diagnostics) {
        if (isBiomeComplexityDiagnostic(d)) findings.push(biomeDiagToFinding(d, 'complexity'));
      }
    } catch {
      return null;
    }
  }
  return findings;
}

function eslintFileToComplexityFindings(
  file: { filePath: string; messages?: Array<Record<string, unknown>> },
  dirPath: string,
): QualityFinding[] {
  const out: QualityFinding[] = [];
  for (const msg of file.messages || []) {
    if (!isEslintComplexityRule(msg.ruleId as string)) continue;
    out.push({
      severity: msg.severity === 2 ? 'high' : 'medium',
      category: 'complexity',
      file: relative(dirPath, file.filePath),
      line: (msg.line as number) ?? null,
      title: (msg.ruleId as string) || 'complexity',
      description: msg.message as string,
    });
  }
  return out;
}

async function complexityFromEslint(dirPath: string, files: SourceFile[]): Promise<QualityFinding[] | null> {
  const targets = filesByExt(files, NODE_COMPLEXITY_EXTS);
  if (targets.length === 0) return [];

  const findings: QualityFinding[] = [];
  for (const chunk of chunkFileList(targets)) {
    const result = await runCommand('npx', ['eslint', '--format=json', ...chunk], dirPath);
    if (result.exitCode > 1 && !result.stdout.trim().startsWith('[')) return null;

    try {
      const parsed = JSON.parse(result.stdout);
      for (const file of parsed) findings.push(...eslintFileToComplexityFindings(file, dirPath));
    } catch {
      return null;
    }
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

function radonPayloadToFindings(payload: Record<string, Array<Record<string, unknown>>>): QualityFinding[] {
  const out: QualityFinding[] = [];
  for (const [filePath, functions] of Object.entries(payload)) {
    for (const func of functions) {
      const finding = radonFuncToFinding(filePath, func);
      if (finding) out.push(finding);
    }
  }
  return out;
}

async function complexityFromRadon(dirPath: string, files: SourceFile[]): Promise<QualityFinding[] | null> {
  const targets = filesByExt(files, PY_COMPLEXITY_EXTS);
  if (targets.length === 0) return [];

  const findings: QualityFinding[] = [];
  for (const chunk of chunkFileList(targets)) {
    const result = await runCommand('radon', ['cc', '--json', ...chunk], dirPath);
    if (result.exitCode !== 0 && !result.stdout.trim().startsWith('{')) return null;

    try {
      const parsed = JSON.parse(result.stdout) as Record<string, Array<Record<string, unknown>>>;
      findings.push(...radonPayloadToFindings(parsed));
    } catch {
      return null;
    }
  }
  return findings;
}

async function analyzeNodeComplexity(
  dirPath: string,
  installed: Set<string> | null,
  files: SourceFile[],
): Promise<QualityFinding[] | null> {
  const hasCapableTool = !installed || installed.has('biome') || installed.has('eslint');
  if (!hasCapableTool) return null;

  // Use installed tools list instead of config file presence.
  // This fixes monorepo scenarios where biome.json is in a subdirectory.
  const hasBiome = !installed || installed.has('biome');
  if (hasBiome) {
    const findings = await complexityFromBiome(dirPath, files);
    if (findings) return findings;
  }
  return complexityFromEslint(dirPath, files);
}

async function analyzePythonComplexity(
  dirPath: string,
  installed: Set<string> | null,
  files: SourceFile[],
): Promise<QualityFinding[] | null> {
  const hasRadon = !installed || installed.has('radon');
  if (!hasRadon) return null;
  return complexityFromRadon(dirPath, files);
}

export async function analyzeComplexity(
  dirPath: string,
  ecosystems: Ecosystem[],
  files: SourceFile[],
  installedToolNames?: string[],
): Promise<{ score: number; findings: QualityFinding[]; issueCount: number; available: boolean }> {
  const allFindings: QualityFinding[] = [];
  const installed = installedToolNames ? new Set(installedToolNames) : null;
  let canAnalyze = false;

  for (const ecosystem of ecosystems) {
    const analyze = ecosystem === 'node' ? analyzeNodeComplexity : ecosystem === 'python' ? analyzePythonComplexity : null;
    if (!analyze) continue;
    const findings = await analyze(dirPath, installed, files);
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
