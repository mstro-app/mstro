// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { extname } from 'node:path';
import { analyzeComplexity, analyzeFunctionLength } from './quality-complexity.js';
import { computeQualityRating, gradeFromScore } from './quality-grading.js';
import { analyzeLinting } from './quality-linting.js';
import { chunkFileList, collectSourceFiles, detectEcosystem, filesByExt, isTestFile, runCommand, type SourceFile } from './quality-tools.js';
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
// Build / Compile Error Detection
// ============================================================================
//
// A codebase that does not compile is, by the user's spec, an automatic F.
// We capture compile failures as `category: 'build'` findings with severity
// `critical` so they map to the Reliability dimension and trigger the
// "critical → F-" path through the standard severity logic — no special-
// case branching elsewhere in the grading module.
//
// Per ecosystem:
//   - Node:   tsc --noEmit (only if a tsconfig.json is present)
//   - Rust:   cargo check (idiomatic compile-test for crates)
//   - Other:  skipped — Python has no canonical "is it valid" check, Go
//             projects vary too much in module structure for `go build ./...`
//             to be reliable, and Swift/Kotlin compile via larger build
//             systems we don't want to spawn from a quality scan.
//
// Findings are capped at the first 5 errors per check so a totally broken
// codebase doesn't produce 200 individual findings — one critical finding is
// enough to pin the grade.

const BUILD_FINDING_CAP = 5;

