// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

// ============================================================================
// Multi-Dimensional Quality Grading
// ============================================================================
//
// Three independent dimensions, severity-driven where it matters most:
//
//   - Security        — strictest; any medium-or-worse issue capped below B
//   - Reliability     — slightly lenient (not every complexity warning is a bug)
//   - Maintainability — density-based (issues / KLOC) with a severity cap
//
// Letter grade scale (no `D` band — F covers 56-69, F- below 55):
//
//     A+  97-100   A   93-96    A-  90-92      "ship it"
//     B+  87-89    B   83-86    B-  80-82      "minor cleanup"
//     C+  77-79    C   73-76    C-  70-72      "needs work"
//     F+  65-69    F   56-64    F-  0-55       "broken"
//
// Three "auto-fail" rules layer on top of the dimension grades:
//
//   1. Build/compile errors    → caps Reliability at F-
//   2. Critical security issue → caps Security at F-
//   3. Architectural findings  → drop the affected dim's grade by 1-2 letters
//
// Industry alignment: SonarQube uses severity-driven A-E grades; Code Climate
// uses density-driven A-F. This module borrows the strictness of the former
// for Security/Reliability and the density model of the latter for
// Maintainability — matching the two metrics where each works best.
//
// All functions in this module are pure: same inputs -> same outputs, no I/O.
// ============================================================================

// ============================================================================
// Types
// ============================================================================

export type DimensionName = 'security' | 'reliability' | 'maintainability';

/**
 * Letter grades. New code emits all variants except `'D'` (kept only for
 * legacy reports persisted before the +/- rollout). See quality-types.ts for
 * the score-band reference.
 */
export type Grade =
  | 'A+' | 'A' | 'A-'
  | 'B+' | 'B' | 'B-'
  | 'C+' | 'C' | 'C-'
  | 'D'
  | 'F+' | 'F' | 'F-'
  | 'N/A';

/** Letter grades excluding modifiers — used internally for band logic. */
type BaseGrade = 'A' | 'B' | 'C' | 'F';

type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface DimensionScore {
  name: DimensionName;
  score: number;
  grade: Grade;
  rationale: string;
  available: boolean;
  findingCount: number;
  worstSeverity: Severity | null;
}

export interface QualityGate {
  passed: boolean;
  failingConditions: string[];
}

export interface QualityRating {
  overall: { score: number; grade: Grade };
  dimensions: DimensionScore[];
  qualityGate: QualityGate;
  gradeRationale: string;
}

// ============================================================================
// Category -> Dimension Mapping
// ============================================================================

const SECURITY_CATEGORIES = new Set<string>(['security']);
const RELIABILITY_CATEGORIES = new Set<string>(['bugs', 'logic', 'performance', 'complexity', 'build']);
const MAINTAINABILITY_CATEGORIES = new Set<string>([
  'lint',
  'linting',
  'format',
  'file-length',
  'function-length',
  'architecture',
  'oop',
  'maintainability',
]);

/**
 * Map a finding category to one of the three quality dimensions.
 * Unknown categories default to maintainability (the catch-all bucket) so
 * that surprise categories never silently disappear from the grade.
 */
export function categoryToDimension(category: string): DimensionName {
  if (SECURITY_CATEGORIES.has(category)) return 'security';
  if (RELIABILITY_CATEGORIES.has(category)) return 'reliability';
  if (MAINTAINABILITY_CATEGORIES.has(category)) return 'maintainability';
  return 'maintainability';
}

/** Categories that represent architectural problems — used by the arch penalty. */
const ARCHITECTURE_CATEGORIES = new Set<string>(['architecture', 'oop']);

// ============================================================================
// Score Bands & Modifier Math
// ============================================================================

/**
 * Score boundaries for each base grade. Note the gap between C (70+) and F+
 * (≤69): the band 60-69 maps to F+ instead of D, per product spec ("60s and
 * below is F").
 */
