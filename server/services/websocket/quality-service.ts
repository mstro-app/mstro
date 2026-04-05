// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { extname } from 'node:path';
import { analyzeComplexity, analyzeFunctionLength } from './quality-complexity.js';
import { analyzeLinting } from './quality-linting.js';
import { collectSourceFiles, detectEcosystem, runCommand, type SourceFile } from './quality-tools.js';
import { type CategoryScore, type Ecosystem, FILE_LENGTH_THRESHOLD, hasInstalledToolInCategory, type QualityFinding, type QualityResults, type ScanProgress, TOTAL_STEPS } from './quality-types.js';

export { detectEcosystem, detectTools, installTools } from './quality-tools.js';
// Re-export public API for backward compatibility
export type { CategoryScore, QualityFinding, QualityResults, QualityTool, ScanProgress } from './quality-types.js';

// ============================================================================
// Formatting Analysis
// ============================================================================

interface FmtAccumulator {
  totalFiles: number;
  passingFiles: number;
  ran: boolean;
  findings: QualityFinding[];
}

function newFmtAccumulator(): FmtAccumulator {
  return { totalFiles: 0, passingFiles: 0, ran: false, findings: [] };
}

async function fmtNode(dirPath: string, files: SourceFile[], acc: FmtAccumulator): Promise<void> {
  const result = await runCommand('npx', ['prettier', '--check', '.'], dirPath);
  acc.ran = true;
  const unformatted = result.stdout.split('\n').filter((l) => l.trim() && !l.startsWith('Checking'));
  const nodeFiles = files.filter((f) => ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(f.path)));
  acc.totalFiles += nodeFiles.length;
  acc.passingFiles += Math.max(0, nodeFiles.length - unformatted.length);
  for (const filePath of unformatted) {
    if (!filePath.trim()) continue;
    const rel = filePath.startsWith('/') ? filePath.replace(`${dirPath}/`, '') : filePath;
    acc.findings.push({ severity: 'low', category: 'format', file: rel, line: null, title: 'File not formatted', description: 'Does not match Prettier formatting rules.' });
  }
}

async function fmtPython(dirPath: string, files: SourceFile[], acc: FmtAccumulator): Promise<void> {
  const result = await runCommand('black', ['--check', '--quiet', '.'], dirPath);
  acc.ran = true;
  const pyFiles = files.filter((f) => ['.py', '.pyi'].includes(extname(f.path)));
  acc.totalFiles += pyFiles.length;
  if (result.exitCode === 0) {
    acc.passingFiles += pyFiles.length;
    return;
  }
  const reformatLines = result.stderr.split('\n').filter((l) => l.includes('would reformat'));
  acc.passingFiles += Math.max(0, pyFiles.length - reformatLines.length);
  for (const line of reformatLines) {
    const match = line.match(/would reformat (.+)/);
    if (match) acc.findings.push({ severity: 'low', category: 'format', file: match[1].trim(), line: null, title: 'File not formatted', description: 'Does not match Black formatting rules.' });
  }
}

async function fmtRust(dirPath: string, files: SourceFile[], acc: FmtAccumulator): Promise<void> {
  const result = await runCommand('cargo', ['fmt', '--check'], dirPath);
  acc.ran = true;
  const rsFiles = files.filter((f) => extname(f.path) === '.rs');
  acc.totalFiles += rsFiles.length;
  if (result.exitCode === 0) {
    acc.passingFiles += rsFiles.length;
    return;
  }
  const diffLines = result.stdout.split('\n').filter((l) => l.startsWith('Diff in'));
  for (const line of diffLines) {
    const match = line.match(/Diff in (.+?) at/);
    if (match) acc.findings.push({ severity: 'low', category: 'format', file: match[1].trim(), line: null, title: 'File not formatted', description: 'Does not match rustfmt formatting rules.' });
  }
}

async function analyzeFormatting(
  dirPath: string,
  ecosystems: Ecosystem[],
  files: SourceFile[],
): Promise<{ score: number; available: boolean; issueCount: number; findings: QualityFinding[] }> {
  const acc = newFmtAccumulator();

  if (ecosystems.includes('node')) await fmtNode(dirPath, files, acc);
  if (ecosystems.includes('python')) await fmtPython(dirPath, files, acc);
  if (ecosystems.includes('rust')) await fmtRust(dirPath, files, acc);

  if (!acc.ran || acc.totalFiles === 0) {
    return { score: 0, available: false, issueCount: 0, findings: [] };
  }

  const score = Math.round((acc.passingFiles / acc.totalFiles) * 100);
  return { score, available: true, issueCount: acc.totalFiles - acc.passingFiles, findings: acc.findings.slice(0, 50) };
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
  aiReview: number;
}

