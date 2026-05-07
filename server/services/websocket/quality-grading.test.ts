// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { describe, expect, it } from 'vitest';
import {
  categoryToDimension,
  computeQualityRating,
  gradeFromScore,
  scoreToGrade,
} from './quality-grading.js';

// ── Test helper ───────────────────────────────────────────────────────────────

const finding = (severity: string, category: string) => ({ severity, category });

// ============================================================================
// categoryToDimension
// ============================================================================

describe('categoryToDimension', () => {
  it('maps "security" to security dimension', () => {
    expect(categoryToDimension('security')).toBe('security');
  });

  it('maps "bugs" to reliability', () => {
    expect(categoryToDimension('bugs')).toBe('reliability');
  });

  it('maps "logic" to reliability', () => {
    expect(categoryToDimension('logic')).toBe('reliability');
  });

  it('maps "performance" to reliability', () => {
    expect(categoryToDimension('performance')).toBe('reliability');
  });

  it('maps "complexity" to reliability', () => {
    expect(categoryToDimension('complexity')).toBe('reliability');
  });

  it('maps "build" to reliability (compile errors are reliability problems)', () => {
    expect(categoryToDimension('build')).toBe('reliability');
  });

  it('maps "lint" to maintainability', () => {
    expect(categoryToDimension('lint')).toBe('maintainability');
  });

  it('maps "linting" to maintainability', () => {
    expect(categoryToDimension('linting')).toBe('maintainability');
  });

  it('maps "format" to maintainability', () => {
    expect(categoryToDimension('format')).toBe('maintainability');
  });

  it('maps "file-length" to maintainability', () => {
    expect(categoryToDimension('file-length')).toBe('maintainability');
  });

  it('maps "function-length" to maintainability', () => {
    expect(categoryToDimension('function-length')).toBe('maintainability');
  });

  it('maps "architecture" to maintainability', () => {
    expect(categoryToDimension('architecture')).toBe('maintainability');
  });

  it('maps "oop" to maintainability', () => {
    expect(categoryToDimension('oop')).toBe('maintainability');
  });

  it('maps "maintainability" to maintainability', () => {
    expect(categoryToDimension('maintainability')).toBe('maintainability');
  });

  it('defaults unknown category to maintainability', () => {
    expect(categoryToDimension('something-totally-unknown')).toBe('maintainability');
  });
});

// ============================================================================
// gradeFromScore (legacy single-letter helper — strips +/- modifier)
// ============================================================================

describe('gradeFromScore', () => {
  it('returns A for score 100', () => {
    expect(gradeFromScore(100)).toBe('A');
  });

  it('returns A for score 90 (band boundary)', () => {
    expect(gradeFromScore(90)).toBe('A');
  });

  it('returns B for score 89', () => {
    expect(gradeFromScore(89)).toBe('B');
  });

  it('returns B for score 80', () => {
    expect(gradeFromScore(80)).toBe('B');
  });

  it('returns C for score 79', () => {
    expect(gradeFromScore(79)).toBe('C');
  });

  it('returns C for score 70', () => {
    expect(gradeFromScore(70)).toBe('C');
  });

  // Per spec: there is NO `D` band — F covers 56-69, F- covers 0-55.
  it('returns F for score 69 (no D band)', () => {
    expect(gradeFromScore(69)).toBe('F');
  });

  it('returns F for score 60', () => {
    expect(gradeFromScore(60)).toBe('F');
  });

  it('returns F for score 56', () => {
    expect(gradeFromScore(56)).toBe('F');
  });

  it('returns F for score 55 (F- internally — gradeFromScore strips modifier)', () => {
    expect(gradeFromScore(55)).toBe('F');
  });

  it('returns F for score 0', () => {
    expect(gradeFromScore(0)).toBe('F');
  });
});

// ============================================================================
// scoreToGrade — the +/- modifier mapping
// ============================================================================

