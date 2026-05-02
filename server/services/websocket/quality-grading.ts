// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

// ============================================================================
// Multi-Dimensional Quality Grading
// ============================================================================
//
// Pure logic for the three-dimension grading model:
//   - Security    — severity-threshold (worst severity issue determines grade)
//   - Reliability — severity-threshold, slightly more lenient than Security
//   - Maintainability — density-based (issues / KLOC) with a severity escape hatch
//
// Rationale (why these specific bands):
//   The previous single-score exponential-decay model conflated security holes
//   with prettier complaints. Industry tools (SonarQube, Code Climate, CodeScene)
//   all separate severity-driven dimensions from aggregate metrics so that a
//   critical issue can never be "averaged away" by a clean lint score.
//
// All functions in this module are pure: same inputs -> same outputs, no I/O.
// ============================================================================

// ============================================================================
// Types
// ============================================================================

export type DimensionName = 'security' | 'reliability' | 'maintainability';
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F' | 'N/A';
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
const RELIABILITY_CATEGORIES = new Set<string>(['bugs', 'logic', 'performance', 'complexity']);
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

// ============================================================================
// Legacy Fallback
// ============================================================================

/**
 * Score-to-grade conversion used by legacy callers that still operate on a
 * single 0-100 number. The new multi-dimensional path computes grades
 * directly from finding shape; this remains for backward compatibility.
 */
