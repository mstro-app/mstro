// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

// ============================================================================
// Types
// ============================================================================

/**
 * Letter grades produced by the multi-dimensional quality rating.
 *
 * Score → grade mapping (per product spec — note: no `D`; F covers 56-69, F-
 * covers 0-55. `D` is retained ONLY for backward compatibility with reports
 * persisted by older versions of this module — new code never emits it):
 *
 *   A+  97-100   A   93-96    A-  90-92
 *   B+  87-89    B   83-86    B-  80-82
 *   C+  77-79    C   73-76    C-  70-72
 *   F+  65-69    F   56-64    F-  0-55
 *
 * `N/A` means the dimension had no tooling available to evaluate it.
 */
export type Grade =
  | 'A+' | 'A' | 'A-'
  | 'B+' | 'B' | 'B-'
  | 'C+' | 'C' | 'C-'
  | 'D' // legacy — only appears on reports persisted before the +/- rollout
  | 'F+' | 'F' | 'F-'
  | 'N/A';
export type DimensionName = 'security' | 'reliability' | 'maintainability';

export interface DimensionScore {
  name: DimensionName;
  score: number;
  grade: Grade;
  rationale: string;
  available: boolean;
  findingCount: number;
  worstSeverity: 'critical' | 'high' | 'medium' | 'low' | null;
}

export interface QualityGate {
  passed: boolean;
  failingConditions: string[];
}

export interface QualityTool {
  name: string;
  installed: boolean;
  installCommand: string;
  category: 'linter' | 'formatter' | 'complexity' | 'general';
}

export interface CategoryScore {
  name: string;
  score: number;
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
  evidence?: string;
  verified?: boolean;
  verificationNote?: string;
}

export interface CategoryPenalty {
  category: string;
  score: number;
  grade: string;
  penalty: number;
  findingCount: number;
}

export interface ScoreBreakdown {
  penaltyDensity: number;
  totalPenalty: number;
  issueDensity: number;
  kloc: number;
  categoryPenalties: CategoryPenalty[];
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
  scoreBreakdown?: ScoreBreakdown;
  dimensions?: DimensionScore[];
  qualityGate?: QualityGate;
  gradeRationale?: string;
  /** Wall-clock duration of the CLI scan that produced this report. Used to estimate ETA on subsequent scans of the same directory. */
  scanDurationMs?: number;
  /** Wall-clock duration of the AI code-review pass, when one ran. */
  reviewDurationMs?: number;
}

export interface ScanProgress {
  step: string;
  current: number;
  total: number;
  /**
   * Wall-clock estimate of the total scan duration, in milliseconds. Sent on
   * the first progress event of a scan and again on subsequent events so
   * reconnecting clients still get an ETA. The web subtracts elapsed time to
   * render "≈ X remaining".
   */
  etaMs?: number;
  /**
   * Server-side timestamp (ms since epoch) of when the scan started — paired
   * with `etaMs` so the web can compute elapsed time without trusting its
   * own clock alignment.
   */
  startedAt?: number;
  /** Optional sub-step detail used by long-running steps (e.g. "tsc --noEmit, 18s elapsed") to keep the UI from looking stuck. */
  detail?: string;
}

export type Ecosystem = 'node' | 'python' | 'rust' | 'go' | 'swift' | 'kotlin' | 'unknown';

export interface ToolSpec {
  name: string;
  check: string[];
  category: QualityTool['category'];
  installCmd: string;
}

// ============================================================================
// Constants
// ============================================================================

