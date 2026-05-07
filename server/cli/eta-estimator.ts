// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * ETA estimator for the chat composing indicator.
 *
 * Reads recent movements from `.mstro/history/*.json` and builds a small
 * conditional-quantile table: for each elapsed-time checkpoint, the p50/p90
 * of TOTAL movement duration among movements that hadn't finished yet at
 * that elapsed time. The web indicator interpolates against this table to
 * render "Composing · {elapsed} · ~{p50} typical · {tokens}".
 *
 * Why conditional-on-elapsed and not a regression on prompt features:
 *   - prompt length is uncorrelated with duration (r≈0.05); tool count is
 *     strong (r≈0.74) but unknown a priori. Conditioning on elapsed alone
 *     beats a static estimate dramatically — accuracy at 5m elapsed is
 *     ~38% MAPE vs 160% at 0s with the same lookup, because the longer the
 *     run goes, the smaller the cohort it could still belong to.
 *
 * Why a quantile table and not a regression model:
 *   - The duration distribution is heavily skewed (mean 4m20s, median 1m49s,
 *     p99 29m). A point estimate from a regression would be misleading; the
 *     web shows a typical/range pair so users see "around X, can be up to Y".
 *
 * Sample selection:
 *   - Up to MAX_SAMPLE_FILES most recent files by mtime, keeping work bounded
 *     and biasing toward recent behavior. Movements with durationMs < 1s or
 *     above SANITY_CEILING_MS are dropped as outliers (cancelled before they
 *     started, or runaway sessions that don't represent typical waits).
 *
 * Returns `null` when there are fewer than MIN_SAMPLES movements; the caller
 * falls back to "no ETA" rather than inventing one from too little data.
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { SessionHistory } from './improvisation-types.js';

/** Bucket boundaries (ms) at which we precompute conditional quantiles. */
const ELAPSED_CHECKPOINTS_MS = [
  0,           // a-priori (elapsed=0)
  10_000,      // 10s
  30_000,      // 30s
  60_000,      // 1m
  120_000,     // 2m
  300_000,     // 5m
  600_000,     // 10m
  900_000,     // 15m
  1_500_000,   // 25m
  2_400_000,   // 40m
  3_600_000,   // 60m
];

const MAX_SAMPLE_FILES = 200;
const MIN_SAMPLES = 30;
const SANITY_FLOOR_MS = 1_000;        // <1s = noise (errors, instant cancels)
const SANITY_CEILING_MS = 6 * 60 * 60_000; // 6h cap

export interface EtaBucket {
  /** Elapsed-ms threshold for this bucket. */
  elapsedMs: number;
  /** Conditional p50 of TOTAL duration among movements still running at elapsedMs. */
  p50TotalMs: number;
  /** Conditional p90 of TOTAL duration. */
  p90TotalMs: number;
  /** Sample count behind this bucket. */
  n: number;
}

export interface EtaProfile {
  /** Buckets in ascending elapsedMs. */
  buckets: EtaBucket[];
  /** Number of movements the profile was built from. */
  sampleSize: number;
  /** ISO timestamp of when this profile was computed. */
  computedAt: string;
}

export interface EtaPrediction {
  /** Predicted total duration (p50). Always >= elapsed. */
  p50TotalMs: number;
  /** Predicted upper bound (p90). Always >= p50. */
  p90TotalMs: number;
  /** Sample size for the bucket used. */
  n: number;
}

/**
 * Build an EtaProfile from a `.mstro/history/` directory. Returns null if
 * there isn't enough data to form a stable estimate.
 */
export async function buildEtaProfile(
  historyDir: string,
  opts: { maxFiles?: number } = {},
): Promise<EtaProfile | null> {
  const maxFiles = opts.maxFiles ?? MAX_SAMPLE_FILES;
  const durations = await collectRecentDurations(historyDir, maxFiles);
  if (durations.length < MIN_SAMPLES) return null;
  return buildProfileFromDurations(durations);
}

/**
 * Cached variant for the WebSocket flow: same project's many tabs ask for
 * the same profile within minutes of each other, and rescanning 200 files
 * each time wastes I/O. Cache by historyDir with a TTL so that fresh
 * movements eventually feed back into the estimate.
 *
 * Falls back to BASELINE_ETA_PROFILE when the local history is too thin —
 * new installs still get a sensible "Composing · Xs / ~Ys" indicator from
 * prompt 1 instead of waiting for 30+ runs to accumulate.
 */
const PROFILE_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
const profileCache = new Map<string, { profile: EtaProfile | null; expiresAt: number; pending?: Promise<EtaProfile | null> }>();

export async function getEtaProfileCached(historyDir: string): Promise<EtaProfile | null> {
  const now = Date.now();
  const hit = profileCache.get(historyDir);
  if (hit && hit.expiresAt > now) return hit.profile ?? BASELINE_ETA_PROFILE;
  if (hit?.pending) return hit.pending;
  const pending = buildEtaProfile(historyDir).then(profile => {
    profileCache.set(historyDir, { profile, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS });
    return profile ?? BASELINE_ETA_PROFILE;
  }).catch(() => {
    profileCache.set(historyDir, { profile: null, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS });
    return BASELINE_ETA_PROFILE;
  });
  profileCache.set(historyDir, { profile: hit?.profile ?? null, expiresAt: hit?.expiresAt ?? 0, pending });
  return pending;
}

/** Test hook: clear the in-process cache. */
export function _clearEtaCache(): void { profileCache.clear(); }

/**
 * Baseline profile shipped in the package so a fresh install (no
 * `.mstro/history`) still gets a useful "typical" estimate from the very
 * first prompt. Numbers below were computed offline from the largest
 * available real-world history sample (mstro's own project, 379 movements
 * spanning short Q&A through multi-hour autonomous runs); they reflect a
 * heavy mix of chat, planning, and execution prompts. Once a project
 * accumulates >= MIN_SAMPLES local movements its own profile takes over.
 */
export const BASELINE_ETA_PROFILE: EtaProfile = {
  buckets: [
    { elapsedMs: 0,         p50TotalMs: 108_000,  p90TotalMs: 768_000,   n: 379 },
    { elapsedMs: 10_000,    p50TotalMs: 117_000,  p90TotalMs: 769_000,   n: 368 },
    { elapsedMs: 30_000,    p50TotalMs: 155_000,  p90TotalMs: 860_000,   n: 328 },
    { elapsedMs: 60_000,    p50TotalMs: 245_000,  p90TotalMs: 1_013_000, n: 252 },
    { elapsedMs: 120_000,   p50TotalMs: 392_000,  p90TotalMs: 1_171_000, n: 182 },
    { elapsedMs: 300_000,   p50TotalMs: 605_000,  p90TotalMs: 1_412_000, n: 116 },
    { elapsedMs: 600_000,   p50TotalMs: 945_000,  p90TotalMs: 1_679_000, n:  58 },
    { elapsedMs: 900_000,   p50TotalMs: 1_265_000, p90TotalMs: 1_845_000, n:  30 },
    { elapsedMs: 1_500_000, p50TotalMs: 1_728_000, p90TotalMs: 1_986_000, n:  10 },
  ],
  sampleSize: 379,
  computedAt: '2026-05-06T00:00:00.000Z',
};

/** Synchronously build a profile from an in-memory list of durationMs values. Exposed for tests. */
export function buildProfileFromDurations(durationsMs: number[]): EtaProfile {
  const cleaned = durationsMs
    .filter(d => Number.isFinite(d) && d >= SANITY_FLOOR_MS && d <= SANITY_CEILING_MS)
    .sort((a, b) => a - b);
  const buckets: EtaBucket[] = [];
  for (const elapsedMs of ELAPSED_CHECKPOINTS_MS) {
    const stillRunning = cleaned.filter(d => d > elapsedMs);
    if (stillRunning.length === 0) break;
    buckets.push({
      elapsedMs,
      p50TotalMs: quantile(stillRunning, 0.5),
      p90TotalMs: quantile(stillRunning, 0.9),
      n: stillRunning.length,
    });
  }
  return {
    buckets,
    sampleSize: cleaned.length,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Predict total duration given current elapsed ms. Returns null if the
 * profile has no usable buckets. The returned p50 is clamped to elapsed (so
 * the indicator never shows a typical that has already passed).
 */
export function predictEta(profile: EtaProfile, elapsedMs: number): EtaPrediction | null {
  if (profile.buckets.length === 0) return null;
  let bucket: EtaBucket = profile.buckets[0];
  for (const b of profile.buckets) {
    if (b.elapsedMs <= elapsedMs) bucket = b;
    else break;
  }
  // If elapsed has surpassed the last bucket's p50, the run is in the long
  // tail. Keep the last bucket's quantiles but never report a "typical" that
  // is shorter than elapsed itself — that would be nonsensical UX.
  const p50TotalMs = Math.max(bucket.p50TotalMs, elapsedMs);
  const p90TotalMs = Math.max(bucket.p90TotalMs, p50TotalMs);
  return { p50TotalMs, p90TotalMs, n: bucket.n };
}

// -- internals --

async function collectRecentDurations(historyDir: string, maxFiles: number): Promise<number[]> {
  let entries: string[];
  try {
    entries = (await fsp.readdir(historyDir)).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  if (entries.length === 0) return [];

  // Sort by mtime DESC for recency. statting up to N files is acceptable —
  // even a few thousand stats is sub-100ms on local disk.
  const stats = await Promise.all(
    entries.map(async name => {
      try {
        const full = join(historyDir, name);
        const s = await fsp.stat(full);
        return { full, mtime: s.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const ordered = stats
    .filter((x): x is { full: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, maxFiles);

  const durations: number[] = [];
  for (const { full } of ordered) {
    let raw: string;
    try { raw = await fsp.readFile(full, 'utf-8'); } catch { continue; }
    let data: SessionHistory;
    try { data = JSON.parse(raw) as SessionHistory; } catch { continue; }
    if (!Array.isArray(data.movements)) continue;
    for (const m of data.movements) {
      const d = m.durationMs;
      if (typeof d === 'number' && Number.isFinite(d)) durations.push(d);
    }
  }
  return durations;
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * q));
  return sortedAsc[idx];
}
