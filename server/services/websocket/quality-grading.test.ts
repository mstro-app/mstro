// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { describe, expect, it } from 'vitest';
import {
  categoryToDimension,
  computeQualityRating,
  gradeFromScore,
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
// gradeFromScore (legacy)
// ============================================================================

describe('gradeFromScore', () => {
  it('returns A for score 100', () => {
    expect(gradeFromScore(100)).toBe('A');
  });

  it('returns A for score 90', () => {
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

  it('returns D for score 69', () => {
    expect(gradeFromScore(69)).toBe('D');
  });

  it('returns D for score 60', () => {
    expect(gradeFromScore(60)).toBe('D');
  });

  it('returns F for score 59', () => {
    expect(gradeFromScore(59)).toBe('F');
  });

  it('returns F for score 0', () => {
    expect(gradeFromScore(0)).toBe('F');
  });
});

// ============================================================================
// computeQualityRating — Empty / Clean
// ============================================================================

describe('computeQualityRating — empty/clean', () => {
  it('returns A grade for all available dimensions with no findings', () => {
    // With no findings and no availableDimensions override, security and reliability
    // auto-detect as N/A (no findings map there). Maintainability is always available.
    // Pass explicit availableDimensions so all three are graded.
    const result = computeQualityRating(
      [],
      1000,
      { availableDimensions: new Set(['security', 'reliability', 'maintainability']) },
    );
    for (const dim of result.dimensions) {
      expect(dim.grade).toBe('A');
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
  it('assigns security F for 1 critical security finding', () => {
    const result = computeQualityRating([finding('critical', 'security')], 1000);
    const secDim = result.dimensions.find((d) => d.name === 'security')!;
    expect(secDim.grade).toBe('F');
  });

  it('assigns overall F when security is F', () => {
    const result = computeQualityRating([finding('critical', 'security')], 1000);
    expect(result.overall.grade).toBe('F');
  });

  it('assigns security D for 1 high security finding', () => {
    const result = computeQualityRating([finding('high', 'security')], 1000);
    const secDim = result.dimensions.find((d) => d.name === 'security')!;
    expect(secDim.grade).toBe('D');
  });

  it('assigns security C for 1 medium security finding', () => {
    const result = computeQualityRating([finding('medium', 'security')], 1000);
    const secDim = result.dimensions.find((d) => d.name === 'security')!;
    expect(secDim.grade).toBe('C');
  });

  it('assigns security B for 5 low security findings', () => {
    const findings = Array.from({ length: 5 }, () => finding('low', 'security'));
    const result = computeQualityRating(findings, 1000);
    const secDim = result.dimensions.find((d) => d.name === 'security')!;
    expect(secDim.grade).toBe('B');
  });

  it('assigns security A when there are no security findings but other dimensions are populated', () => {
    const findings = [finding('low', 'bugs'), finding('low', 'lint')];
    const result = computeQualityRating(
      findings,
      1000,
      { availableDimensions: new Set(['security', 'reliability', 'maintainability']) },
    );
    const secDim = result.dimensions.find((d) => d.name === 'security')!;
    expect(secDim.grade).toBe('A');
  });
});

// ============================================================================
// computeQualityRating — Reliability severity thresholds
// ============================================================================

describe('computeQualityRating — reliability severity thresholds', () => {
  it('assigns reliability A for 1 low bug', () => {
    const result = computeQualityRating([finding('low', 'bugs')], 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade).toBe('A');
  });

  it('assigns reliability B for 2 low bugs', () => {
    const findings = Array.from({ length: 2 }, () => finding('low', 'bugs'));
    const result = computeQualityRating(findings, 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade).toBe('B');
  });

  it('assigns reliability B for 2 medium bugs', () => {
    const findings = Array.from({ length: 2 }, () => finding('medium', 'bugs'));
    const result = computeQualityRating(findings, 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade).toBe('B');
  });

  it('assigns reliability C for 3 medium bugs', () => {
    const findings = Array.from({ length: 3 }, () => finding('medium', 'bugs'));
    const result = computeQualityRating(findings, 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade).toBe('C');
  });

  it('assigns reliability C for 1 high bug', () => {
    const result = computeQualityRating([finding('high', 'bugs')], 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade).toBe('C');
  });

  it('assigns reliability D for 2 high bugs', () => {
    const findings = Array.from({ length: 2 }, () => finding('high', 'bugs'));
    const result = computeQualityRating(findings, 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade).toBe('D');
  });

  it('assigns reliability F for 1 critical bug', () => {
    const result = computeQualityRating([finding('critical', 'bugs')], 1000);
    const relDim = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(relDim.grade).toBe('F');
  });
});

// ============================================================================
// computeQualityRating — Maintainability density (KLOC >= 5)
// ============================================================================

describe('computeQualityRating — maintainability density (KLOC >= 5)', () => {
  it('assigns maintainability A for 0 findings at 5000 lines', () => {
    const result = computeQualityRating([], 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade).toBe('A');
  });

  it('assigns maintainability A for 24 lint findings at 5000 lines (density 4.8 < 5)', () => {
    const findings = Array.from({ length: 24 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade).toBe('A');
  });

  it('assigns maintainability B for 25 lint findings at 5000 lines (density 5 — boundary)', () => {
    const findings = Array.from({ length: 25 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade).toBe('B');
  });

  it('assigns maintainability C for 100 lint findings at 10000 lines (density 10)', () => {
    const findings = Array.from({ length: 100 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 10000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade).toBe('C');
  });

  it('assigns maintainability D for 250 lint findings at 10000 lines (density 25)', () => {
    const findings = Array.from({ length: 250 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 10000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade).toBe('D');
  });

  it('assigns maintainability F for 500 lint findings at 10000 lines (density 50)', () => {
    const findings = Array.from({ length: 500 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 10000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade).toBe('F');
  });

  it('assigns maintainability F for 600 lint findings at 10000 lines (density 60)', () => {
    const findings = Array.from({ length: 600 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 10000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade).toBe('F');
  });
});

// ============================================================================
// computeQualityRating — Maintainability absolute (KLOC < 5)
// ============================================================================

describe('computeQualityRating — maintainability absolute counts (KLOC < 5)', () => {
  it('assigns maintainability A for 5 findings at 1000 lines', () => {
    const findings = Array.from({ length: 5 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 1000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade).toBe('A');
  });

  it('assigns maintainability C for 16 findings at 1000 lines', () => {
    const findings = Array.from({ length: 16 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 1000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade).toBe('C');
  });

  it('assigns maintainability F for 65 findings at 1000 lines', () => {
    const findings = Array.from({ length: 65 }, () => finding('low', 'lint'));
    const result = computeQualityRating(findings, 1000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    expect(mDim.grade).toBe('F');
  });
});

// ============================================================================
// computeQualityRating — Maintainability severity escape hatch
// ============================================================================

describe('computeQualityRating — maintainability severity escape hatch', () => {
  it('caps maintainability at C for 1 high-severity finding even when density says A (5000 lines, 1 finding)', () => {
    const result = computeQualityRating([finding('high', 'lint')], 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    // density = 1/5 = 0.2 → A; but high severity caps at C
    expect(mDim.grade).toBe('C');
  });

  it('caps maintainability at D for 1 critical-severity finding even when density says A (5000 lines, 1 finding)', () => {
    const result = computeQualityRating([finding('critical', 'lint')], 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    // density = 1/5 = 0.2 → A; but critical severity caps at D
    expect(mDim.grade).toBe('D');
  });

  it('picks worst grade when high severity and density both produce D', () => {
    // 250 findings at 5000 lines → density 50 → F; high severity caps at C → F wins
    const findings = Array.from({ length: 250 }, (_, i) =>
      finding(i === 0 ? 'high' : 'low', 'lint'),
    );
    const result = computeQualityRating(findings, 5000);
    const mDim = result.dimensions.find((d) => d.name === 'maintainability')!;
    // density 250/5 = 50 → F; escape cap is C; F is worse → F
    expect(mDim.grade).toBe('F');
  });
});

// ============================================================================
// computeQualityRating — Overall = worst dimension
// ============================================================================

describe('computeQualityRating — overall grade is worst dimension', () => {
  it('returns overall D when security and reliability are A but maintainability is D', () => {
    // 250 low-lint findings at 10000 lines → maintainability D
    // Security and reliability explicitly available but no findings → A
    const findings = Array.from({ length: 250 }, () => finding('low', 'lint'));
    const result = computeQualityRating(
      findings,
      10000,
      { availableDimensions: new Set(['security', 'reliability', 'maintainability']) },
    );
    expect(result.overall.grade).toBe('D');
  });

  it('returns overall F when security is F and others are A', () => {
    const result = computeQualityRating([finding('critical', 'security')], 1000);
    expect(result.overall.grade).toBe('F');
  });

  it('returns overall A when all dimensions are A', () => {
    const result = computeQualityRating([], 1000);
    expect(result.overall.grade).toBe('A');
  });
});

// ============================================================================
// computeQualityRating — Overall score formula
// ============================================================================

describe('computeQualityRating — overall score formula (min of avg and min)', () => {
  it('overall score equals the shared score when all dimensions have the same score', () => {
    // No findings → all dimensions score 100; overall = min(avg=100, min=100) = 100
    const result = computeQualityRating([], 5000);
    const scores = result.dimensions.filter((d) => d.available).map((d) => d.score);
    const avg = scores.reduce((s, n) => s + n, 0) / scores.length;
    const minScore = Math.min(...scores);
    expect(result.overall.score).toBe(Math.round(Math.min(avg, minScore)));
  });

  it('overall score is capped by the worst dimension score, not the average', () => {
    // 1 critical security finding → security score in F band (very low)
    // Check that overall.score <= the security dimension score
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

  it('fails quality gate for 1 critical bug (reliability grade F)', () => {
    const result = computeQualityRating([finding('critical', 'bugs')], 1000);
    expect(result.qualityGate.passed).toBe(false);
  });

  it('passes quality gate for 1 high maintainability finding (gate ignores maintainability)', () => {
    const result = computeQualityRating([finding('high', 'lint')], 5000);
    expect(result.qualityGate.passed).toBe(true);
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
    // Security N/A, reliability N/A, only maintainability available with no findings → A
    const result = computeQualityRating(
      [],
      1000,
      { availableDimensions: new Set(['maintainability']) },
    );
    expect(result.overall.grade).toBe('A');
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

  it('returns grade A (not N/A) for security when security is available but has no findings', () => {
    const result = computeQualityRating(
      [],
      1000,
      { availableDimensions: new Set(['security', 'reliability', 'maintainability']) },
    );
    const secDim = result.dimensions.find((d) => d.name === 'security')!;
    expect(secDim.grade).toBe('A');
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
    // With 0 findings and all dimensions available all grades are A → "consistent" path.
    // Using 1 finding to avoid the totalFindingCount===0 early-exit that returns "Clean".
    // 1 low bug → reliability A (1 low is still A); security A (available, 0 security
    // findings); maintainability A (1 lint finding at 5000 lines → density 0.2 → A).
    const result = computeQualityRating(
      [finding('low', 'bugs'), finding('low', 'lint')],
      5000,
      { availableDimensions: new Set(['security', 'reliability', 'maintainability']) },
    );
    expect(result.gradeRationale.toLowerCase()).toContain('consistent');
  });

  it('starts rationale with "Capped at" when security dimension determines the overall grade', () => {
    // 1 medium security finding → security C, others likely better → rationale mentions Security
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
  it('grade A score is in [90, 100]', () => {
    const result = computeQualityRating([], 5000, {
      availableDimensions: new Set(['security', 'reliability', 'maintainability']),
    });
    expect(result.overall.grade).toBe('A');
    expect(result.overall.score).toBeGreaterThanOrEqual(90);
    expect(result.overall.score).toBeLessThanOrEqual(100);
  });

  it('grade B score is in [80, 89]', () => {
    // 1 medium reliability → B; nothing else → security/maintainability A.
    // overall = worst = B; score capped by min(scores) so it lands in B band.
    const result = computeQualityRating(
      [finding('medium', 'bugs')],
      5000,
      { availableDimensions: new Set(['security', 'reliability', 'maintainability']) },
    );
    const rel = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(rel.grade).toBe('B');
    expect(rel.score).toBeGreaterThanOrEqual(80);
    expect(rel.score).toBeLessThanOrEqual(89);
    expect(result.overall.grade).toBe('B');
    expect(result.overall.score).toBeGreaterThanOrEqual(80);
    expect(result.overall.score).toBeLessThanOrEqual(89);
  });

  it('grade C score is in [70, 79]', () => {
    const result = computeQualityRating([finding('medium', 'security')], 5000);
    const sec = result.dimensions.find((d) => d.name === 'security')!;
    expect(sec.grade).toBe('C');
    expect(sec.score).toBeGreaterThanOrEqual(70);
    expect(sec.score).toBeLessThanOrEqual(79);
  });

  it('grade D score is in [60, 69]', () => {
    const result = computeQualityRating([finding('high', 'security')], 5000);
    const sec = result.dimensions.find((d) => d.name === 'security')!;
    expect(sec.grade).toBe('D');
    expect(sec.score).toBeGreaterThanOrEqual(60);
    expect(sec.score).toBeLessThanOrEqual(69);
  });

  it('grade F score is in [0, 59]', () => {
    const result = computeQualityRating([finding('critical', 'security')], 5000);
    const sec = result.dimensions.find((d) => d.name === 'security')!;
    expect(sec.grade).toBe('F');
    expect(sec.score).toBeGreaterThanOrEqual(0);
    expect(sec.score).toBeLessThanOrEqual(59);
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

  it('uses plural for 3 medium reliability findings', () => {
    const result = computeQualityRating(
      [finding('medium', 'bugs'), finding('medium', 'bugs'), finding('medium', 'bugs')],
      5000,
    );
    const rel = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(rel.rationale).toContain('3 medium-severity reliability issues');
  });
});

// ============================================================================
// computeQualityRating — Reliability "only-low > 1" branch
// ============================================================================

describe('computeQualityRating — reliability with multiple lows, no medium/high/critical', () => {
  it('2 low bugs → reliability B (lows-only branch)', () => {
    const result = computeQualityRating(
      [finding('low', 'bugs'), finding('low', 'bugs')],
      5000,
    );
    const rel = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(rel.grade).toBe('B');
    expect(rel.rationale).toContain('2 low-severity reliability issues');
  });

  it('5 low bugs → still reliability B', () => {
    const result = computeQualityRating(
      Array.from({ length: 5 }, () => finding('low', 'bugs')),
      5000,
    );
    const rel = result.dimensions.find((d) => d.name === 'reliability')!;
    expect(rel.grade).toBe('B');
  });
});

// ============================================================================
// computeQualityRating — Quality gate at every Security grade
// ============================================================================

describe('computeQualityRating — quality gate per Security grade', () => {
  it('PASS for Security A', () => {
    const result = computeQualityRating([], 5000, {
      availableDimensions: new Set(['security']),
    });
    expect(result.qualityGate.passed).toBe(true);
  });

  it('PASS for Security B (only low findings)', () => {
    const result = computeQualityRating([finding('low', 'security')], 5000);
    expect(result.qualityGate.passed).toBe(true);
  });

  it('FAIL for Security C (1 medium)', () => {
    const result = computeQualityRating([finding('medium', 'security')], 5000);
    expect(result.qualityGate.passed).toBe(false);
    expect(result.qualityGate.failingConditions[0]).toContain('Security grade C');
  });

  it('FAIL for Security D (1 high)', () => {
    const result = computeQualityRating([finding('high', 'security')], 5000);
    expect(result.qualityGate.passed).toBe(false);
    expect(result.qualityGate.failingConditions[0]).toContain('Security grade D');
  });

  it('FAIL for Security F (1 critical)', () => {
    const result = computeQualityRating([finding('critical', 'security')], 5000);
    expect(result.qualityGate.passed).toBe(false);
    expect(result.qualityGate.failingConditions[0]).toContain('Security grade F');
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
    expect(sec.grade).toBe('C');
    expect(sec.available).toBe(true);
  });

  it('overall ignores forceNA dimensions when computing worst grade', () => {
    const result = computeQualityRating(
      [finding('high', 'lint')],
      5000,
      { forceNA: new Set(['maintainability']) },
    );
    // Maintainability would be C with the escape hatch but is forced N/A,
    // so overall reflects only available dims (no security/reliability findings → none auto-available).
    expect(result.overall.grade).toBe('N/A');
  });
});