export const ECOSYSTEM_TOOLS: Record<Ecosystem, ToolSpec[]> = {
  node: [
    { name: 'eslint', check: ['npx', 'eslint', '--version'], category: 'linter', installCmd: 'npm install -D eslint' },
    { name: 'biome', check: ['npx', '@biomejs/biome', '--version'], category: 'linter', installCmd: 'npm install -D @biomejs/biome' },
    { name: 'prettier', check: ['npx', 'prettier', '--version'], category: 'formatter', installCmd: 'npm install -D prettier' },
    { name: 'typescript', check: ['npx', 'tsc', '--version'], category: 'general', installCmd: 'npm install -D typescript' },
  ],
  python: [
    { name: 'ruff', check: ['ruff', '--version'], category: 'linter', installCmd: 'uv tool install ruff || pip install ruff' },
    { name: 'black', check: ['black', '--version'], category: 'formatter', installCmd: 'uv tool install black || pip install black' },
    { name: 'radon', check: ['radon', '--version'], category: 'complexity', installCmd: 'uv tool install radon || pip install radon' },
  ],
  rust: [
    { name: 'clippy', check: ['cargo', 'clippy', '--version'], category: 'linter', installCmd: 'rustup component add clippy' },
    { name: 'rustfmt', check: ['rustfmt', '--version'], category: 'formatter', installCmd: 'rustup component add rustfmt' },
  ],
  go: [
    { name: 'golangci-lint', check: ['golangci-lint', '--version'], category: 'linter', installCmd: 'go install github.com/golangci-lint/golangci-lint/cmd/golangci-lint@latest' },
    { name: 'gofmt', check: ['gofmt', '-h'], category: 'formatter', installCmd: '(built-in with Go)' },
  ],
  swift: [
    { name: 'swiftlint', check: ['swiftlint', '--version'], category: 'linter', installCmd: 'brew install swiftlint' },
    { name: 'swiftformat', check: ['swiftformat', '--version'], category: 'formatter', installCmd: 'brew install swiftformat' },
  ],
  kotlin: [
    { name: 'ktlint', check: ['ktlint', '--version'], category: 'linter', installCmd: 'brew install ktlint' },
    { name: 'ktfmt', check: ['ktfmt', '--version'], category: 'formatter', installCmd: 'brew install ktfmt' },
  ],
  unknown: [],
};

export const SOURCE_EXTENSIONS = new Set([
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

/** Git-tracked files to skip in quality analysis (lock files, generated code, etc.) */
export const ADDITIONAL_EXCLUDES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'composer.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'poetry.lock',
  'go.sum',
]);

export const FILE_LENGTH_THRESHOLD = 300;
export const FUNCTION_LENGTH_THRESHOLD = 50;
export const TOTAL_STEPS = 8;

export function hasInstalledToolInCategory(
  installedSet: Set<string>,
  ecosystems: Ecosystem[],
  category: QualityTool['category'],
): boolean {
  for (const eco of ecosystems) {
    const specs = ECOSYSTEM_TOOLS[eco] || [];
    for (const spec of specs) {
      if (spec.category === category && installedSet.has(spec.name)) return true;
    }
  }
  return false;
}

// ============================================================================
// Shared Diagnostic Helpers
// ============================================================================

export function biomeSeverity(severity: string): QualityFinding['severity'] {
  if (severity === 'error') return 'high';
  if (severity === 'warning') return 'medium';
  return 'low';
}

export function isBiomeComplexityDiagnostic(d: Record<string, unknown>): boolean {
  return ((d.category as string) || '').includes('/complexity/');
}

export function isEslintComplexityRule(ruleId: string | null | undefined): boolean {
  if (!ruleId) return false;
  return ruleId === 'complexity' || ruleId.endsWith('-complexity') || ruleId.endsWith('/complexity');
}

export function biomeDiagToFinding(d: Record<string, unknown>, category: QualityFinding['category']): QualityFinding {
  const sev = biomeSeverity(d.severity as string);
  const location = d.location as Record<string, unknown> | undefined;
  const span = (location?.span as Record<string, unknown>) ?? {};
  const start = (span.start as Record<string, unknown>) ?? {};
  const message = d.message as Record<string, unknown> | string | undefined;
  const desc = (typeof message === 'object' ? (message?.text as string) : message) || '';
  const ruleName = ((d.category as string) || '').split('/').pop() || 'Issue';
  return {
    severity: sev,
    category,
    file: (location?.path as string) || '',
    line: (start.line as number) ?? null,
    title: ruleName,
    description: desc,
  };
}