const BASE_BAND_TOP: Record<BaseGrade, number> = {
  A: 100,
  B: 89,
  C: 79,
  F: 69, // F covers 56-69 (F+ for 65-69, F for 56-64) — F- splits off below
};
const BASE_BAND_BOTTOM: Record<BaseGrade, number> = {
  A: 90,
  B: 80,
  C: 70,
  F: 56, // F- covers 0-55 — handled specially in scoreToGrade()
};

/**
 * Convert a 0-100 score to the full letter grade including +/- modifier.
 *
 * Within an A/B/C band, the band is split into thirds:
 *   X-  bottom third (e.g., A-: 90-92)
 *   X   middle third (e.g., A : 93-96)
 *   X+  top third    (e.g., A+: 97-100)
 *
 * The F band uses two slices instead of three because there is no academic
 * "F0" anchor and the user wanted F+/F/F-:
 *   F-  0-55           "critically broken"
 *   F   56-64          "broken"
 *   F+  65-69          "barely failing"
 *
 * Compile/critical-severity hard caps are applied separately, not by score.
 */
export function scoreToGrade(score: number): Grade {
  if (score >= 97) return 'A+';
  if (score >= 93) return 'A';
  if (score >= 90) return 'A-';
  if (score >= 87) return 'B+';
  if (score >= 83) return 'B';
  if (score >= 80) return 'B-';
  if (score >= 77) return 'C+';
  if (score >= 73) return 'C';
  if (score >= 70) return 'C-';
  if (score >= 65) return 'F+';
  if (score >= 56) return 'F';
  return 'F-';
}

/**
 * Legacy single-letter conversion. Returns the *base* grade only (no
 * modifier) for compatibility with callers that pre-date the +/- rollout
 * (`scoreBreakdown.categoryPenalties[].grade`, etc.). New surfaces should
 * call `scoreToGrade()` instead.
 */
export function gradeFromScore(score: number): Grade {
  const full = scoreToGrade(score);
  // Strip the modifier so legacy callers still see exactly one of A/B/C/F.
  return baseGradeOf(full);
}

/** Strip the +/- modifier from a letter grade. */
function baseGradeOf(g: Grade): Grade {
  if (g === 'N/A' || g === 'D') return g;
  if (g.startsWith('A')) return 'A';
  if (g.startsWith('B')) return 'B';
  if (g.startsWith('C')) return 'C';
  return 'F';
}

/**
 * Linearly interpolate a score within a base band.
 *
 * `position` is in [0, 1]: 0 = "as bad as this grade gets" (band bottom),
 * 1 = "as good as this grade gets" (band top, just below the next grade).
 */
function scoreInBand(grade: BaseGrade, position: number): number {
  const clamped = Math.max(0, Math.min(1, position));
  const bottom = BASE_BAND_BOTTOM[grade];
  const top = BASE_BAND_TOP[grade];
  return Math.round(bottom + (top - bottom) * clamped);
}

// ============================================================================
// Severity Helpers
// ============================================================================

function isSeverity(s: string): s is Severity {
  return s === 'critical' || s === 'high' || s === 'medium' || s === 'low';
}

interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}

function countSeverities(findings: Array<{ severity: string }>): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  for (const f of findings) {
    if (!isSeverity(f.severity)) continue;
    counts[f.severity]++;
    counts.total++;
  }
  return counts;
}

function worstSeverity(counts: SeverityCounts): Severity | null {
  if (counts.critical > 0) return 'critical';
  if (counts.high > 0) return 'high';
  if (counts.medium > 0) return 'medium';
  if (counts.low > 0) return 'low';
  return null;
}

/**
 * Result of consulting a dimension's severity escape hatch — used by both
 * Reliability and Maintainability to short-circuit a forgiving density grade
 * when the underlying findings include a critical or high. The grade is the
 * worst the dimension may receive after applying the escape; the consumer
 * still picks `min(severityEscape.grade, band.grade)` so an even worse
 * density-derived grade isn't paved over.
 */
interface SeverityEscape {
  grade: BaseGrade;
  note: string;
}