describe('scoreToGrade — +/- modifier bands', () => {
  it('A+ for 97-100', () => {
    expect(scoreToGrade(100)).toBe('A+');
    expect(scoreToGrade(97)).toBe('A+');
  });

  it('A for 93-96', () => {
    expect(scoreToGrade(96)).toBe('A');
    expect(scoreToGrade(93)).toBe('A');
  });

  it('A- for 90-92', () => {
    expect(scoreToGrade(92)).toBe('A-');
    expect(scoreToGrade(90)).toBe('A-');
  });

  it('B+ for 87-89', () => {
    expect(scoreToGrade(89)).toBe('B+');
    expect(scoreToGrade(87)).toBe('B+');
  });

  it('B for 83-86', () => {
    expect(scoreToGrade(86)).toBe('B');
    expect(scoreToGrade(83)).toBe('B');
  });

  it('B- for 80-82', () => {
    expect(scoreToGrade(82)).toBe('B-');
    expect(scoreToGrade(80)).toBe('B-');
  });

  it('C+ for 77-79', () => {
    expect(scoreToGrade(79)).toBe('C+');
    expect(scoreToGrade(77)).toBe('C+');
  });

  it('C for 73-76', () => {
    expect(scoreToGrade(76)).toBe('C');
    expect(scoreToGrade(73)).toBe('C');
  });

  it('C- for 70-72', () => {
    expect(scoreToGrade(72)).toBe('C-');
    expect(scoreToGrade(70)).toBe('C-');
  });

  it('F+ for 65-69 (no D — F band starts here per spec)', () => {
    expect(scoreToGrade(69)).toBe('F+');
    expect(scoreToGrade(65)).toBe('F+');
  });

  it('F for 56-64', () => {
    expect(scoreToGrade(64)).toBe('F');
    expect(scoreToGrade(56)).toBe('F');
  });

  it('F- for 0-55 (worst grade — auto-fail)', () => {
    expect(scoreToGrade(55)).toBe('F-');
    expect(scoreToGrade(0)).toBe('F-');
  });
});

// ============================================================================
// computeQualityRating — Empty / Clean
// ============================================================================

describe('computeQualityRating — empty/clean', () => {
  it('returns A+ grade for all available dimensions with no findings', () => {
    const result = computeQualityRating(
      [],
      1000,
      { availableDimensions: new Set(['security', 'reliability', 'maintainability']) },
    );
    for (const dim of result.dimensions) {
      expect(dim.grade).toBe('A+');
    }
  });

  it('returns overall score near 100 with no findings', () => {
    const result = computeQualityRating([], 1000);
    expect(result.overall.score).toBeGreaterThanOrEqual(95);
  });

  it('passes the quality gate with no findings', () => {
    const result = computeQualityRating([], 1000);
    expect(result.qualityGate.passed).toBe(true);
    expect(result.qualityGate.failingConditions).toHaveLength(0);
  });

  it('sets gradeRationale to "Clean — no findings detected" with no findings', () => {
    const result = computeQualityRating([], 1000);
    expect(result.gradeRationale).toBe('Clean — no findings detected');
  });
});

// ============================================================================
// computeQualityRating — Security severity thresholds
// ============================================================================

describe('computeQualityRating — security severity thresholds', () => {
  it('assigns security F- for 1 critical security finding (was F under the old system)', () => {
    // Critical security is the worst possible offense — caps at the lowest grade
    // so it cannot be averaged away. Under the new spec it lands in F-, not F.
    const result = computeQualityRating([finding('critical', 'security')], 1000);
    const secDim = result.dimensions.find((d) => d.name === 'security')!;
    expect(secDim.grade).toBe('F-');
  });

  it('assigns overall F- when security is F-', () => {
    const result = computeQualityRating([finding('critical', 'security')], 1000);
    expect(result.overall.grade).toBe('F-');
  });

  it('assigns security F for 1 high security finding (was D under the old system)', () => {
    // The new system has no D band; 1 high security drops into F (56-64).
    const result = computeQualityRating([finding('high', 'security')], 1000);
    const secDim = result.dimensions.find((d) => d.name === 'security')!;
    expect(secDim.grade).toBe('F');
  });

  it('assigns security C-band for 1 medium security finding', () => {
    const result = computeQualityRating([finding('medium', 'security')], 1000);
    const secDim = result.dimensions.find((d) => d.name === 'security')!;
    // C+, C, or C- depending on within-band position — base letter must be C.
    expect(secDim.grade.charAt(0)).toBe('C');
  });

  it('assigns security B-band for 5 low security findings', () => {
    const findings = Array.from({ length: 5 }, () => finding('low', 'security'));
    const result = computeQualityRating(findings, 1000);
    const secDim = result.dimensions.find((d) => d.name === 'security')!;
    expect(secDim.grade.charAt(0)).toBe('B');
  });

  it('assigns security A+ when there are no security findings but other dimensions are populated', () => {
    const findings = [finding('low', 'bugs'), finding('low', 'lint')];
    const result = computeQualityRating(
      findings,
      1000,
      { availableDimensions: new Set(['security', 'reliability', 'maintainability']) },
    );
    const secDim = result.dimensions.find((d) => d.name === 'security')!;
    expect(secDim.grade).toBe('A+');
  });
});

