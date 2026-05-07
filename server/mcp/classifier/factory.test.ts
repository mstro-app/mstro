// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * IS-013: classifier factory + settings schema + eligibility validation.
 *
 * Exercises the `getClassifier()` production entry point against the four
 * acceptance-criteria cases:
 *
 *   1. Valid config -> correct classifier instance (Claude for claude-code,
 *      OpenCode for opencode).
 *   2. Missing config -> Claude+Haiku fallback, warning logged.
 *   3. Non-eligible model -> Claude+Haiku fallback, warning logged.
 *   4. Unknown engine -> Claude+Haiku fallback, warning logged.
 *
 * Settings are mocked so no real `~/.mstro/settings.json` is read or
 * written, and the OpenCode server manager is replaced with a stub so we
 * never spawn `opencode serve` during unit tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenCodeServerManager } from '../../engines/opencode/OpenCodeServerManager.js';
import type { BouncerClassifierConfig } from '../../services/settings.js';

// ---------- settings mock ----------
//
// `getBouncerClassifier` is the only settings API the factory touches for
// the config read path. `isEngineSwapEnabled` is also read by
// `createBouncerClassifier`; the getClassifier() path doesn't hit it, but
// we stub it so the factory module imports cleanly without touching the
// env or disk. `BOUNCER_ELIGIBLE_MODELS` and `DEFAULT_BOUNCER_CLASSIFIER`
// are re-exported from the real module so eligibility semantics match
// production exactly.
//
// `vi.hoisted` is required because `vi.mock` is itself hoisted to the top
// of the file — referring to a plain `const` declared below the mock
// would hit the temporal dead zone.
const hoisted = vi.hoisted(() => ({
  mockGetBouncerClassifier: vi.fn(),
}));
const { mockGetBouncerClassifier } = hoisted;

vi.mock('../../services/settings.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../services/settings.js')>();
  return {
    ...orig,
    getBouncerClassifier: hoisted.mockGetBouncerClassifier,
    isEngineSwapEnabled: vi.fn(() => true),
  };
});

import { ClaudeBouncerClassifier } from './ClaudeBouncerClassifier.js';
import {
  __setOpenCodeManagerFactoryForTests,
  createClassifierForConfig,
  getClassifier,
} from './factory.js';
import { OpenCodeBouncerClassifier } from './OpenCodeBouncerClassifier.js';

// ---------- opencode manager stub ----------

/**
 * Stand-in for OpenCodeServerManager. Construction is side-effect-free and
 * the classifier only stores the reference at construction time — so a
 * minimal shaped object suffices. Cast through `unknown` to satisfy the
 * structural check without dragging in the SDK's internal types.
 */
function makeFakeManager(): OpenCodeServerManager {
  return {
    start: vi.fn(async () => undefined),
    getClient: vi.fn(),
    shutdown: vi.fn(async () => undefined),
  } as unknown as OpenCodeServerManager;
}

let fakeManager: OpenCodeServerManager;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fakeManager = makeFakeManager();
  __setOpenCodeManagerFactoryForTests(() => fakeManager);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  __setOpenCodeManagerFactoryForTests(null);
  warnSpy.mockRestore();
  mockGetBouncerClassifier.mockReset();
});

// ---------- getClassifier: valid config ----------