// ============================================================================
// Security Dimension
// ============================================================================

/**
 * Security grading — strictest of the three dimensions. Any medium-or-worse
 * security finding immediately drops the grade below B because security
 * issues can't be amortized over codebase size.
 *
 * A critical security issue caps at F- (the worst grade). One low-severity
 * finding still earns a B- because every team has a few.
 */
function gradeSecurity(findings: Array<{ severity: string }>): DimensionScore {
  const counts = countSeverities(findings);
  const worst = worstSeverity(counts);

  if (counts.total === 0) {
    return makeDimension('security', 100, '0 security findings', 0, null);
  }

  if (counts.critical > 0) {
    // Critical security issue → F-, not just F. There's no recovering by
    // averaging this away across a clean codebase.
    return makeDimension(
      'security',
      Math.max(0, 55 - counts.critical * 5),
      `${counts.critical} critical-severity security ${pluralize('issue', counts.critical)}`,
      counts.total,
      worst,
    );
  }

  let baseGrade: BaseGrade;
  let position: number;
  let rationale: string;

  if (counts.high > 0) {
    baseGrade = 'F';
    position = 1 / (1 + counts.high);
    rationale = `${counts.high} high-severity security ${pluralize('issue', counts.high)}`;
  } else if (counts.medium > 0) {
    baseGrade = 'C';
    position = 1 / (1 + counts.medium);
    rationale = `${counts.medium} medium-severity security ${pluralize('issue', counts.medium)}`;
  } else {
    // Only low-severity findings.
    baseGrade = 'B';
    position = 1 / Math.max(1, counts.low);
    rationale = `${counts.low} low-severity security ${pluralize('issue', counts.low)}`;
  }

  const score = scoreInBand(baseGrade, position);
  return makeDimension('security', score, rationale, counts.total, worst);
}

// ============================================================================
// Reliability Dimension
// ============================================================================
//
// Reliability uses the same density-based model as Maintainability, with a
// severity escape hatch — softer than the previous "2+ high → F" rule, which
// over-penalised codebases that had a handful of edge-case bugs flagged on
// rarely-executed paths. The new model:
//
//   - Density ladder (issues per KLOC) at ≥5 KLOC
//   - Absolute-count ladder at <5 KLOC (small projects shouldn't be density-
//     rated; one extra finding moves the needle by 1.0+/KLOC)
//   - Severity escape: 1 critical caps at F, any high caps at C
//
// Rationale: a real-world 10 KLOC service with 4 plausibly-improbable HIGH
// bugs (race conditions on degraded paths, edge-case fly-replay leaks)
// previously landed at F, dragging the entire app to F. Under this model
// it lands at C — "needs work" — which matches how a senior engineer would
// triage it on a code review. Critical bugs and compile errors still hit
// the F-tier through the escape hatch.
//
// Build/compile errors enter via the `build` category with severity `critical`,
// so they trip the escape hatch and hit F regardless of density.

interface ReliabilityBand {
  grade: BaseGrade;
  position: number;
  label: string;
}

function reliabilityByCount(n: number): ReliabilityBand {
  // Stricter than Maintainability's count ladder: a couple of real bugs hurt
  // more than a couple of lint warnings, but a single isolated medium bug on
  // a small project shouldn't pin the codebase at C.
  const label = `${n} reliability ${pluralize('issue', n)}`;
  if (n <= 2) return { grade: 'A', position: 1 - n / 2, label };
  if (n <= 6) return { grade: 'B', position: 1 - (n - 2) / 4, label };
  if (n <= 15) return { grade: 'C', position: 1 - (n - 6) / 9, label };
  return { grade: 'F', position: 1 / (1 + (n - 15) / 15), label };
}

