import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _clearEtaCache, BASELINE_ETA_PROFILE, buildEtaProfile, buildProfileFromDurations, getEtaProfileCached, predictEta } from './eta-estimator.js';

describe('buildProfileFromDurations', () => {
  it('returns a profile with monotonic p50/p90 across buckets', () => {
    // Mix of short, medium, long durations
    const durations = [
      ...Array(50).fill(20_000),    // 20s
      ...Array(50).fill(60_000),    // 1m
      ...Array(50).fill(180_000),   // 3m
      ...Array(50).fill(600_000),   // 10m
      ...Array(20).fill(1_800_000), // 30m
    ];
    const p = buildProfileFromDurations(durations);
    expect(p.sampleSize).toBe(220);
    expect(p.buckets.length).toBeGreaterThan(0);
    expect(p.buckets[0].elapsedMs).toBe(0);
    // p50 is non-decreasing across buckets — once you've already waited longer,
    // the conditional p50 of total can only go up.
    for (let i = 1; i < p.buckets.length; i++) {
      expect(p.buckets[i].p50TotalMs).toBeGreaterThanOrEqual(p.buckets[i - 1].p50TotalMs);
    }
    // p90 >= p50 in every bucket
    for (const b of p.buckets) {
      expect(b.p90TotalMs).toBeGreaterThanOrEqual(b.p50TotalMs);
    }
  });

  it('drops sub-second outliers and >6h runaways', () => {
    const durations = [
      0, 100, 999,                       // dropped: too short
      ...Array(40).fill(60_000),         // 1m × 40 — kept
      8 * 60 * 60_000,                   // dropped: > 6h
    ];
    const p = buildProfileFromDurations(durations);
    expect(p.sampleSize).toBe(40);
  });

  it('first bucket reflects unconditional p50 of cleaned sample', () => {
    const durations = Array.from({ length: 100 }, (_, i) => (i + 1) * 1000); // 1s..100s
    const p = buildProfileFromDurations(durations);
    const bucket0 = p.buckets[0];
    expect(bucket0.elapsedMs).toBe(0);
    // Unconditional p50 of [1s..100s] is around 50s
    expect(bucket0.p50TotalMs).toBeGreaterThan(40_000);
    expect(bucket0.p50TotalMs).toBeLessThan(60_000);
  });

  it('returns empty buckets array for trivially small input', () => {
    const p = buildProfileFromDurations([]);
    expect(p.buckets).toHaveLength(0);
    expect(p.sampleSize).toBe(0);
  });
});

describe('predictEta', () => {
  const baseDurations = [
    ...Array(80).fill(30_000),    // 30s
    ...Array(60).fill(120_000),   // 2m
    ...Array(40).fill(300_000),   // 5m
    ...Array(20).fill(1_200_000), // 20m
  ];
  const profile = buildProfileFromDurations(baseDurations);

  it('returns null when profile has no buckets', () => {
    expect(predictEta({ buckets: [], sampleSize: 0, computedAt: '' }, 5_000)).toBeNull();
  });

  it('uses the bucket whose elapsedMs is the largest <= elapsed', () => {
    const at0 = predictEta(profile, 0);
    const at1m = predictEta(profile, 60_000);
    const at5m = predictEta(profile, 300_000);
    expect(at0).not.toBeNull();
    expect(at1m).not.toBeNull();
    expect(at5m).not.toBeNull();
    // Conditional p50 grows as elapsed grows
    expect(at1m!.p50TotalMs).toBeGreaterThanOrEqual(at0!.p50TotalMs);
    expect(at5m!.p50TotalMs).toBeGreaterThanOrEqual(at1m!.p50TotalMs);
  });

  it('clamps p50 so it is never less than elapsed', () => {
    // After running for 30 minutes — past every bucket's p50 — the predictor
    // must still report a "typical" >= 30m, not something already past.
    const at30m = predictEta(profile, 30 * 60_000);
    expect(at30m).not.toBeNull();
    expect(at30m!.p50TotalMs).toBeGreaterThanOrEqual(30 * 60_000);
    expect(at30m!.p90TotalMs).toBeGreaterThanOrEqual(at30m!.p50TotalMs);
  });

  it('past the last bucket, returns last-bucket quantiles (with elapsed clamp)', () => {
    const last = profile.buckets[profile.buckets.length - 1];
    // Pick an elapsed huge enough to be past the last bucket but within p50 of last
    const elapsed = last.elapsedMs + 1;
    const pred = predictEta(profile, elapsed);
    expect(pred!.p50TotalMs).toBe(Math.max(last.p50TotalMs, elapsed));
  });
});