export function gradeFromScore(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

// ============================================================================
// Score Bands
// ============================================================================

const BAND_TOP: Record<Exclude<Grade, 'N/A'>, number> = {
  A: 100,
  B: 89,
  C: 79,
  D: 69,
  F: 59,
};

const BAND_BOTTOM: Record<Exclude<Grade, 'N/A'>, number> = {
  A: 90,
  B: 80,
  C: 70,
  D: 60,
  F: 0,
};

/**
 * Linearly interpolate a score within a grade's band.
 *
 * `position` is in [0, 1]: 0 means "as bad as this grade gets" (band bottom),
 * 1 means "as good as this grade gets" (band top, just below the next grade).
 */
function scoreInBand(grade: Exclude<Grade, 'N/A'>, position: number): number {
  const clamped = Math.max(0, Math.min(1, position));
  const bottom = BAND_BOTTOM[grade];
  const top = BAND_TOP[grade];
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

// ============================================================================
// Security Dimension
// ============================================================================

/**
 * Security grading — strictest of the three dimensions. Any medium-or-worse
 * security finding immediately drops the grade below B because security
 * issues can't be amortized over codebase size.
 *
 * Within-band score: more findings at the threshold severity -> lower score.
 * The interpolation favors "fewer issues is meaningfully better" so 1 medium
 * scores higher than 5 mediums even though both are grade C.
 */
function gradeSecurity(findings: Array<{ severity: string }>): DimensionScore {
  const counts = countSeverities(findings);
  const worst = worstSeverity(counts);

  if (counts.total === 0) {
    return {
      name: 'security',
      score: 100,
      grade: 'A',
      rationale: '0 security findings',
      available: true,
      findingCount: 0,
      worstSeverity: null,
    };
  }

  let grade: Exclude<Grade, 'N/A'>;
  let position: number;
  let rationale: string;

  if (counts.critical > 0) {
    grade = 'F';
    // F band: fewer criticals -> higher within-band, but still F.
    position = 1 / (1 + counts.critical);
    rationale = `${counts.critical} critical-severity security ${pluralize('issue', counts.critical)}`;
  } else if (counts.high > 0) {
    grade = 'D';
    position = 1 / (1 + counts.high);
    rationale = `${counts.high} high-severity security ${pluralize('issue', counts.high)}`;
  } else if (counts.medium > 0) {
    grade = 'C';
    position = 1 / (1 + counts.medium);
    rationale = `${counts.medium} medium-severity security ${pluralize('issue', counts.medium)}`;
  } else {
    // Only low-severity findings.
    grade = 'B';
    // 1 low -> top of B (89); more lows -> down toward 80.
    position = 1 / Math.max(1, counts.low);
    rationale = `${counts.low} low-severity security ${pluralize('issue', counts.low)}`;
  }

  return {
    name: 'security',
    score: scoreInBand(grade, position),
    grade,
    rationale,
    available: true,
    findingCount: counts.total,
    worstSeverity: worst,
  };
}

// ============================================================================
// Reliability Dimension
// ============================================================================

interface BandResult {
  grade: Exclude<Grade, 'N/A'>;
  position: number;
  rationale: string;
}

function reliabilityBandClean(counts: SeverityCounts): BandResult {
  const position = counts.total === 0 ? 1 : 0.5;
  const rationale = counts.total === 0 ? '0 reliability findings' : '1 low-severity reliability issue';
  return { grade: 'A', position, rationale };
}

function reliabilityBandSevere(counts: SeverityCounts): BandResult | null {
  if (counts.critical > 0) {
    return {
      grade: 'F',
      position: 1 / (1 + counts.critical),
      rationale: `${counts.critical} critical-severity ${pluralize('bug', counts.critical)}`,
    };
  }
  if (counts.high >= 2) {
    return {
      grade: 'D',
      position: 1 / (1 + (counts.high - 1)),
      rationale: `${counts.high} high-severity ${pluralize('bug', counts.high)}`,
    };
  }
  return null;
}

function reliabilityBandMid(counts: SeverityCounts): BandResult {
  if (counts.high >= 1) {
    return {
      grade: 'C',
      position: 1 / (1 + counts.high),
      rationale: `${counts.high} high-severity ${pluralize('bug', counts.high)}`,
    };
  }
  if (counts.medium >= 3) {
    return {
      grade: 'C',
      position: 1 / Math.max(1, counts.medium - 2),
      rationale: `${counts.medium} medium-severity reliability ${pluralize('issue', counts.medium)}`,
    };
  }
  if (counts.medium >= 1) {
    return {
      grade: 'B',
      position: 1 / Math.max(1, counts.medium),
      rationale: `${counts.medium} medium-severity reliability ${pluralize('issue', counts.medium)}`,
    };
  }
  // Only low-severity findings, > 1 of them.
  return {
    grade: 'B',
    position: 1 / Math.max(1, counts.low - 1),
    rationale: `${counts.low} low-severity reliability ${pluralize('issue', counts.low)}`,
  };
}

/**
 * Reliability grading — slightly more lenient than Security because not every
 * complexity warning is a runtime defect. A single low-severity logic issue
 * still earns an A; medium issues escalate gradually.
 */
function gradeReliability(findings: Array<{ severity: string }>): DimensionScore {
  const counts = countSeverities(findings);
  const worst = worstSeverity(counts);
  const isClean = counts.total === 0 || (counts.low <= 1 && counts.medium === 0 && counts.high === 0 && counts.critical === 0);
  const band = isClean
    ? reliabilityBandClean(counts)
    : reliabilityBandSevere(counts) ?? reliabilityBandMid(counts);

  return {
    name: 'reliability',
    score: scoreInBand(band.grade, band.position),
    grade: band.grade,
    rationale: band.rationale,
    available: true,
    findingCount: counts.total,
    worstSeverity: worst,
  };
}

// ============================================================================
// Maintainability Dimension
// ============================================================================

interface MaintainabilityBand {
  grade: Exclude<Grade, 'N/A'>;
  position: number;
  label: string;
}

function maintainabilityByCount(n: number): MaintainabilityBand {
  const label = `${n} maintainability ${pluralize('issue', n)}`;
  if (n <= 5) return { grade: 'A', position: 1 - n / 5, label };
  if (n <= 15) return { grade: 'B', position: 1 - (n - 5) / 10, label };
  if (n <= 30) return { grade: 'C', position: 1 - (n - 15) / 15, label };
  if (n <= 60) return { grade: 'D', position: 1 - (n - 30) / 30, label };
  return { grade: 'F', position: 1 / (1 + (n - 60) / 30), label };
}

function maintainabilityByDensity(n: number, kloc: number): MaintainabilityBand {
  const density = n / kloc;
  const label = `${roundOne(density)} ${pluralize('issue', n)} / KLOC`;
  if (density < 5) return { grade: 'A', position: 1 - density / 5, label };
  if (density < 10) return { grade: 'B', position: 1 - (density - 5) / 5, label };
  if (density < 25) return { grade: 'C', position: 1 - (density - 10) / 15, label };
  if (density < 50) return { grade: 'D', position: 1 - (density - 25) / 25, label };
  return { grade: 'F', position: 1 / (1 + (density - 50) / 25), label };
}

interface SeverityEscape {
  grade: Exclude<Grade, 'N/A'>;
  note: string;
}

function maintainabilityEscape(counts: SeverityCounts): SeverityEscape | null {
  if (counts.critical > 0) {
    return { grade: 'D', note: `${counts.critical} critical-severity ${pluralize('issue', counts.critical)}` };
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
 * Severity escape hatch: a single high-severity maintainability finding
 * (e.g., a 1500-line file) caps the grade at C; a critical caps at D.
 * "Worst wins" — we take min of density-grade and severity-cap.
 */
function gradeMaintainability(findings: Array<{ severity: string }>, totalLines: number): DimensionScore {
  const counts = countSeverities(findings);
  const kloc = Math.max(totalLines / 1000, 1.0);

  if (counts.total === 0) {
    return {
      name: 'maintainability',
      score: 100,
      grade: 'A',
      rationale: '0 maintainability findings',
      available: true,
      findingCount: 0,
      worstSeverity: null,
    };
  }

  const band = kloc < 5 ? maintainabilityByCount(counts.total) : maintainabilityByDensity(counts.total, kloc);
  const severityCap = maintainabilityEscape(counts);
  const useCap = severityCap && gradeIsWorse(severityCap.grade, band.grade);
  const finalGrade = useCap ? severityCap.grade : band.grade;
  const finalPosition = useCap ? 0.5 : band.position;
  const rationale = useCap ? `${band.label}, ${severityCap.note}` : band.label;

  return {
    name: 'maintainability',
    score: scoreInBand(finalGrade, finalPosition),
    grade: finalGrade,
    rationale,
    available: true,
    findingCount: counts.total,
    worstSeverity: worstSeverity(counts),
  };
}

// ============================================================================
// Grade Comparison Helpers
// ============================================================================

const GRADE_RANK: Record<Exclude<Grade, 'N/A'>, number> = {
  F: 1,
  D: 2,
  C: 3,
  B: 4,
  A: 5,
};

function gradeIsWorse(a: Exclude<Grade, 'N/A'>, b: Exclude<Grade, 'N/A'>): boolean {
  return GRADE_RANK[a] < GRADE_RANK[b];
}

function worstOf(grades: Array<Exclude<Grade, 'N/A'>>): Exclude<Grade, 'N/A'> {
  let worst: Exclude<Grade, 'N/A'> = 'A';
  for (const g of grades) {
    if (gradeIsWorse(g, worst)) worst = g;
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

/**
 * Compute the full multi-dimensional quality rating from the merged finding
 * set. Callers can override availability in two ways:
 *   - `availableDimensions`: hard whitelist — only listed dims are graded.
 *   - `forceNA`: forces specific dims to N/A even if they would otherwise
 *     auto-detect as available. Use this when the underlying tools didn't
 *     run (e.g., no linter installed -> Maintainability has limited coverage).
 *
 * Default availability rules:
 *   - maintainability is always available (lint/format/length checks always run)
 *   - security/reliability are available iff at least one finding maps there
 *
 * Overall score uses min(avg, worst) so a single bad dimension caps the
 * total — you cannot earn a great overall score by averaging away a hole.
 */
function bucketByDimension(
  findings: Array<{ severity: string; category: string }>,
): {
  security: Array<{ severity: string; category: string }>;
  reliability: Array<{ severity: string; category: string }>;
  maintainability: Array<{ severity: string; category: string }>;
} {
  const security: Array<{ severity: string; category: string }> = [];
  const reliability: Array<{ severity: string; category: string }> = [];
  const maintainability: Array<{ severity: string; category: string }> = [];
  for (const f of findings) {
    const dim = categoryToDimension(f.category);
    if (dim === 'security') security.push(f);
    else if (dim === 'reliability') reliability.push(f);
    else maintainability.push(f);
  }
  return { security, reliability, maintainability };
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

function computeOverall(availableDims: DimensionScore[]): { grade: Grade; score: number } {
  if (availableDims.length === 0) {
    return { grade: 'N/A', score: 0 };
  }
  const grades = availableDims.map((d) => d.grade as Exclude<Grade, 'N/A'>);
  const scores = availableDims.map((d) => d.score);
  const avg = scores.reduce((s, n) => s + n, 0) / scores.length;
  return {
    grade: worstOf(grades),
    score: Math.round(Math.min(avg, Math.min(...scores))),
  };
}

export function computeQualityRating(
  allFindings: Array<{ severity: string; category: string }>,
  totalLines: number,
  options?: { availableDimensions?: Set<DimensionName>; forceNA?: Set<DimensionName> },
): QualityRating {
  const buckets = bucketByDimension(allFindings);

  const security = isDimensionAvailable('security', buckets.security.length > 0, options)
    ? gradeSecurity(buckets.security)
    : naDimension('security');
  const reliability = isDimensionAvailable('reliability', buckets.reliability.length > 0, options)
    ? gradeReliability(buckets.reliability)
    : naDimension('reliability');
  const maintainability = isDimensionAvailable('maintainability', true, options)
    ? gradeMaintainability(buckets.maintainability, totalLines)
    : naDimension('maintainability');

  const dimensions: DimensionScore[] = [security, reliability, maintainability];
  const availableDims = dimensions.filter((d) => d.available);
  const overall = computeOverall(availableDims);

  // Quality gate.
  const qualityGate = computeQualityGate(security, reliability);

  // Grade rationale.
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
 * It only fires for the most user-actionable thresholds — any medium+ security
 * finding, or any critical bug. N/A dimensions never trigger a fail (we don't
 * fail on missing data).
 */
function computeQualityGate(security: DimensionScore, reliability: DimensionScore): QualityGate {
  const failingConditions: string[] = [];

  if (security.available && (security.grade === 'C' || security.grade === 'D' || security.grade === 'F')) {
    failingConditions.push(`Security grade ${security.grade} — ${security.rationale}`);
  }
  if (reliability.available && reliability.grade === 'F') {
    failingConditions.push(`Reliability grade F — ${reliability.rationale}`);
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

  // All available dimensions equal -> "consistent quality".
  const firstGrade = availableDims[0].grade;
  const allEqual = availableDims.every((d) => d.grade === firstGrade);
  if (allEqual) {
    return `All dimensions ${firstGrade} — consistent quality`;
  }

  // Find the dimension that pinned the overall grade (worst available).
  const worstDim =
    availableDims.find((d) => d.grade === overallGrade) ??
    // Fallback shouldn't fire since overallGrade was derived from availableDims.
    availableDims[0];

  return `Capped at ${overallGrade} by ${dimensionDisplayName(worstDim.name)} (${worstDim.rationale})`;
}