function reliabilityByDensity(n: number, kloc: number): ReliabilityBand {
  // Density thresholds are tighter than Maintainability (5/10/25). A 50 KLOC
  // codebase with 100 reliability bugs (density 2) is "minor cleanup", not
  // pristine — but 1.4/KLOC is still A-band because real-world projects
  // never get to zero. The escape hatch handles severity outliers above this.
  const density = n / kloc;
  const label = `${roundOne(density)} reliability ${pluralize('issue', n)} / KLOC`;
  if (density < 1.5) return { grade: 'A', position: 1 - density / 1.5, label };
  if (density < 4) return { grade: 'B', position: 1 - (density - 1.5) / 2.5, label };
  if (density < 8) return { grade: 'C', position: 1 - (density - 4) / 4, label };
  return { grade: 'F', position: 1 / (1 + (density - 8) / 8), label };
}

function reliabilityEscape(counts: SeverityCounts): SeverityEscape | null {
  if (counts.critical > 0) {
    return { grade: 'F', note: `${counts.critical} critical-severity ${pluralize('bug', counts.critical)}` };
  }
  if (counts.high > 0) {
    return { grade: 'C', note: `${counts.high} high-severity ${pluralize('bug', counts.high)}` };
  }
  return null;
}

/**
 * Reliability grading — density-based with a severity escape hatch.
 *
 * - Empty / ≤1 low: A-band (clean by convention).
 * - Density-based grade (≥5 KLOC) or count-based grade (<5 KLOC) drives
 *   the baseline. Both ladders mirror Maintainability's so reliability and
 *   maintainability remain comparable at a glance.
 * - Severity escape: critical → F, high → C. This matches Maintainability and
 *   prevents a handful of medium-density bugs from being silently rated A
 *   when at least one is severe.
 *
 * Build/compile errors flow in via `build` category with severity `critical`
 * and therefore land at F via the escape hatch — no special-case branching.
 */
function gradeReliability(findings: Array<{ severity: string }>, totalLines: number): DimensionScore {
  const counts = countSeverities(findings);
  const worst = worstSeverity(counts);
  const kloc = Math.max(totalLines / 1000, 1.0);

  if (counts.total === 0) {
    return makeDimension('reliability', 100, '0 reliability findings', 0, null);
  }

  // ≤1 low and nothing else is treated as clean — every team has one.
  if (counts.low <= 1 && counts.medium === 0 && counts.high === 0 && counts.critical === 0) {
    return makeDimension('reliability', scoreInBand('A', 0.5), '1 low-severity reliability issue', counts.total, worst);
  }

  const band = kloc < 5 ? reliabilityByCount(counts.total) : reliabilityByDensity(counts.total, kloc);
  const severityCap = reliabilityEscape(counts);
  const useCap = severityCap && baseIsWorse(severityCap.grade, band.grade);
  const finalGrade = useCap ? severityCap.grade : band.grade;
  const finalPosition = useCap ? 0.5 : band.position;
  const rationale = useCap ? `${band.label}, ${severityCap.note}` : band.label;

  return makeDimension('reliability', scoreInBand(finalGrade, finalPosition), rationale, counts.total, worst);
}

// ============================================================================
// Maintainability Dimension
// ============================================================================

interface MaintainabilityBand {
  grade: BaseGrade;
  position: number;
  label: string;
}

function maintainabilityByCount(n: number): MaintainabilityBand {
  const label = `${n} maintainability ${pluralize('issue', n)}`;
  if (n <= 5) return { grade: 'A', position: 1 - n / 5, label };
  if (n <= 15) return { grade: 'B', position: 1 - (n - 5) / 10, label };
  if (n <= 30) return { grade: 'C', position: 1 - (n - 15) / 15, label };
  return { grade: 'F', position: 1 / (1 + (n - 30) / 30), label };
}

function maintainabilityByDensity(n: number, kloc: number): MaintainabilityBand {
  const density = n / kloc;
  const label = `${roundOne(density)} ${pluralize('issue', n)} / KLOC`;
  if (density < 5) return { grade: 'A', position: 1 - density / 5, label };
  if (density < 10) return { grade: 'B', position: 1 - (density - 5) / 5, label };
  if (density < 25) return { grade: 'C', position: 1 - (density - 10) / 15, label };
  return { grade: 'F', position: 1 / (1 + (density - 25) / 25), label };
}