describe('buildEtaProfile (integration with disk)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'eta-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function writeSession(filename: string, durations: number[]) {
    const movements = durations.map((d, i) => ({
      id: `prompt-${i + 1}`,
      sequenceNumber: i + 1,
      userPrompt: 'x',
      timestamp: new Date().toISOString(),
      tokensUsed: 0,
      summary: '',
      filesModified: [],
      durationMs: d,
    }));
    const session = {
      sessionId: filename.replace('.json', ''),
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      totalTokens: 0,
      movements,
    };
    await writeFile(join(dir, filename), JSON.stringify(session));
  }

  it('returns null when there are not enough samples', async () => {
    await writeSession('a.json', [60_000, 120_000]); // only 2 movements
    const p = await buildEtaProfile(dir);
    expect(p).toBeNull();
  });

  it('returns null when the directory does not exist', async () => {
    const p = await buildEtaProfile(join(dir, 'missing'));
    expect(p).toBeNull();
  });

  it('skips malformed JSON files without throwing', async () => {
    await writeFile(join(dir, 'bad.json'), '{not json');
    // Plus enough good data to pass MIN_SAMPLES
    const goods = Array.from({ length: 50 }, () => 60_000);
    await writeSession('good.json', goods);
    const p = await buildEtaProfile(dir);
    expect(p).not.toBeNull();
    expect(p!.sampleSize).toBe(50);
  });

  it('builds a usable profile from a realistic mix', async () => {
    const fast = Array.from({ length: 40 }, () => 20_000);
    const med = Array.from({ length: 30 }, () => 180_000);
    const slow = Array.from({ length: 10 }, () => 900_000);
    await writeSession('fast.json', fast);
    await writeSession('med.json', med);
    await writeSession('slow.json', slow);
    const p = await buildEtaProfile(dir);
    expect(p).not.toBeNull();
    expect(p!.sampleSize).toBe(80);
    expect(p!.buckets[0].elapsedMs).toBe(0);
    const at0 = predictEta(p!, 0);
    const at1m = predictEta(p!, 60_000);
    expect(at0!.p50TotalMs).toBeGreaterThan(0);
    expect(at1m!.p50TotalMs).toBeGreaterThanOrEqual(at0!.p50TotalMs);
  });
});

describe('BASELINE_ETA_PROFILE', () => {
  it('is structurally valid (monotonic p50, p90 >= p50)', () => {
    expect(BASELINE_ETA_PROFILE.buckets.length).toBeGreaterThan(0);
    expect(BASELINE_ETA_PROFILE.buckets[0].elapsedMs).toBe(0);
    for (let i = 1; i < BASELINE_ETA_PROFILE.buckets.length; i++) {
      expect(BASELINE_ETA_PROFILE.buckets[i].p50TotalMs).toBeGreaterThanOrEqual(BASELINE_ETA_PROFILE.buckets[i - 1].p50TotalMs);
    }
    for (const b of BASELINE_ETA_PROFILE.buckets) {
      expect(b.p90TotalMs).toBeGreaterThanOrEqual(b.p50TotalMs);
    }
  });

  it('produces a reasonable cold-start estimate (a few minutes)', () => {
    const at0 = predictEta(BASELINE_ETA_PROFILE, 0);
    expect(at0).not.toBeNull();
    // Sanity: typical first-prompt should be in the seconds-to-minutes range,
    // not seconds (would mean profile is broken) and not hours (also broken).
    expect(at0!.p50TotalMs).toBeGreaterThan(30_000);
    expect(at0!.p50TotalMs).toBeLessThan(30 * 60_000);
  });
});

describe('getEtaProfileCached', () => {
  let dir: string;
  beforeEach(async () => {
    _clearEtaCache();
    dir = await mkdtemp(join(tmpdir(), 'eta-cache-'));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function writeSession(filename: string, durations: number[]) {
    const movements = durations.map((d, i) => ({
      id: `prompt-${i + 1}`,
      sequenceNumber: i + 1,
      userPrompt: 'x',
      timestamp: new Date().toISOString(),
      tokensUsed: 0,
      summary: '',
      filesModified: [],
      durationMs: d,
    }));
    const session = {
      sessionId: filename.replace('.json', ''),
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      totalTokens: 0,
      movements,
    };
    await writeFile(join(dir, filename), JSON.stringify(session));
  }

  it('returns the baseline profile when local history is too thin', async () => {
    // < MIN_SAMPLES (30) movements — buildEtaProfile returns null;
    // the cache wrapper substitutes the baseline.
    await writeSession('a.json', [60_000, 120_000]);
    const p = await getEtaProfileCached(dir);
    expect(p).toBe(BASELINE_ETA_PROFILE);
  });

  it('returns the baseline profile when the directory does not exist', async () => {
    const p = await getEtaProfileCached(join(dir, 'nonexistent'));
    expect(p).toBe(BASELINE_ETA_PROFILE);
  });

  it('returns a real profile (not baseline) once enough local samples exist', async () => {
    const lots = Array.from({ length: 50 }, () => 60_000);
    await writeSession('lots.json', lots);
    const p = await getEtaProfileCached(dir);
    expect(p).not.toBe(BASELINE_ETA_PROFILE);
    expect(p!.sampleSize).toBe(50);
  });
});