const DEFAULT_WEIGHTS: CategoryWeights = {
  linting: 0.25,
  formatting: 0.10,
  complexity: 0.20,
  fileLength: 0.12,
  functionLength: 0.13,
  aiReview: 0.20,
};

// ============================================================================
// AI Code Review Score
// ============================================================================

const SEVERITY_PENALTY: Record<string, number> = {
  critical: 10.0,
  high: 5.0,
  medium: 2.0,
  low: 0.5,
};

/** Exponential decay constant — higher = harsher scoring */
const AI_REVIEW_DECAY = 0.10;

export function computeAiReviewScore(
  findings: Array<{ severity: string }>,
  totalLines: number,
): number {
  if (findings.length === 0) return 100;

  const effectiveKloc = Math.max(totalLines / 1000, 1.0);
  const totalPenalty = findings.reduce(
    (sum, f) => sum + (SEVERITY_PENALTY[f.severity] ?? 2.0),
    0,
  );
  const penaltyDensity = totalPenalty / effectiveKloc;
  return Math.round(100 * Math.exp(-AI_REVIEW_DECAY * penaltyDensity));
}

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
  installedToolNames?: string[],
): Promise<QualityResults> {
  const ecosystems = detectEcosystem(dirPath);

  // Build set of installed tools for gating analyses
  const installedSet = installedToolNames ? new Set(installedToolNames) : null;

  const progress = (step: string, current: number) => {
    onProgress?.({ step, current, total: TOTAL_STEPS });
  };

  // Step 1: Collect source files
  progress('Collecting source files', 1);
  const files = await collectSourceFiles(dirPath, dirPath);

  // Step 2: Run linting (only if a linter is installed)
  progress('Running linters', 2);
  const hasLinter = !installedSet || hasInstalledToolInCategory(installedSet, ecosystems, 'linter');
  const lintResult = hasLinter
    ? await analyzeLinting(dirPath, ecosystems, files, installedToolNames)
    : { score: 0, findings: [], available: false, issueCount: 0 };

  // Step 3: Check formatting (only if a formatter is installed)
  progress('Checking formatting', 3);
  const hasFormatter = !installedSet || hasInstalledToolInCategory(installedSet, ecosystems, 'formatter');
  const fmtResult = hasFormatter
    ? await analyzeFormatting(dirPath, ecosystems, files)
    : { score: 0, available: false, issueCount: 0, findings: [] as QualityFinding[] };

  // Step 4: Analyze complexity (using real tools: Biome, ESLint, radon)
  progress('Analyzing complexity', 4);
  const complexityResult = await analyzeComplexity(dirPath, ecosystems, installedToolNames);

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
      available: complexityResult.available,
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
    {
      name: 'AI Review',
      score: 0,
      weight: DEFAULT_WEIGHTS.aiReview,
      effectiveWeight: DEFAULT_WEIGHTS.aiReview,
      available: false,
      issueCount: 0,
    },
  ];

  const overall = computeOverallScore(categories);
  const allFindings = [
    ...lintResult.findings,
    ...fmtResult.findings,
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

// ============================================================================
// Recompute with AI Review
// ============================================================================

/**
 * Recompute the overall score after AI code review findings become available.
 * Returns a new QualityResults with the AI Review category enabled and score updated.
 */
export function recomputeWithAiReview(
  results: QualityResults,
  aiFindings: Array<{ severity: string }>,
): QualityResults {
  const aiScore = computeAiReviewScore(aiFindings, results.totalLines);

  // Update or add the AI Review category
  const categories = results.categories.map((cat) => ({ ...cat }));
  const aiCatIndex = categories.findIndex((c) => c.name === 'AI Review');
  const aiCategory: CategoryScore = {
    name: 'AI Review',
    score: aiScore,
    weight: DEFAULT_WEIGHTS.aiReview,
    effectiveWeight: DEFAULT_WEIGHTS.aiReview,
    available: true,
    issueCount: aiFindings.length,
  };

  if (aiCatIndex >= 0) {
    categories[aiCatIndex] = aiCategory;
  } else {
    categories.push(aiCategory);
  }

  const overall = computeOverallScore(categories);

  return {
    ...results,
    overall,
    grade: computeGrade(overall),
    categories,
    codeReview: results.codeReview,
  };
}