function maintainabilityEscape(counts: SeverityCounts): SeverityEscape | null {
  if (counts.critical > 0) {
    return { grade: 'F', note: `${counts.critical} critical-severity ${pluralize('issue', counts.critical)}` };
  }
  if (counts.high > 0) {
    return { grade: 'C', note: `${counts.high} high-severity ${pluralize('issue', counts.high)}` };
  }
  return null;
}

/**
 * Maintainability uses a density-based grade (issues per KLOC) once the
 * codebase is at least 5 KLOC. For smaller codebases, density is too noisy
 * (one extra lint issue moves density by 1.0+), so we fall back to absolute
 * counts — preventing tiny projects from being unfairly penalized.
 *
 * Severity escape hatch: a critical maintainability finding (e.g., a 3000-
 * line file with high cohesion-violation severity) caps at F; a high-severity
 * one caps at C. "Worst wins" — we take min of density-grade and severity-cap.
 */
function gradeMaintainability(findings: Array<{ severity: string }>, totalLines: number): DimensionScore {
  const counts = countSeverities(findings);
  const kloc = Math.max(totalLines / 1000, 1.0);

  if (counts.total === 0) {
    return makeDimension('maintainability', 100, '0 maintainability findings', 0, null);
  }

  const band = kloc < 5 ? maintainabilityByCount(counts.total) : maintainabilityByDensity(counts.total, kloc);
  const severityCap = maintainabilityEscape(counts);
  const useCap = severityCap && baseIsWorse(severityCap.grade, band.grade);
  const finalGrade = useCap ? severityCap.grade : band.grade;
  const finalPosition = useCap ? 0.5 : band.position;
  const rationale = useCap ? `${band.label}, ${severityCap.note}` : band.label;

  return makeDimension('maintainability', scoreInBand(finalGrade, finalPosition), rationale, counts.total, worstSeverity(counts));
}

// ============================================================================
// Architectural Penalty
// ============================================================================

/**
 * Drop a dimension's grade by N letters because of architectural findings.
 *
 * Rationale: a high-severity architectural problem (god class, leaky
 * abstraction, broken layering) is qualitatively different from a long-file
 * lint warning — it pollutes every change that touches the affected code.
 * The user spec calls for explicit letter-grade drops:
 *
 *   - 1 high-severity arch issue        → drop 1 letter
 *   - 2+ high-severity arch issues      → drop 2 letters
 *   - any critical-severity arch issue  → drop 2 letters
 *
 * Letters drop A → B → C → F → F-. We never go lower than F-. The drop is
 * applied AFTER the dimension's normal grading so the displayed score still
 * reflects the underlying finding count, but the letter grade carries the
 * architectural weight that a density-based score would otherwise miss.
 */
function archDropCount(archFindings: Array<{ severity: string }>): number {
  let highCount = 0;
  let criticalCount = 0;
  for (const f of archFindings) {
    if (f.severity === 'critical') criticalCount++;
    else if (f.severity === 'high') highCount++;
  }
  if (criticalCount >= 1) return 2;
  if (highCount >= 2) return 2;
  if (highCount >= 1) return 1;
  return 0;
}

const BASE_LETTERS: BaseGrade[] = ['A', 'B', 'C', 'F'];

function gradeModifier(grade: Grade): '' | '+' | '-' {
  if (grade.endsWith('+')) return '+';
  if (grade.endsWith('-')) return '-';
  return '';
}

function applyModifierToTargetBase(targetBase: BaseGrade, modifier: '' | '+' | '-'): Grade {
  // F's modifier semantics differ from A/B/C: F+ is "barely failing" while
  // A+/B+/C+ are "top of band." For simplicity we map any modifier on F to
  // its matching variant, and use F- (the worst) for any post-F overshoot.
  if (targetBase === 'F') {
    if (modifier === '+') return 'F+';
    if (modifier === '-') return 'F-';
    return 'F';
  }
  if (modifier === '+') return `${targetBase}+` as Grade;
  if (modifier === '-') return `${targetBase}-` as Grade;
  return targetBase as Grade;
}