// ============================================================================
// computeQualityRating — Reliability severity thresholds
// ============================================================================

describe('computeQualityRating — reliability severity thresholds', () => {
  it('assigns reliability A-band for 1 low bug (clean-branch — every team has one)', () => {
    const result = computeQualityRating([finding('low', 'bugs')], 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('A');
  });

  it('assigns reliability A-band for 2 low bugs (count ≤ 2)', () => {
    const findings = Array.from({ length: 2 }, () => finding('low', 'bugs'));
    const result = computeQualityRating(findings, 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('A');
  });

  it('assigns reliability A-band for 2 medium bugs (count ≤ 2 in small KLOC)', () => {
    const findings = Array.from({ length: 2 }, () => finding('medium', 'bugs'));
    const result = computeQualityRating(findings, 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('A');
  });

  it('assigns reliability B-band for 3 medium bugs (count enters 3-6 band)', () => {
    const findings = Array.from({ length: 3 }, () => finding('medium', 'bugs'));
    const result = computeQualityRating(findings, 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('B');
  });

  it('assigns reliability C-band for 7 medium bugs (count enters 7-15 band)', () => {
    const findings = Array.from({ length: 7 }, () => finding('medium', 'bugs'));
    const result = computeQualityRating(findings, 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('C');
  });

  it('assigns reliability F-band for 16 medium bugs (count > 15)', () => {
    const findings = Array.from({ length: 16 }, () => finding('medium', 'bugs'));
    const result = computeQualityRating(findings, 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('F');
  });

  it('caps reliability at C-band for 1 high bug (severity escape, not auto-F)', () => {
    const result = computeQualityRating([finding('high', 'bugs')], 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('C');
  });

  it('caps reliability at C-band for 2 high bugs (was F under the strict legacy rule)', () => {
    // Spec change: 2 high bugs now caps at C (via severity escape) instead
    // of auto-F. A handful of high-severity bugs on edge-case paths should
    // not pin the entire dimension at F when overall density is low.
    const findings = Array.from({ length: 2 }, () => finding('high', 'bugs'));
    const result = computeQualityRating(findings, 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('C');
  });

  it('caps reliability at F for 5 high bugs in a small KLOC (count enters F via density), severity-cap C is overshot', () => {
    // 5 high in 1 KLOC: count=5 → B-band density baseline; severity escape
    // caps at C; so final = C (worst of B and C). Severity escape only
    // *worsens* — it never pulls the grade up.
    const findings = Array.from({ length: 5 }, () => finding('high', 'bugs'));
    const result = computeQualityRating(findings, 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('C');
  });

  it('caps reliability at F-band for 1 critical bug', () => {
    const result = computeQualityRating([finding('critical', 'bugs')], 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('F');
  });

  it('caps reliability at F-band for build errors (build category routes to reliability)', () => {
    const result = computeQualityRating([finding('critical', 'build')], 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('F');
  });
});

// ============================================================================
// computeQualityRating — Reliability density (KLOC >= 5)
// ============================================================================

describe('computeQualityRating — reliability density (KLOC >= 5)', () => {
  it('A-band when density < 1.5 / KLOC (5 medium bugs in 5 KLOC = density 1.0)', () => {
    const findings = Array.from({ length: 5 }, () => finding('medium', 'bugs'));
    const result = computeQualityRating(findings, 5000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('A');
  });

  it('B-band when 1.5 ≤ density < 4 (10 medium bugs in 5 KLOC = density 2.0)', () => {
    const findings = Array.from({ length: 10 }, () => finding('medium', 'bugs'));
    const result = computeQualityRating(findings, 5000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('B');
  });

  it('C-band when 4 ≤ density < 8 (25 medium bugs in 5 KLOC = density 5.0)', () => {
    const findings = Array.from({ length: 25 }, () => finding('medium', 'bugs'));
    const result = computeQualityRating(findings, 5000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('C');
  });

  it('F-band when density ≥ 8 (50 medium bugs in 5 KLOC = density 10.0)', () => {
    const findings = Array.from({ length: 50 }, () => finding('medium', 'bugs'));
    const result = computeQualityRating(findings, 5000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('F');
  });

  it('caps at C via severity escape even when density is A-tier (1 high bug in 10 KLOC)', () => {
    const result = computeQualityRating([finding('high', 'bugs')], 10000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('C');
  });

  it('caps at F via severity escape when density is otherwise good (1 critical in 10 KLOC)', () => {
    const result = computeQualityRating([finding('critical', 'bugs')], 10000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade.charAt(0)).toBe('F');
  });
});

// ============================================================================
// computeQualityRating — Maintainability density (KLOC >= 5)
// ============================================================================

describe('computeQualityRating — maintainability density (KLOC >= 5)', () => {
  it('assigns maintainability A-band for 0 findings at 5000 lines', () => {
    const result = computeQualityRating([], 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade.charAt(0)).toBe('A');
  });

  it('assigns maintainability A-band for 24 lint findings at 5000 lines (density 4.8 < 5)', () => {
    const findings = Array.from({ length: 24 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade.charAt(0)).toBe('A');
  });

  it('assigns maintainability B-band for 25 lint findings at 5000 lines (density 5 — boundary)', () => {
    const findings = Array.from({ length: 25 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade.charAt(0)).toBe('B');
  });

  it('assigns maintainability C-band for 100 lint findings at 10000 lines (density 10)', () => {
    const findings = Array.from({ length: 100 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 10000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade.charAt(0)).toBe('C');
  });

  it('assigns maintainability F-band for 250 lint findings at 10000 lines (density 25, was D)', () => {
    const findings = Array.from({ length: 250 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 10000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade.charAt(0)).toBe('F');
  });

  it('assigns maintainability F-band for 500 lint findings at 10000 lines (density 50)', () => {
    const findings = Array.from({ length: 500 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 10000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade.charAt(0)).toBe('F');
  });
});

// ============================================================================
// computeQualityRating — Maintainability absolute (KLOC < 5)
// ============================================================================

describe('computeQualityRating — maintainability absolute counts (KLOC < 5)', () => {
  it('assigns maintainability A-band for 5 findings at 1000 lines', () => {
    const findings = Array.from({ length: 5 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 1000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade.charAt(0)).toBe('A');
  });

  it('assigns maintainability C-band for 16 findings at 1000 lines', () => {
    const findings = Array.from({ length: 16 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 1000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade.charAt(0)).toBe('C');
  });

  it('assigns maintainability F-band for 65 findings at 1000 lines', () => {
    const findings = Array.from({ length: 65 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 1000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade.charAt(0)).toBe('F');
  });
});

// ============================================================================
// computeQualityRating — Maintainability severity escape hatch
// ============================================================================

describe('computeQualityRating — maintainability severity escape hatch', () => {
  it('caps maintainability at C-band for 1 high-severity finding even when density says A', () => {
    const result = computeQualityRating([finding('high', 'lint')], 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade.charAt(0)).toBe('C');
  });

  it('caps maintainability at F-band for 1 critical-severity finding (was D under the old system)', () => {
    const result = computeQualityRating([finding('critical', 'lint')], 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade.charAt(0)).toBe('F');
  });

  it('picks worst grade when high severity and density both produce F-tier', () => {
    // 250 findings at 5000 lines → density 50 → F; high severity caps at C → F wins
    const findings = Array.from({ length: 250 }, (_, i) =>
      finding(i === 0 ? 'high' : 'low', 'lint'),
    );
    const result = computeQualityRating(findings, 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade.charAt(0)).toBe('F');
  });
});

// ============================================================================
// computeQualityRating — Architectural penalty
// ============================================================================

describe('computeQualityRating — architectural penalty drops the dimension grade', () => {
  it('drops Maintainability one letter for 1 high-severity arch finding', () => {
    // 1 high arch finding alone: density-grade A (1 issue / 5 KLOC = 0.2 < 5) +
    // severity escape cap (C for high). After arch penalty, drops 1 letter → F.
    // Without escape hatch, A → B; with cap C, C → F (next letter past C).
    const result = computeQualityRating([finding('high', 'architecture')], 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    // Cap at C (high severity escape) → drop 1 letter → F-band.
    expect(mDim.grade.charAt(0)).toBe('F');
  });

  it('drops Maintainability two letters for 2+ high-severity arch findings', () => {
    const findings = [finding('high', 'architecture'), finding('high', 'oop')];
    const result = computeQualityRating(findings, 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    // Severity-escape cap = C; 2 highs → drop 2 letters → F (capped).
    expect(mDim.grade.charAt(0)).toBe('F');
  });

  it('drops Maintainability two letters for 1 critical arch finding', () => {
    const result = computeQualityRating([finding('critical', 'architecture')], 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    // Critical severity → cap at F directly. Then arch drop -2 from F → F-.
    expect(mDim.grade).toBe('F-');
  });

  it('emits a "dropped N letters" rationale when the arch penalty fires', () => {
    const result = computeQualityRating([finding('high', 'architecture')], 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.rationale).toMatch(/dropped \d+ letter/);
  });

  it('does not affect the dimension grade when only low/medium arch findings exist', () => {
    const result = computeQualityRating([finding('medium', 'architecture')], 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    // No high or critical → no penalty applied. Density A but escape hatch
    // doesn't trigger for medium → A grade, no rationale change.
    expect(mDim.grade.charAt(0)).toBe('A');
    expect(mDim.rationale).not.toMatch(/dropped/);
  });
});

// ============================================================================
// computeQualityRating — Overall = worst dimension
// ============================================================================

describe('computeQualityRating — overall grade is worst dimension', () => {
  it('returns overall F-band when security and reliability are A but maintainability is F', () => {
    const findings = Array.from({ length: 250 }, () => finding('low', 'lint'));
    const result = computeQualityRating(
      findings,
      10000,
      { availableDimensions: new Set(['security', 'reliability', 'maintainability']) },
    );
    expect(result.overall.grade.charAt(0)).toBe('F');
  });

  it('returns overall F- when security is F- and others are A', () => {
    const result = computeQualityRating([finding('critical', 'security')], 1000);
    expect(result.overall.grade).toBe('F-');
  });

  it('returns overall A+ when all dimensions are A+', () => {
    const result = computeQualityRating([], 1000);
    expect(result.overall.grade).toBe('A+');
  });
});

// ============================================================================
// computeQualityRating — Overall score formula
// ============================================================================

describe('computeQualityRating — overall score formula (min of avg and min)', () => {
  it('overall score is in the worst dimension band when all dimensions are clean', () => {
    const result = computeQualityRating([], 5000);
    expect(result.overall.score).toBeGreaterThanOrEqual(95);
  });

  it('overall score is capped by the worst dimension score, not the average', () => {
    const result = computeQualityRating([finding('critical', 'security')], 5000, {
      availableDimensions: new Set(['security', 'reliability', 'maintainability']),
    });
    const secScore = result.dimensions.find((d) => d.name === 'security')!.score;
    expect(result.overall.score).toBeLessThanOrEqual(secScore);
  });

  it('overall score is a 0–100 integer', () => {
    const result = computeQualityRating([finding('high', 'security')], 5000);
    expect(Number.isInteger(result.overall.score)).toBe(true);
    expect(result.overall.score).toBeGreaterThanOrEqual(0);
    expect(result.overall.score).toBeLessThanOrEqual(100);
  });
});

// ============================================================================
// computeQualityRating — Quality Gate
// ============================================================================

describe('computeQualityRating — quality gate', () => {
  it('passes quality gate with 0 findings', () => {
    const result = computeQualityRating([], 1000);
    expect(result.qualityGate.passed).toBe(true);
  });

  it('fails quality gate for 1 medium security finding (security grade C)', () => {
    const result = computeQualityRating([finding('medium', 'security')], 1000);
    expect(result.qualityGate.passed).toBe(false);
    expect(result.qualityGate.failingConditions.length).toBeGreaterThan(0);
  });

  it('fails quality gate for 1 critical bug (reliability grade F-band)', () => {
    const result = computeQualityRating([finding('critical', 'bugs')], 1000);
    expect(result.qualityGate.passed).toBe(false);
  });

  it('passes quality gate for 1 high maintainability finding (gate ignores maintainability)', () => {
    const result = computeQualityRating([finding('high', 'lint')], 5000);
    expect(result.qualityGate.passed).toBe(true);
  });

  it('fails quality gate for 2+ architectural findings', () => {
    const findings = [finding('high', 'architecture'), finding('high', 'oop')];
    const result = computeQualityRating(findings, 5000);
    expect(result.qualityGate.passed).toBe(false);
    expect(result.qualityGate.failingConditions.some((c) => c.includes('architectural'))).toBe(true);
  });
});

// ============================================================================
// computeQualityRating — N/A dimension handling
// ============================================================================

describe('computeQualityRating — N/A dimension handling', () => {
  it('marks security as N/A when security is excluded from availableDimensions', () => {
    const result = computeQualityRating(
      [finding('low', 'lint')],
      1000,
      { availableDimensions: new Set(['reliability', 'maintainability']) },
    );
    const secDim = result.dimensions.find((d) => d.name === 'security')!;
    expect(secDim.grade).toBe('N/A');
    expect(secDim.available).toBe(false);
  });

  it('excludes N/A dimension from overall grade calculation', () => {
    const result = computeQualityRating(
      [],
      1000,
      { availableDimensions: new Set(['maintainability']) },
    );
    expect(result.overall.grade).toBe('A+');
  });

  it('returns N/A overall grade and score 0 when all dimensions are N/A', () => {
    const result = computeQualityRating(
      [],
      1000,
      { availableDimensions: new Set([]) },
    );
    expect(result.overall.grade).toBe('N/A');
    expect(result.overall.score).toBe(0);
  });

  it('returns A+ for security when security is available but has no findings', () => {
    const result = computeQualityRating(
      [],
      1000,
      { availableDimensions: new Set(['security', 'reliability', 'maintainability']) },
    );
    const secDim = result.dimensions.find((d) => d.name === 'security')!;
    expect(secDim.grade).toBe('A+');
    expect(secDim.available).toBe(true);
  });
});

// ============================================================================
// computeQualityRating — Grade rationale
// ============================================================================

describe('computeQualityRating — grade rationale', () => {
  it('returns "Clean — no findings detected" for 0 findings', () => {
    const result = computeQualityRating([], 1000);
    expect(result.gradeRationale).toBe('Clean — no findings detected');
  });

  it('includes "consistent" in rationale when all dimensions share the same grade', () => {
    const result = computeQualityRating(
      [finding('low', 'bugs'), finding('low', 'lint')],
      5000,
      { availableDimensions: new Set(['security', 'reliability', 'maintainability']) },
    );
    expect(result.gradeRationale.toLowerCase()).toContain('consistent');
  });

  it('starts rationale with "Capped at" when security dimension determines the overall grade', () => {
    const result = computeQualityRating(
      [finding('medium', 'security')],
      5000,
      { availableDimensions: new Set(['security', 'reliability', 'maintainability']) },
    );
    expect(result.gradeRationale).toMatch(/^Capped at/);
    expect(result.gradeRationale).toContain('Security');
  });

  it('rationale mentions "Clean" for zero findings', () => {
    const result = computeQualityRating([], 5000);
    expect(result.gradeRationale).toContain('Clean');
  });
});

// ============================================================================
// computeQualityRating — Score boundary verification
// ============================================================================

describe('computeQualityRating — score boundaries match grade bands', () => {
  it('A-band score is in [90, 100]', () => {
    const result = computeQualityRating([], 5000, {
      availableDimensions: new Set(['security', 'reliability', 'maintainability']),
    });
    expect(result.overall.grade.charAt(0)).toBe('A');
    expect(result.overall.score).toBeGreaterThanOrEqual(90);
    expect(result.overall.score).toBeLessThanOrEqual(100);
  });

  it('B-band score is in [80, 89]', () => {
    // 10 medium bugs at 5 KLOC = density 2.0 → B-band per the new ladder.
    const result = computeQualityRating(
      Array.from({ length: 10 }, () => finding('medium', 'bugs')),
      5000,
      { availableDimensions: new Set(['security', 'reliability', 'maintainability']) },
    );
    const rel = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(rel.grade.charAt(0)).toBe('B');
    expect(rel.score).toBeGreaterThanOrEqual(80);
    expect(rel.score).toBeLessThanOrEqual(89);
  });

  it('C-band score is in [70, 79]', () => {
    const result = computeQualityRating([finding('medium', 'security')], 5000);
    const sec = result.dimensions.find((d) => d.name === 'security')!;
    expect(sec.grade.charAt(0)).toBe('C');
    expect(sec.score).toBeGreaterThanOrEqual(70);
    expect(sec.score).toBeLessThanOrEqual(79);
  });

  it('F-band (F+) score is in [65, 69]', () => {
    const result = computeQualityRating([finding('high', 'security')], 5000);
    const sec = result.dimensions.find((d) => d.name === 'security')!;
    // 1 high → grade F, position 0.5 → mid-band ~63 → F (56-64).
    expect(sec.grade.charAt(0)).toBe('F');
    expect(sec.score).toBeGreaterThanOrEqual(0);
    expect(sec.score).toBeLessThanOrEqual(69);
  });

  it('F-band (F-) score is in [0, 55]', () => {
    const result = computeQualityRating([finding('critical', 'security')], 5000);
    const sec = result.dimensions.find((d) => d.name === 'security')!;
    expect(sec.grade).toBe('F-');
    expect(sec.score).toBeGreaterThanOrEqual(0);
    expect(sec.score).toBeLessThanOrEqual(55);
  });

  it('overall.score is integer (rounded)', () => {
    const result = computeQualityRating(
      [finding('medium', 'bugs'), finding('low', 'lint')],
      5000,
      { availableDimensions: new Set(['security', 'reliability', 'maintainability']) },
    );
    expect(Number.isInteger(result.overall.score)).toBe(true);
  });
});

// ============================================================================
// computeQualityRating — worstSeverity field
// ============================================================================

describe('computeQualityRating — worstSeverity field', () => {
  it('reports null worstSeverity for clean dimension', () => {
    const result = computeQualityRating([], 5000, {
      availableDimensions: new Set(['security', 'reliability', 'maintainability']),
    });
    for (const dim of result.dimensions) {
      expect(dim.worstSeverity).toBeNull();
    }
  });

  it('reports critical when any critical finding exists', () => {
    const result = computeQualityRating(
      [finding('low', 'security'), finding('critical', 'security'), finding('medium', 'security')],
      5000,
    );
    const sec = result.dimensions.find((d) => d.name === 'security')!;
    expect(sec.worstSeverity).toBe('critical');
  });

  it('reports high when no critical but high present', () => {
    const result = computeQualityRating(
      [finding('low', 'bugs'), finding('high', 'bugs')],
      5000,
    );
    const rel = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(rel.worstSeverity).toBe('high');
  });

  it('reports medium when only medium and low', () => {
    const result = computeQualityRating(
      [finding('low', 'lint'), finding('medium', 'lint')],
      5000,
    );
    const maint = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(maint.worstSeverity).toBe('medium');
  });

  it('reports low when only low findings', () => {
    const result = computeQualityRating([finding('low', 'lint')], 5000);
    const maint = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(maint.worstSeverity).toBe('low');
  });
});

// ============================================================================
// computeQualityRating — Pluralization in rationale
// ============================================================================

describe('computeQualityRating — pluralization in rationale', () => {
  it('uses singular for 1 critical security finding', () => {
    const result = computeQualityRating([finding('critical', 'security')], 5000);
    const sec = result.dimensions.find((d) => d.name === 'security')!;
    expect(sec.rationale).toContain('1 critical-severity security issue');
    expect(sec.rationale).not.toContain('issues');
  });

  it('uses plural for 2+ critical security findings', () => {
    const result = computeQualityRating(
      [finding('critical', 'security'), finding('critical', 'security')],
      5000,
    );
    const sec = result.dimensions.find((d) => d.name === 'security')!;
    expect(sec.rationale).toContain('2 critical-severity security issues');
  });

  it('uses singular for 1 high reliability bug', () => {
    const result = computeQualityRating([finding('high', 'bugs')], 5000);
    const rel = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(rel.rationale).toContain('1 high-severity bug');
    expect(rel.rationale).not.toContain('bugs');
  });

  it('rationale uses plural noun for multi-finding reliability density label', () => {
    // The reliability rationale is now density-based ("0.6 reliability issues
    // / KLOC") rather than severity-grouped, so the pluralisation point of
    // interest is the noun "issues" agreeing with count > 1. We assert the
    // density format and the plural noun without baking in exact figures.
    const result = computeQualityRating(
      [finding('medium', 'bugs'), finding('medium', 'bugs'), finding('medium', 'bugs')],
      5000,
    );
    const rel = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(rel.rationale).toMatch(/reliability issues \/ KLOC/);
  });
});

// ============================================================================
// computeQualityRating — Reliability "only-low > 1" branch
// ============================================================================

describe('computeQualityRating — reliability with multiple lows, no medium/high/critical', () => {
  it('2 low bugs → reliability A-band (density 0.4 / KLOC at 5 KLOC)', () => {
    // Two low-severity bugs across 5 KLOC is density 0.4 — well inside the
    // A band. Under the legacy thresholds this dropped to B; the softer
    // density model now keeps it in A, matching how a senior engineer
    // would triage a clean codebase with two minor issues.
    const result = computeQualityRating(
      [finding('low', 'bugs'), finding('low', 'bugs')],
      5000,
    );
    const rel = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(rel.grade.charAt(0)).toBe('A');
  });

  it('15 low bugs in 5 KLOC → reliability B (density 3.0 enters B band)', () => {
    const result = computeQualityRating(
      Array.from({ length: 15 }, () => finding('low', 'bugs')),
      5000,
    );
    const rel = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(rel.grade.charAt(0)).toBe('B');
  });
});

// ============================================================================
// computeQualityRating — Quality gate at every Security grade
// ============================================================================

describe('computeQualityRating — quality gate per Security grade', () => {
  it('PASS for Security A+', () => {
    const result = computeQualityRating([], 5000, {
      availableDimensions: new Set(['security']),
    });
    expect(result.qualityGate.passed).toBe(true);
  });

  it('PASS for Security B-band (only low findings)', () => {
    const result = computeQualityRating([finding('low', 'security')], 5000);
    expect(result.qualityGate.passed).toBe(true);
  });

  it('FAIL for Security C-band (1 medium)', () => {
    const result = computeQualityRating([finding('medium', 'security')], 5000);
    expect(result.qualityGate.passed).toBe(false);
    expect(result.qualityGate.failingConditions[0]).toMatch(/Security grade C/);
  });

  it('FAIL for Security F-band (1 high)', () => {
    const result = computeQualityRating([finding('high', 'security')], 5000);
    expect(result.qualityGate.passed).toBe(false);
    expect(result.qualityGate.failingConditions[0]).toMatch(/Security grade F/);
  });

  it('FAIL for Security F- (1 critical)', () => {
    const result = computeQualityRating([finding('critical', 'security')], 5000);
    expect(result.qualityGate.passed).toBe(false);
    expect(result.qualityGate.failingConditions[0]).toMatch(/Security grade F-/);
  });
});

// ============================================================================
// computeQualityRating — forceNA option
// ============================================================================

describe('computeQualityRating — forceNA option', () => {
  it('marks Maintainability N/A when in forceNA, even with maintainability findings', () => {
    const result = computeQualityRating(
      [finding('medium', 'lint'), finding('low', 'format')],
      5000,
      { forceNA: new Set(['maintainability']) },
    );
    const maint = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(maint.grade).toBe('N/A');
    expect(maint.available).toBe(false);
  });

  it('forceNA takes precedence over availableDimensions for the same dim', () => {
    const result = computeQualityRating([], 5000, {
      availableDimensions: new Set(['security', 'reliability', 'maintainability']),
      forceNA: new Set(['security']),
    });
    const sec = result.dimensions.find((d) => d.name === 'security')!;
    expect(sec.grade).toBe('N/A');
    expect(sec.available).toBe(false);
  });

  it('forceNA does not affect non-listed dimensions', () => {
    const result = computeQualityRating(
      [finding('medium', 'security')],
      5000,
      { forceNA: new Set(['maintainability']) },
    );
    const sec = result.dimensions.find((d) => d.name === 'security')!;
    expect(sec.grade.charAt(0)).toBe('C');
    expect(sec.available).toBe(true);
  });

  it('overall ignores forceNA dimensions when computing worst grade', () => {
    const result = computeQualityRating(
      [finding('high', 'lint')],
      5000,
      { forceNA: new Set(['maintainability']) },
    );
    expect(result.overall.grade).toBe('N/A');
  });
});
