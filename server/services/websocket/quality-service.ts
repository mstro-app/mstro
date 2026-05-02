// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { extname } from 'node:path';
import { analyzeComplexity, analyzeFunctionLength } from './quality-complexity.js';
import { computeQualityRating, gradeFromScore } from './quality-grading.js';
import { analyzeLinting } from './quality-linting.js';
import { chunkFileList, collectSourceFiles, detectEcosystem, filesByExt, runCommand, type SourceFile } from './quality-tools.js';
import { type CategoryPenalty, type CategoryScore, type DimensionName, type Ecosystem, FILE_LENGTH_THRESHOLD, hasInstalledToolInCategory, type QualityFinding, type QualityResults, type ScanProgress, type ScoreBreakdown, TOTAL_STEPS } from './quality-types.js';

const NODE_FMT_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const PY_FMT_EXTS = ['.py', '.pyi'];

export { detectEcosystem, detectTools, installTools } from './quality-tools.js';
// Re-export public API for backward compatibility
export type { CategoryPenalty, CategoryScore, QualityFinding, QualityResults, QualityTool, ScanProgress, ScoreBreakdown } from './quality-types.js';

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
  const targets = filesByExt(files, NODE_FMT_EXTS);
  if (targets.length === 0) return;

  acc.totalFiles += targets.length;
  const unformattedSet = new Set<string>();

  for (const chunk of chunkFileList(targets)) {
    const result = await runCommand('npx', ['prettier', '--check', ...chunk], dirPath);
    acc.ran = true;
    for (const line of result.stdout.split('\n')) {
      if (!line.trim() || line.startsWith('Checking')) continue;
      const rel = line.startsWith('/') ? line.replace(`${dirPath}/`, '') : line;
      unformattedSet.add(rel.trim());
    }
  }

  acc.passingFiles += Math.max(0, targets.length - unformattedSet.size);
  for (const rel of unformattedSet) {
    acc.findings.push({ severity: 'low', category: 'format', file: rel, line: null, title: 'File not formatted', description: 'Does not match Prettier formatting rules.' });
  }
}

async function fmtPython(dirPath: string, files: SourceFile[], acc: FmtAccumulator): Promise<void> {
  const targets = filesByExt(files, PY_FMT_EXTS);
  if (targets.length === 0) return;

  acc.totalFiles += targets.length;
  let reformatCount = 0;
  const findings: typeof acc.findings = [];

  for (const chunk of chunkFileList(targets)) {
    const result = await runCommand('black', ['--check', '--quiet', ...chunk], dirPath);
    acc.ran = true;
    if (result.exitCode === 0) continue;

    const reformatLines = result.stderr.split('\n').filter((l) => l.includes('would reformat'));
    reformatCount += reformatLines.length;
    for (const line of reformatLines) {
      const match = line.match(/would reformat (.+)/);
      if (match) findings.push({ severity: 'low', category: 'format', file: match[1].trim(), line: null, title: 'File not formatted', description: 'Does not match Black formatting rules.' });
    }
  }

  acc.passingFiles += Math.max(0, targets.length - reformatCount);
  acc.findings.push(...findings);
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
// Legacy Scoring Breakdown — produces the per-category penalty data still
// consumed by older UI surfaces and persisted reports. The canonical grade
// now comes from the multi-dimensional `computeQualityRating`; this function
// only fills in `scoreBreakdown` so existing dashboards keep rendering.
// ============================================================================

/**
 * Score-to-grade conversion for legacy callers. Delegates to the shared
 * grading module so there is one source of truth. Returns `string` to satisfy
 * the wider `QualityResults.grade` field — `gradeFromScore` itself never
 * returns the `'N/A'` variant of the shared `Grade` union.
 */
function computeGrade(score: number): string {
  return gradeFromScore(score);
}

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 10,
  high: 5,
  medium: 2,
  low: 0.5,
};

const CATEGORY_MULTIPLIER: Record<string, number> = {
  security: 2.0,
  bugs: 1.5,
  architecture: 1.2,
  logic: 1.2,
  performance: 1.0,
  oop: 0.8,
  maintainability: 0.8,
  complexity: 0.7,
  lint: 0.5,
  linting: 0.5,
  format: 0.3,
  'file-length': 0.3,
  'function-length': 0.3,
};

const OVERALL_DECAY = 0.09;
const CATEGORY_DECAY = 0.20;

function findingPenalty(f: { severity: string; category: string }): number {
  return (SEVERITY_WEIGHT[f.severity] ?? 2) * (CATEGORY_MULTIPLIER[f.category] ?? 1.0);
}