/**
 * Drop a grade by N "letters." A "letter" here means a full base-grade step
 * (A → B → C → F → F-), preserving the modifier when possible. So A+ dropped
 * by 1 becomes B+, not A. Stops at F-.
 */
function dropGradeByLetters(grade: Grade, letters: number): Grade {
  if (letters <= 0 || grade === 'N/A' || grade === 'D') return grade;
  const baseLetter = baseGradeOf(grade);
  const baseIdx = BASE_LETTERS.indexOf(baseLetter as BaseGrade);
  if (baseIdx === -1) return grade;
  const targetBaseIdx = baseIdx + letters;
  // Past the F base — bottom out at F- (the absolute worst grade).
  if (targetBaseIdx > 3) return 'F-';
  const targetBase = BASE_LETTERS[targetBaseIdx];
  return applyModifierToTargetBase(targetBase, gradeModifier(grade));
}

function applyArchPenalty(dim: DimensionScore, archFindings: Array<{ severity: string }>): DimensionScore {
  const drop = archDropCount(archFindings);
  if (drop === 0) return dim;
  const dropped = dropGradeByLetters(dim.grade, drop);
  if (dropped === dim.grade) return dim;
  const archCount = archFindings.length;
  const noun = pluralize('architectural finding', archCount);
  const note = `dropped ${drop} ${pluralize('letter', drop)} by ${archCount} ${noun}`;
  return {
    ...dim,
    grade: dropped,
    // Re-anchor score to the new band's midpoint so score and letter agree.
    score: anchorScoreToGrade(dropped, dim.score),
    rationale: dim.rationale === '0 maintainability findings' || dim.findingCount === 0
      ? note
      : `${dim.rationale}; ${note}`,
  };
}

/**
 * Re-snap a score to fall within the band of the given grade. Used after
 * applying the architectural penalty so the displayed score never disagrees
 * with the displayed letter (e.g., grade C with score 89 would be jarring).
 *
 * If the original score is already in-band, keep it; otherwise pick the
 * band's midpoint as a sensible default.
 */
function anchorScoreToGrade(grade: Grade, originalScore: number): number {
  if (grade === 'N/A' || grade === 'D') return originalScore;
  const ranges: Record<Exclude<Grade, 'N/A' | 'D'>, [number, number]> = {
    'A+': [97, 100], A: [93, 96], 'A-': [90, 92],
    'B+': [87, 89], B: [83, 86], 'B-': [80, 82],
    'C+': [77, 79], C: [73, 76], 'C-': [70, 72],
    'F+': [65, 69], F: [56, 64], 'F-': [0, 55],
  };
  const [lo, hi] = ranges[grade as Exclude<Grade, 'N/A' | 'D'>];
  if (originalScore >= lo && originalScore <= hi) return originalScore;
  return Math.round((lo + hi) / 2);
}

// ============================================================================
// Grade Comparison Helpers
// ============================================================================

const BASE_RANK: Record<BaseGrade, number> = { F: 1, C: 2, B: 3, A: 4 };

function baseIsWorse(a: BaseGrade, b: BaseGrade): boolean {
  return BASE_RANK[a] < BASE_RANK[b];
}

const FULL_RANK: Record<Exclude<Grade, 'N/A' | 'D'>, number> = {
  'F-': 0, F: 1, 'F+': 2,
  'C-': 3, C: 4, 'C+': 5,
  'B-': 6, B: 7, 'B+': 8,
  'A-': 9, A: 10, 'A+': 11,
};

function gradeRank(g: Grade): number {
  if (g === 'N/A') return -1;
  if (g === 'D') return 1.5; // legacy: between F+ and C-
  return FULL_RANK[g as Exclude<Grade, 'N/A' | 'D'>];
}