describe('getClassifier — valid config', () => {
  it('returns ClaudeBouncerClassifier for { engine: "claude-code", model: "haiku" }', () => {
    mockGetBouncerClassifier.mockReturnValue({
      engine: 'claude-code',
      model: 'haiku',
    });

    const classifier = getClassifier();

    expect(classifier).toBeInstanceOf(ClaudeBouncerClassifier);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns ClaudeBouncerClassifier for claude-code + sonnet (also eligible)', () => {
    mockGetBouncerClassifier.mockReturnValue({
      engine: 'claude-code',
      model: 'sonnet',
    });

    const classifier = getClassifier();

    expect(classifier).toBeInstanceOf(ClaudeBouncerClassifier);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns OpenCodeBouncerClassifier for an eligible opencode model', () => {
    mockGetBouncerClassifier.mockReturnValue({
      engine: 'opencode',
      model: 'openai/gpt-5-mini',
    });

    const classifier = getClassifier();

    expect(classifier).toBeInstanceOf(OpenCodeBouncerClassifier);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ---------- getClassifier: missing config ----------

describe('getClassifier — missing config', () => {
  it('falls back to Claude+Haiku when settings return the default (simulating no user override)', () => {
    // `getBouncerClassifier()` always returns *something* (the default when
    // nothing is persisted), so "missing" in the production sense means
    // the default is returned — the factory should still build a Claude
    // classifier without logging a warning.
    mockGetBouncerClassifier.mockReturnValue({
      engine: 'claude-code',
      model: 'haiku',
    });

    const classifier = getClassifier();

    expect(classifier).toBeInstanceOf(ClaudeBouncerClassifier);
  });

  it('falls back to Claude+Haiku when settings read throws (corrupted file)', () => {
    mockGetBouncerClassifier.mockImplementation(() => {
      throw new Error('settings.json is corrupt');
    });

    const classifier = getClassifier();

    expect(classifier).toBeInstanceOf(ClaudeBouncerClassifier);
    expect(warnSpy).toHaveBeenCalled();
    const message = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/falling back to Claude\+Haiku/i);
    expect(message).toMatch(/settings\.json is corrupt/i);
  });
});

// ---------- getClassifier: non-eligible model ----------

describe('getClassifier — non-eligible model rejection', () => {
  it('falls back to Claude+Haiku when the stored model is not bouncer-eligible (e.g. Opus)', () => {
    // Simulate a config that slipped past the normal guards (e.g. hand-edit
    // of settings.json bypassing `getBouncerClassifier`'s validator).
    mockGetBouncerClassifier.mockReturnValue({
      engine: 'claude-code',
      // Opus is the textbook "too slow/expensive" classifier model the
      // eligibility list exists to block.
      model: 'opus' as unknown as string,
    });

    const classifier = getClassifier();

    expect(classifier).toBeInstanceOf(ClaudeBouncerClassifier);
    expect(warnSpy).toHaveBeenCalled();
    const message = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/falling back to Claude\+Haiku/i);
    expect(message).toMatch(/not bouncer-eligible/i);
  });

  it('throws from createClassifierForConfig when given a non-eligible model directly', () => {
    expect(() =>
      createClassifierForConfig({
        engine: 'claude-code',
        model: 'opus',
      } as BouncerClassifierConfig),
    ).toThrow(/not bouncer-eligible/i);
  });

  it('falls back to Claude+Haiku when the opencode model is not eligible (e.g. gpt-4o)', () => {
    mockGetBouncerClassifier.mockReturnValue({
      engine: 'opencode',
      model: 'openai/gpt-4o',
    });

    const classifier = getClassifier();

    expect(classifier).toBeInstanceOf(ClaudeBouncerClassifier);
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ---------- getClassifier: unknown engine ----------

describe('getClassifier — unknown engine', () => {
  it('falls back to Claude+Haiku when the engine id is unrecognized', () => {
    mockGetBouncerClassifier.mockReturnValue({
      // A value outside the EngineId union — simulates a future engine
      // that was written into settings.json but isn't compiled into this
      // build.
      engine: 'gemini-cli' as unknown as BouncerClassifierConfig['engine'],
      model: 'gemini-2.5-flash',
    });

    const classifier = getClassifier();

    expect(classifier).toBeInstanceOf(ClaudeBouncerClassifier);
    expect(warnSpy).toHaveBeenCalled();
    const message = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/falling back to Claude\+Haiku/i);
  });

  it('throws from createClassifierForConfig when engine is unknown', () => {
    expect(() =>
      createClassifierForConfig({
        engine: 'gemini-cli' as unknown as BouncerClassifierConfig['engine'],
        model: 'gemini-2.5-flash',
      }),
    ).toThrow(/not bouncer-eligible/i);
  });
});