export function computeFormulaScore(
  allFindings: Array<{ severity: string; category: string }>,
  totalLines: number,
): { score: number; breakdown: ScoreBreakdown } {
  const kloc = Math.max(totalLines / 1000, 1.0);

  if (allFindings.length === 0) {
    return {
      score: 100,
      breakdown: { penaltyDensity: 0, totalPenalty: 0, issueDensity: 0, kloc, categoryPenalties: [] },
    };
  }

  const byCategory = new Map<string, { penalty: number; count: number }>();
  let totalPenalty = 0;

  for (const f of allFindings) {
    const p = findingPenalty(f);
    totalPenalty += p;
    const existing = byCategory.get(f.category);
    if (existing) {
      existing.penalty += p;
      existing.count++;
    } else {
      byCategory.set(f.category, { penalty: p, count: 1 });
    }
  }

  const penaltyDensity = totalPenalty / kloc;
  const score = Math.round(100 * Math.exp(-OVERALL_DECAY * penaltyDensity));

  const categoryPenalties: CategoryPenalty[] = [];
  for (const [cat, data] of byCategory) {
    const catDensity = data.penalty / kloc;
    const catScore = Math.round(100 * Math.exp(-CATEGORY_DECAY * catDensity));
    categoryPenalties.push({
      category: cat,
      score: catScore,
      grade: computeGrade(catScore),
      penalty: Math.round(data.penalty * 10) / 10,
      findingCount: data.count,
    });
  }

  categoryPenalties.sort((a, b) => a.score - b.score);

  return {
    score,
    breakdown: {
      penaltyDensity: Math.round(penaltyDensity * 100) / 100,
      totalPenalty: Math.round(totalPenalty * 10) / 10,
      issueDensity: Math.round((allFindings.length / kloc) * 100) / 100,
      kloc: Math.round(kloc * 10) / 10,
      categoryPenalties,
    },
  };
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
  const complexityResult = await analyzeComplexity(dirPath, ecosystems, files, installedToolNames);

  // Step 5: Check file lengths
  progress('Checking file lengths', 5);
  const fileLengthResult = analyzeFileLength(files);

  // Step 6: Check function lengths
  progress('Checking function lengths', 6);
  const funcLengthResult = analyzeFunctionLength(files);

  // Step 7: Compute scores
  progress('Computing scores', 7);

  const allFindings = [
    ...lintResult.findings,
    ...fmtResult.findings,
    ...complexityResult.findings,
    ...fileLengthResult.findings,
    ...funcLengthResult.findings,
  ];

  const totalLines = files.reduce((sum, f) => sum + f.lines, 0);
  // Legacy breakdown — drives the per-category panels and persisted `scoreBreakdown`.
  const { breakdown } = computeFormulaScore(allFindings, totalLines);
  // Canonical multi-dimensional rating — drives `overall`, `grade`, and the
  // new dimensions/qualityGate/gradeRationale fields. Force Maintainability
  // to N/A when no real maintainability tool ran (file/function length alone
  // would otherwise let a clean codebase claim grade A even though linting
  // was never checked).
  const forceNA = new Set<DimensionName>();
  if (!hasLinter && !hasFormatter && !complexityResult.available) {
    forceNA.add('maintainability');
  }
  const rating = computeQualityRating(allFindings, totalLines, { forceNA });

  const categories: CategoryScore[] = [
    { name: 'Linting', score: lintResult.score, available: lintResult.available, issueCount: lintResult.issueCount },
    { name: 'Formatting', score: fmtResult.score, available: fmtResult.available, issueCount: fmtResult.issueCount },
    { name: 'Complexity', score: complexityResult.score, available: complexityResult.available, issueCount: complexityResult.issueCount },
    { name: 'File Length', score: fileLengthResult.score, available: true, issueCount: fileLengthResult.issueCount },
    { name: 'Function Length', score: funcLengthResult.score, available: true, issueCount: funcLengthResult.issueCount },
  ];

  return {
    overall: rating.overall.score,
    grade: rating.overall.grade,
    categories,
    findings: allFindings.slice(0, 200),
    codeReview: [],
    analyzedFiles: files.length,
    totalLines,
    timestamp: new Date().toISOString(),
    ecosystem: ecosystems,
    scoreBreakdown: breakdown,
    dimensions: rating.dimensions,
    qualityGate: rating.qualityGate,
    gradeRationale: rating.gradeRationale,
  };
}

// ============================================================================
// Recompute with AI Review
// ============================================================================

/**
 * Recompute the overall score after AI code review findings become available.
 * Merges CLI + AI findings, runs the canonical multi-dimensional rating, and
 * recomputes the legacy `scoreBreakdown` so both new and old UI surfaces stay
 * in sync after the merge.
 */
export function recomputeWithAiReview(
  results: QualityResults,
  aiFindings: Array<{ severity: string; category: string }>,
): QualityResults {
  const allFindings = [...results.findings, ...aiFindings];
  const { breakdown } = computeFormulaScore(allFindings, results.totalLines);
  // Preserve the Maintainability N/A signal across AI re-merges by deriving
  // forceNA from category availability snapshotted in the original scan.
  const forceNA = new Set<DimensionName>();
  const linting = results.categories.find((c) => c.name === 'Linting');
  const formatting = results.categories.find((c) => c.name === 'Formatting');
  const complexity = results.categories.find((c) => c.name === 'Complexity');
  if (!linting?.available && !formatting?.available && !complexity?.available) {
    forceNA.add('maintainability');
  }
  const rating = computeQualityRating(allFindings, results.totalLines, { forceNA });

  return {
    ...results,
    overall: rating.overall.score,
    grade: rating.overall.grade,
    codeReview: results.codeReview,
    scoreBreakdown: breakdown,
    dimensions: rating.dimensions,
    qualityGate: rating.qualityGate,
    gradeRationale: rating.gradeRationale,
  };
}