function worstOf(grades: Grade[]): Grade {
  let worst: Grade = 'A+';
  for (const g of grades) {
    if (g === 'N/A') continue;
    if (gradeRank(g) < gradeRank(worst)) worst = g;
  }
  return worst;
}

// ============================================================================
// Misc Helpers
// ============================================================================

function pluralize(word: string, n: number): string {
  return n === 1 ? word : `${word}s`;
}

function roundOne(n: number): number {
  return Math.round(n * 10) / 10;
}

function dimensionDisplayName(name: DimensionName): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function makeDimension(
  name: DimensionName,
  score: number,
  rationale: string,
  findingCount: number,
  worst: Severity | null,
): DimensionScore {
  return {
    name,
    score,
    grade: scoreToGrade(score),
    rationale,
    available: true,
    findingCount,
    worstSeverity: worst,
  };
}

function naDimension(name: DimensionName): DimensionScore {
  return {
    name,
    score: 0,
    grade: 'N/A',
    rationale: 'No tools available to evaluate',
    available: false,
    findingCount: 0,
    worstSeverity: null,
  };
}

// ============================================================================
// Top-Level Entry Point
// ============================================================================

function bucketByDimension(
  findings: Array<{ severity: string; category: string }>,
): {
  security: Array<{ severity: string; category: string }>;
  reliability: Array<{ severity: string; category: string }>;
  maintainability: Array<{ severity: string; category: string }>;
  architecture: Array<{ severity: string; category: string }>;
} {
  const security: Array<{ severity: string; category: string }> = [];
  const reliability: Array<{ severity: string; category: string }> = [];
  const maintainability: Array<{ severity: string; category: string }> = [];
  const architecture: Array<{ severity: string; category: string }> = [];
  for (const f of findings) {
    if (ARCHITECTURE_CATEGORIES.has(f.category)) architecture.push(f);
    const dim = categoryToDimension(f.category);
    if (dim === 'security') security.push(f);
    else if (dim === 'reliability') reliability.push(f);
    else maintainability.push(f);
  }
  return { security, reliability, maintainability, architecture };
}

function isDimensionAvailable(
  dim: DimensionName,
  hasFindings: boolean,
  options?: { availableDimensions?: Set<DimensionName>; forceNA?: Set<DimensionName> },
): boolean {
  if (options?.forceNA?.has(dim)) return false;
  const explicit = options?.availableDimensions;
  if (explicit) return explicit.has(dim);
  // Auto-detect: maintainability always on, security/reliability iff findings exist.
  return dim === 'maintainability' ? true : hasFindings;
}

/**
 * Combine the available dimensions into a single overall grade + score.
 *
 * "Worst dimension wins" for the letter grade — a single failing dimension
 * caps the overall score, matching how SonarQube's quality gate behaves.
 * The numeric score is `min(avg, worst)` so a great Maintainability score
 * can't paper over a Security failure.
 */
function computeOverall(availableDims: DimensionScore[]): { grade: Grade; score: number } {
  if (availableDims.length === 0) {
    return { grade: 'N/A', score: 0 };
  }
  const grades = availableDims.map((d) => d.grade);
  const scores = availableDims.map((d) => d.score);
  const avg = scores.reduce((s, n) => s + n, 0) / scores.length;
  const worst = worstOf(grades);
  // Re-snap the displayed score so it lives in the worst dimension's band —
  // otherwise we'd display a B-letter with a C-numeric score (or vice versa).
  const blendedScore = Math.round(Math.min(avg, Math.min(...scores)));
  return { grade: worst, score: anchorScoreToGrade(worst, blendedScore) };
}

