// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Quality ETA — duration estimation for scan + AI review operations.
 *
 * Uses persisted history when available (most accurate), falls back to a
 * simple heuristic derived from file count + line count when there is no
 * history yet (cold start).
 *
 * Estimates are intentionally conservative: better to over-estimate by a bit
 * and have the bar finish "early" than to under-estimate and have the bar
 * sit at 100% while work continues — the latter destroys trust in the ETA.
 */

import type { QualityHistoryEntry } from './quality-persistence.js';

// ── Heuristic constants ──────────────────────────────────────
//
// Numbers tuned against typical TypeScript codebases (mstro cli/server/web)
// observed in the wild — see history.json for the corpus. Treat them as
// reasonable defaults that the history-based path will quickly correct once
// real durations land in storage.

/** Per-file overhead for a CLI scan (linting, formatting, file/function-length checks). */
const SCAN_PER_FILE_MS = 250;
/** Per-1000-LOC overhead for a CLI scan, dominated by `tsc --noEmit` on TS projects. */
const SCAN_PER_KLOC_MS = 800;
/** Fixed overhead per scan: tool detection, file collection, score computation. */
const SCAN_FIXED_MS = 8_000;
/** Floor — the smallest "I'm doing something" we should ever show. */
const SCAN_MIN_MS = 5_000;

/** Per-file overhead for the AI code-review agent (Claude Read calls, validation). */
const REVIEW_PER_FILE_MS = 1_200;
/** Per-1000-LOC overhead for the AI code-review agent. */
const REVIEW_PER_KLOC_MS = 2_500;
/** Fixed overhead per review: Claude spawn, prompt building, persistence. */
const REVIEW_FIXED_MS = 25_000;
/** Floor for the review estimate. */
const REVIEW_MIN_MS = 30_000;

// ── History smoothing ────────────────────────────────────────
//
// Use the last few real durations for the same directory and weight them by
// recency. A single one-off slow run shouldn't dominate the estimate, but
// fresh data should outweigh stale data (codebase grew, machine got faster,
// etc.).
const MAX_HISTORY_SAMPLES = 5;

interface HistoryEntryWithTimings extends QualityHistoryEntry {
  scanDurationMs?: number;
  reviewDurationMs?: number;
}

function recentDurations(
  history: HistoryEntryWithTimings[],
  dirPath: string,
  field: 'scanDurationMs' | 'reviewDurationMs',
): number[] {
  const values: number[] = [];
  // Walk newest → oldest; only consider entries that actually touched this directory.
  for (let i = history.length - 1; i >= 0 && values.length < MAX_HISTORY_SAMPLES; i--) {
    const entry = history[i];
    if (!entry.directories.some((d) => d.path === dirPath)) continue;
    const v = entry[field];
    if (typeof v === 'number' && v > 0) values.push(v);
  }
  return values;
}

/**
 * Weighted average favouring newer samples. Weights are 1, 2, 3, 4, 5 for the
 * 5 most-recent runs (newest first → highest weight) — a "this run mostly
 * matters" curve that still smooths over a single anomaly.
 */
function weightedRecentAverage(values: number[]): number | null {
  if (values.length === 0) return null;
  let weightSum = 0;
  let valueSum = 0;
  // values[0] is newest, so its weight is `values.length`.
  for (let i = 0; i < values.length; i++) {
    const w = values.length - i;
    valueSum += values[i] * w;
    weightSum += w;
  }
  return weightSum > 0 ? valueSum / weightSum : null;
}

// ── Public API ────────────────────────────────────────────────

export interface CodebaseSize {
  /** Number of source files the scan/review will analyse. */
  files: number;
  /** Total lines across those files. */
  lines: number;
}

/**
 * Heuristic estimate for a CLI scan when we have no history. Combines a fixed
 * floor with per-file + per-KLOC components — `tsc --noEmit` and lint scale
 * with codebase size, so scaling on both files and lines maps reality better
 * than scaling on either alone.
 */
export function heuristicScanMs({ files, lines }: CodebaseSize): number {
  const kloc = Math.max(0, lines) / 1_000;
  const raw = SCAN_FIXED_MS + files * SCAN_PER_FILE_MS + kloc * SCAN_PER_KLOC_MS;
  return Math.max(SCAN_MIN_MS, Math.round(raw));
}

/** Heuristic estimate for the AI review agent when we have no history. */
export function heuristicReviewMs({ files, lines }: CodebaseSize): number {
  const kloc = Math.max(0, lines) / 1_000;
  const raw = REVIEW_FIXED_MS + files * REVIEW_PER_FILE_MS + kloc * REVIEW_PER_KLOC_MS;
  return Math.max(REVIEW_MIN_MS, Math.round(raw));
}

/**
 * Best-available ETA for a CLI scan. Prefers a weighted average of recent
 * durations for this exact directory; falls back to the heuristic when no
 * timing history exists.
 */
export function estimateScanMs(
  size: CodebaseSize,
  history: HistoryEntryWithTimings[],
  dirPath: string,
): number {
  const recent = recentDurations(history, dirPath, 'scanDurationMs');
  const fromHistory = weightedRecentAverage(recent);
  if (fromHistory !== null) return Math.max(SCAN_MIN_MS, Math.round(fromHistory));
  return heuristicScanMs(size);
}

/** Best-available ETA for the AI code-review agent. Same fallback shape as `estimateScanMs`. */
export function estimateReviewMs(
  size: CodebaseSize,
  history: HistoryEntryWithTimings[],
  dirPath: string,
): number {
  const recent = recentDurations(history, dirPath, 'reviewDurationMs');
  const fromHistory = weightedRecentAverage(recent);
  if (fromHistory !== null) return Math.max(REVIEW_MIN_MS, Math.round(fromHistory));
  return heuristicReviewMs(size);
}

/**
 * Estimate codebase size from a directory using the same fast traversal the
 * scan itself uses. Pulled out as a thin wrapper so the handler can call it
 * before kicking off the scan to compute an initial ETA.
 */
export async function estimateCodebaseSize(dirPath: string): Promise<CodebaseSize> {
  const { collectSourceFiles } = await import('./quality-tools.js');
  const files = await collectSourceFiles(dirPath, dirPath);
  const lines = files.reduce((sum, f) => sum + f.lines, 0);
  return { files: files.length, lines };
}