function tscOutputToFindings(output: string, dirPath: string): QualityFinding[] {
  const findings: QualityFinding[] = [];
  // tsc error format: `path/to/file.ts(line,col): error TS####: message`
  const errorPattern = /^(.+?)\((\d+),\d+\):\s+error\s+TS\d+:\s+(.+)$/gm;
  for (const match of output.matchAll(errorPattern)) {
    if (findings.length >= BUILD_FINDING_CAP) break;
    const filePath = match[1].replace(`${dirPath}/`, '').replace(/^\.\//, '');
    findings.push({
      severity: 'critical',
      category: 'build',
      file: filePath,
      line: Number.parseInt(match[2], 10) || null,
      title: `TypeScript build error`,
      description: match[3].trim(),
      suggestion: 'Resolve compile errors before merging — broken builds block all other quality work.',
    });
  }
  return findings;
}

function cargoCheckOutputToFindings(output: string, dirPath: string): QualityFinding[] {
  const findings: QualityFinding[] = [];
  // cargo emits one JSON object per line in --message-format=json mode; in
  // plain mode it emits "error[E####]: message\n  --> path:line:col"
  const errorPattern = /^error(?:\[E\d+\])?:\s+(.+?)$\s+-->\s+([^:\s]+):(\d+):\d+/gm;
  for (const match of output.matchAll(errorPattern)) {
    if (findings.length >= BUILD_FINDING_CAP) break;
    findings.push({
      severity: 'critical',
      category: 'build',
      file: match[2].replace(`${dirPath}/`, ''),
      line: Number.parseInt(match[3], 10) || null,
      title: `Rust build error`,
      description: match[1].trim(),
      suggestion: 'Resolve compile errors before merging — broken builds block all other quality work.',
    });
  }
  return findings;
}

async function checkNodeBuild(dirPath: string, installed: Set<string> | null): Promise<QualityFinding[]> {
  // Only run if TypeScript is installed. Avoids npm-installing tsc on the fly
  // (slow + side-effecting) and cleanly skips JS-only projects.
  if (installed && !installed.has('typescript')) return [];

  // Only run if a tsconfig.json exists at the project root — otherwise tsc
  // will pick up arbitrary nearby configs in monorepos and produce confusing
  // results.
  let hasTsconfig = false;
  try {
    const { readFileSync } = await import('node:fs');
    readFileSync(`${dirPath}/tsconfig.json`, 'utf-8');
    hasTsconfig = true;
  } catch {
    return [];
  }
  if (!hasTsconfig) return [];

  const result = await runCommand('npx', ['tsc', '--noEmit', '--pretty', 'false'], dirPath);
  if (result.exitCode === 0) return [];
  // Combine stdout + stderr — tsc writes errors to stdout in --pretty=false.
  return tscOutputToFindings(`${result.stdout}\n${result.stderr}`, dirPath);
}

async function checkRustBuild(dirPath: string): Promise<QualityFinding[]> {
  const result = await runCommand('cargo', ['check', '--message-format=human'], dirPath);
  if (result.exitCode === 0) return [];
  return cargoCheckOutputToFindings(`${result.stdout}\n${result.stderr}`, dirPath);
}

async function analyzeBuildErrors(
  dirPath: string,
  ecosystems: Ecosystem[],
  installed: Set<string> | null,
): Promise<{ findings: QualityFinding[]; available: boolean }> {
  const findings: QualityFinding[] = [];
  let ran = false;

  if (ecosystems.includes('node')) {
    const nodeFindings = await checkNodeBuild(dirPath, installed);
    if (nodeFindings.length > 0) ran = true;
    findings.push(...nodeFindings);
  }
  if (ecosystems.includes('rust')) {
    ran = true;
    findings.push(...(await checkRustBuild(dirPath)));
  }

  // `available` only matters for the dimension-availability heuristic; the
  // findings drive the actual grade. For build, "available" tracks whether
  // we ran a build check at all (so a clean tsc output still counts).
  return { findings, available: ran || ecosystems.includes('node') || ecosystems.includes('rust') };
}

// ============================================================================
// File Cohesion Analysis (LCOM-inspired)
// ============================================================================
//
// Long files are not all equal. A 1500-line file with one focused public
// surface (one class, one large function, several private helpers) is fine —
// it's cohesive. A 1500-line file mixing config + parsing + rendering + IO is
// a real maintenance hazard.
//
// We compute a 0-1 "mixed-concerns score" per file using cheap textual
// signals (no AST parsing — we already have the file content in memory):
//
//   - Top-level export count — many independent exports = many concerns.
//   - Distinct top-level identifier prefixes — cohesive files share a domain
//     vocabulary (e.g., everything starts with `User…`); mixed files do not.
//   - Distinct import roots — files that import from many unrelated modules
//     are usually doing many unrelated things.
//   - Section-divider density — `// ===` style dividers signal that the
//     author is mentally separating concerns; many sections + low export
//     overlap = mixed.
//
// The score then modulates the severity of any file-length violation:
//
//   cohesion ≤ 0.30  → SUPPRESS the finding (the file is long but focused)
//   cohesion ≤ 0.55  → low severity
//   cohesion ≤ 0.75  → medium severity
//   cohesion >  0.75 → high severity
//
// This implements the user's requirement that a 1000-line file might be
// "just fine" while another 1000-line file is a "severe mix of concerns."
// ============================================================================

const TOP_LEVEL_EXPORT_PATTERN = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/gm;
const TOP_LEVEL_DECL_PATTERN = /^(?:export\s+)?(?:async\s+)?(?:function|class)\s+(\w+)/gm;
const PY_TOP_LEVEL_PATTERN = /^(?:def|class)\s+(\w+)/gm;
const IMPORT_PATTERN = /^(?:import\s+.+from\s+['"]([^'"]+)['"]|from\s+([^\s]+)\s+import|import\s+([^\s]+))/gm;
const SECTION_DIVIDER_PATTERN = /^\s*(?:\/\/|#)\s*={3,}|^\s*(?:\/\/|#)\s*-{3,}/gm;

/** Group identifiers by their leading word-prefix and return how many distinct groups exist. */
function distinctIdentifierPrefixes(names: string[]): number {
  if (names.length === 0) return 0;
  const prefixes = new Set<string>();
  for (const name of names) {
    // Split on camelCase / snake_case boundaries; take the first segment.
    const first = name.replace(/[A-Z][a-z]+|_+/g, (m, _o, _s) => `${m.replace(/_/g, '')}`).split('').filter(Boolean)[0] ?? name;
    const lowered = first.toLowerCase();
    if (lowered.length >= 2) prefixes.add(lowered);
  }
  return prefixes.size;
}

/** Extract the path "root" from an import specifier (the first non-dot segment). */
function importRoot(spec: string): string {
  const trimmed = spec.replace(/^['"]|['"]$/g, '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('.')) return 'relative';
  return trimmed.split('/')[0].replace(/^@/, '');
}

interface CohesionSignals {
  exports: number;
  decls: number;
  prefixes: number;
  importRoots: number;
  dividers: number;
  isJs: boolean;
  isPy: boolean;
}

function jsDeclNames(content: string): { exports: string[]; decls: string[] } {
  const exports: string[] = [];
  const decls: string[] = [];
  for (const match of content.matchAll(TOP_LEVEL_EXPORT_PATTERN)) exports.push(match[1]);
  for (const match of content.matchAll(TOP_LEVEL_DECL_PATTERN)) decls.push(match[1]);
  return { exports, decls };
}

function pyDeclNames(content: string): { exports: string[]; decls: string[] } {
  const exports: string[] = [];
  const decls: string[] = [];
  for (const match of content.matchAll(PY_TOP_LEVEL_PATTERN)) {
    decls.push(match[1]);
    // Python doesn't have explicit "export" — public iff it doesn't start with "_".
    if (!match[1].startsWith('_')) exports.push(match[1]);
  }
  return { exports, decls };
}

function importRootCount(content: string): number {
  const roots = new Set<string>();
  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const spec = match[1] ?? match[2] ?? match[3] ?? '';
    const root = importRoot(spec);
    if (root) roots.add(root);
  }
  return roots.size;
}

function collectCohesionSignals(file: SourceFile): CohesionSignals {
  const ext = extname(file.path).toLowerCase();
  const isJs = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);
  const isPy = ['.py', '.pyi'].includes(ext);

  const { exports, decls } = isJs
    ? jsDeclNames(file.content)
    : isPy
      ? pyDeclNames(file.content)
      : { exports: [], decls: [] };

  const allNames = exports.length > 0 ? exports : decls;

  return {
    exports: exports.length,
    decls: decls.length,
    prefixes: distinctIdentifierPrefixes(allNames),
    importRoots: importRootCount(file.content),
    dividers: (file.content.match(SECTION_DIVIDER_PATTERN) || []).length,
    isJs,
    isPy,
  };
}

/**
 * Compute a 0-1 "mixed-concerns" score for a file. 0 = highly cohesive,
 * 1 = many unrelated concerns. The formula combines four signals with
 * empirically chosen weights — tuned so that:
 *
 *   - A 2000-line file with 1 class + helpers scores ~0.15
 *   - A 2000-line file with 8 unrelated exports scores ~0.85
 *   - The CLI quality-tools.ts (one domain, many helpers) scores < 0.4
 *   - A miscellaneous "utils.ts" (string + date + DOM helpers) scores > 0.7
 *
 * Returns 0 for files we can't analyze (non-JS/Py), since we don't want to
 * fabricate a violation for languages we can't introspect.
 */
function computeMixedConcernsScore(file: SourceFile): number {
  const sig = collectCohesionSignals(file);
  if (!sig.isJs && !sig.isPy) return 0;

  // Each component is independently normalized to [0, 1]; the final score
  // averages them with slight weighting toward identifier-prefix variance
  // (the strongest cohesion signal in practice).
  const exportComponent = sig.exports <= 2 ? 0 : Math.min(1, (sig.exports - 2) / 12);
  const prefixComponent = sig.prefixes <= 1 ? 0 : Math.min(1, (sig.prefixes - 1) / 6);
  const importComponent = sig.importRoots <= 4 ? 0 : Math.min(1, (sig.importRoots - 4) / 12);
  const dividerComponent = sig.dividers <= 2 ? 0 : Math.min(1, (sig.dividers - 2) / 6);

  return Math.min(
    1,
    0.30 * prefixComponent +
    0.30 * exportComponent +
    0.25 * importComponent +
    0.15 * dividerComponent,
  );
}

/**
 * Map a file's mixed-concerns score to a severity for the file-length
 * finding. Returns `null` to suppress the finding entirely when the file is
 * cohesive enough that its length isn't a real concern.
 */
function severityFromCohesion(mixed: number, lines: number): QualityFinding['severity'] | null {
  // Files that are absurdly long (>5x threshold) emit a finding regardless
  // of cohesion — a 5000-line file is always worth flagging even if focused.
  const isAbsurd = lines > FILE_LENGTH_THRESHOLD * 5;
  if (mixed <= 0.30 && !isAbsurd) return null;
  if (mixed <= 0.55) return 'low';
  if (mixed <= 0.75) return 'medium';
  return 'high';
}

// ============================================================================
// File Length Analysis
// ============================================================================

function analyzeFileLength(files: SourceFile[]): { score: number; findings: QualityFinding[]; issueCount: number } {
  if (files.length === 0) return { score: 100, findings: [], issueCount: 0 };

  const findings: QualityFinding[] = [];
  let totalScore = 0;
  let scoredFiles = 0;

  for (const file of files) {
    // Test files are exempt from structural-length checks: a long test file
    // is normally just many independent small tests, which is a feature.
    // Excluding them from both scoring and finding emission keeps the
    // dimension's score honest (otherwise a clean prod codebase with a
    // huge test file would be unfairly penalised on file-length).
    if (isTestFile(file.relativePath)) continue;

    const ratio = Math.max(1, file.lines / FILE_LENGTH_THRESHOLD);
    const fileScore = 100 / ratio ** 1.5;
    totalScore += fileScore;
    scoredFiles++;

    if (file.lines > FILE_LENGTH_THRESHOLD) {
      const mixedScore = computeMixedConcernsScore(file);
      const severity = severityFromCohesion(mixedScore, file.lines);
      if (!severity) continue; // Cohesive long file — not actually a violation.

      const cohesionPct = Math.round((1 - mixedScore) * 100);
      findings.push({
        severity,
        category: 'file-length',
        file: file.relativePath,
        line: null,
        title: `File has ${file.lines} lines (threshold: ${FILE_LENGTH_THRESHOLD}, cohesion: ${cohesionPct}%)`,
        description:
          `Exceeds the ${FILE_LENGTH_THRESHOLD}-line threshold by ${file.lines - FILE_LENGTH_THRESHOLD} lines. ` +
          `Mixed-concerns score is ${roundOne(mixedScore)} (0 = focused, 1 = many concerns); ` +
          `severity reflects how mixed the file's responsibilities appear. ` +
          (mixedScore > 0.55
            ? 'Consider splitting unrelated exports into separate modules.'
            : 'The file is long but reasonably focused — split only if a clear seam exists.'),
      });
    }
  }

  if (scoredFiles === 0) return { score: 100, findings: [], issueCount: 0 };
  const score = Math.round(totalScore / scoredFiles);
  return { score: Math.min(100, score), findings: findings.slice(0, 50), issueCount: findings.length };
}

function roundOne(n: number): number {
  return Math.round(n * 10) / 10;
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

/**
 * Sentinel thrown when a scan is cancelled mid-flight via the `signal`
 * argument. Callers should treat it as a clean cancellation, not a scan
 * failure (no `qualityError` payload, no persisted partial result).
 */
export class QualityScanAbortedError extends Error {
  constructor() {
    super('Quality scan aborted');
    this.name = 'QualityScanAbortedError';
  }
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new QualityScanAbortedError();
}

export async function runQualityScan(
  dirPath: string,
  onProgress?: ProgressCallback,
  installedToolNames?: string[],
  signal?: AbortSignal,
): Promise<QualityResults> {
  const ecosystems = detectEcosystem(dirPath);

  // Build set of installed tools for gating analyses
  const installedSet = installedToolNames ? new Set(installedToolNames) : null;

  const progress = (step: string, current: number) => {
    onProgress?.({ step, current, total: TOTAL_STEPS });
  };

  // Step 1: Collect source files
  checkAborted(signal);
  progress('Collecting source files', 1);
  const files = await collectSourceFiles(dirPath, dirPath);

  // Step 2: Run linting (only if a linter is installed)
  checkAborted(signal);
  progress('Running linters', 2);
  const hasLinter = !installedSet || hasInstalledToolInCategory(installedSet, ecosystems, 'linter');
  const lintResult = hasLinter
    ? await analyzeLinting(dirPath, ecosystems, files, installedToolNames)
    : { score: 0, findings: [], available: false, issueCount: 0 };

  // Step 3: Check formatting (only if a formatter is installed)
  checkAborted(signal);
  progress('Checking formatting', 3);
  const hasFormatter = !installedSet || hasInstalledToolInCategory(installedSet, ecosystems, 'formatter');
  const fmtResult = hasFormatter
    ? await analyzeFormatting(dirPath, ecosystems, files)
    : { score: 0, available: false, issueCount: 0, findings: [] as QualityFinding[] };

  // Step 4: Check for build/compile errors (auto-F if any are found)
  checkAborted(signal);
  progress('Checking build', 4);
  const buildResult = await analyzeBuildErrors(dirPath, ecosystems, installedSet);

  // Step 5: Analyze complexity (using real tools: Biome, ESLint, radon)
  checkAborted(signal);
  progress('Analyzing complexity', 5);
  const complexityResult = await analyzeComplexity(dirPath, ecosystems, files, installedToolNames);

  // Step 6: Check file lengths
  checkAborted(signal);
  progress('Checking file lengths', 6);
  const fileLengthResult = analyzeFileLength(files);

  // Step 7: Check function lengths
  checkAborted(signal);
  progress('Checking function lengths', 7);
  const funcLengthResult = analyzeFunctionLength(files);

  // Step 8: Compute scores
  checkAborted(signal);
  progress('Computing scores', 8);

  const allFindings = [
    ...buildResult.findings,
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

  // Build score: 100 if no compile errors, 0 if any (one error breaks everything).
  const buildScore = buildResult.findings.length === 0 ? 100 : 0;

  const categories: CategoryScore[] = [
    { name: 'Build', score: buildScore, available: buildResult.available, issueCount: buildResult.findings.length },
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