export function computeQualityRating(
  allFindings: Array<{ severity: string; category: string }>,
  totalLines: number,
  options?: { availableDimensions?: Set<DimensionName>; forceNA?: Set<DimensionName> },
): QualityRating {
  const buckets = bucketByDimension(allFindings);

  // Initial dimension grades, before architectural penalty.
  const security = isDimensionAvailable('security', buckets.security.length > 0, options)
    ? gradeSecurity(buckets.security)
    : naDimension('security');
  const reliabilityRaw = isDimensionAvailable('reliability', buckets.reliability.length > 0, options)
    ? gradeReliability(buckets.reliability, totalLines)
    : naDimension('reliability');
  const maintainabilityRaw = isDimensionAvailable('maintainability', true, options)
    ? gradeMaintainability(buckets.maintainability, totalLines)
    : naDimension('maintainability');

  // Architectural penalty: hits whichever dimension(s) have arch findings
  // bucketed into them (currently maintainability via the category map).
  const archFindings = buckets.architecture;
  const maintainability = maintainabilityRaw.available
    ? applyArchPenalty(maintainabilityRaw, archFindings)
    : maintainabilityRaw;

  const dimensions: DimensionScore[] = [security, reliabilityRaw, maintainability];
  const availableDims = dimensions.filter((d) => d.available);
  const overall = computeOverall(availableDims);
  const qualityGate = computeQualityGate(security, reliabilityRaw, archFindings.length);
  const gradeRationale = computeGradeRationale(availableDims, overall.grade, allFindings.length);

  return {
    overall,
    dimensions,
    qualityGate,
    gradeRationale,
  };
}

// ============================================================================
// Quality Gate
// ============================================================================

/**
 * The Quality Gate is a coarse PASS/FAIL signal layered on top of the grades.
 * It only fires for the most user-actionable thresholds — any C-or-worse
 * security grade, any F-tier reliability grade, or 2+ high-severity
 * architectural findings. N/A dimensions never trigger a fail (we don't fail
 * on missing data).
 */
function isFTier(g: Grade): boolean {
  return g === 'F+' || g === 'F' || g === 'F-' || g === 'D';
}

function isCorWorse(g: Grade): boolean {
  return baseGradeOf(g) === 'C' || isFTier(g);
}

function computeQualityGate(
  security: DimensionScore,
  reliability: DimensionScore,
  archFindingCount: number,
): QualityGate {
  const failingConditions: string[] = [];

  if (security.available && isCorWorse(security.grade)) {
    failingConditions.push(`Security grade ${security.grade} — ${security.rationale}`);
  }
  if (reliability.available && isFTier(reliability.grade)) {
    failingConditions.push(`Reliability grade ${reliability.grade} — ${reliability.rationale}`);
  }
  if (archFindingCount >= 2) {
    failingConditions.push(`${archFindingCount} architectural findings`);
  }

  return {
    passed: failingConditions.length === 0,
    failingConditions,
  };
}

// ============================================================================
// Grade Rationale
// ============================================================================

function computeGradeRationale(
  availableDims: DimensionScore[],
  overallGrade: Grade,
  totalFindingCount: number,
): string {
  if (totalFindingCount === 0) {
    return 'Clean — no findings detected';
  }
  if (availableDims.length === 0 || overallGrade === 'N/A') {
    return 'No dimensions available to grade';
  }

  // All available dimensions share the same base letter -> "consistent
  // quality". With +/- modifiers it's normal for sibling dimensions to land
  // at A vs A+ depending on within-band position; calling that "inconsistent"
  // would be misleading. We compare base letters so the user-facing message
  // captures the high-level shape rather than every minor band difference.
  const firstBase = baseGradeOf(availableDims[0].grade);
  const allSameBase = availableDims.every((d) => baseGradeOf(d.grade) === firstBase);
  if (allSameBase) {
    return `All dimensions ${firstBase}-tier — consistent quality`;
  }

  // Find the dimension that pinned the overall grade (worst available).
  const worstDim =
    availableDims.find((d) => d.grade === overallGrade) ??
    // Fallback shouldn't fire since overallGrade was derived from availableDims.
    availableDims[0];

  return `Capped at ${overallGrade} by ${dimensionDisplayName(worstDim.name)} (${worstDim.rationale})`;
}
