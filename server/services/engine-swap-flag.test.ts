// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * IS-020: engineSwap feature-flag gating.
 *
 * Asserts that flipping the flag toggles the two factories (`createEngine`
 * and `createBouncerClassifier`) and nothing else — specifically, that
 * OpenCode types are NEVER constructed when the flag is off, even if the
 * caller explicitly asks for `'opencode'`. That guarantees no `opencode
 * serve` subprocess is spawned while the flag is off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub persistent settings reads so we don't touch `~/.mstro/settings.json`
// and so each test gets a clean slate.
vi.mock('./settings.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./settings.js')>();
  return {
    ...orig,
    getSettings: vi.fn(() => ({ model: 'opus', effortLevel: 'auto' })),
  };
});

import { ClaudeCodeEngine } from '../engines/claude/ClaudeCodeEngine.js';
import {
  __resetSharedOpenCodeServerManagerForTests,
  createEngine,
} from '../engines/factory.js';
import { ClaudeBouncerClassifier } from '../mcp/classifier/ClaudeBouncerClassifier.js';
import { createBouncerClassifier } from '../mcp/classifier/factory.js';
import { isEngineSwapEnabled } from './settings.js';

/**
 * Isolate each test from the ambient environment — tests should be the
 * single authority over `MSTRO_ENABLE_ENGINE_SWAP` and `NODE_ENV` for the
 * flag resolver, and the shared OpenCode manager should not carry state
 * across cases.
 */
const originalEnv = process.env.MSTRO_ENABLE_ENGINE_SWAP;
const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  delete process.env.MSTRO_ENABLE_ENGINE_SWAP;
  process.env.NODE_ENV = 'test';
  __resetSharedOpenCodeServerManagerForTests();
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.MSTRO_ENABLE_ENGINE_SWAP;
  } else {
    process.env.MSTRO_ENABLE_ENGINE_SWAP = originalEnv;
  }
  process.env.NODE_ENV = originalNodeEnv;
});

describe('isEngineSwapEnabled — resolution precedence', () => {
  it('env var true overrides everything else', () => {
    process.env.MSTRO_ENABLE_ENGINE_SWAP = 'true';
    process.env.NODE_ENV = 'production';
    expect(isEngineSwapEnabled()).toBe(true);
  });

  it('env var false overrides everything else', () => {
    process.env.MSTRO_ENABLE_ENGINE_SWAP = 'false';
    process.env.NODE_ENV = 'development';
    expect(isEngineSwapEnabled()).toBe(false);
  });

  it('NODE_ENV=production defaults the flag off when nothing is set', () => {
    process.env.NODE_ENV = 'production';
    expect(isEngineSwapEnabled()).toBe(false);
  });

  it('NODE_ENV=development defaults the flag on when nothing is set', () => {
    process.env.NODE_ENV = 'development';
    expect(isEngineSwapEnabled()).toBe(true);
  });
});

describe('createEngine — gated on engineSwap', () => {
  it('returns ClaudeCodeEngine when flag is off, even if opencode is requested', () => {
    process.env.MSTRO_ENABLE_ENGINE_SWAP = 'false';
    const claudeEngine = createEngine('claude-code');
    const openCodeEngine = createEngine('opencode');
    // Both branches collapse to ClaudeCodeEngine — critically,
    // LazyOpenCodeEngine is never constructed, so OpenCodeServerManager
    // (the thing that spawns `opencode serve`) stays untouched.
    expect(claudeEngine).toBeInstanceOf(ClaudeCodeEngine);
    expect(openCodeEngine).toBeInstanceOf(ClaudeCodeEngine);
    expect(openCodeEngine.engineId).toBe('claude-code');
  });

  it('returns a LazyOpenCodeEngine when flag is on and opencode is requested', () => {
    process.env.MSTRO_ENABLE_ENGINE_SWAP = 'true';
    const engine = createEngine('opencode');
    // Construction must remain side-effect-free — the LazyOpenCodeEngine
    // defers server spawn until startSession, which these tests never call.
    expect(engine.engineId).toBe('opencode');
    expect(engine).not.toBeInstanceOf(ClaudeCodeEngine);
  });

  it('toggling the flag at runtime affects the next createEngine call', () => {
    process.env.MSTRO_ENABLE_ENGINE_SWAP = 'true';
    expect(createEngine('opencode').engineId).toBe('opencode');

    process.env.MSTRO_ENABLE_ENGINE_SWAP = 'false';
    expect(createEngine('opencode').engineId).toBe('claude-code');
  });
});

describe('createBouncerClassifier — gated on engineSwap', () => {
  it('returns ClaudeBouncerClassifier when flag is off regardless of engineId', () => {
    process.env.MSTRO_ENABLE_ENGINE_SWAP = 'false';
    const defaulted = createBouncerClassifier();
    const openCodeAttempt = createBouncerClassifier({ engineId: 'opencode' });
    expect(defaulted).toBeInstanceOf(ClaudeBouncerClassifier);
    expect(openCodeAttempt).toBeInstanceOf(ClaudeBouncerClassifier);
  });

  it('returns ClaudeBouncerClassifier when flag is on and claude-code is requested', () => {
    process.env.MSTRO_ENABLE_ENGINE_SWAP = 'true';
    const classifier = createBouncerClassifier({ engineId: 'claude-code' });
    expect(classifier).toBeInstanceOf(ClaudeBouncerClassifier);
  });

  it('rejects opencode classifier when flag is on (Epic 4 not yet shipped)', () => {
    process.env.MSTRO_ENABLE_ENGINE_SWAP = 'true';
    expect(() => createBouncerClassifier({ engineId: 'opencode' })).toThrow(
      /OpenCode bouncer classifier is not implemented/,
    );
  });
});
