// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * IS-017: Bouncer classifier validation.
 *
 * Verifies that `validateBouncerClassifier` accepts every catalogued
 * (engine, model) pair and REJECTS anything else — most importantly,
 * frontier models that a crafted WebSocket payload could try to sneak in.
 * This is the server-side half of the eligibility guard; the client-side
 * half lives in `web/src/components/views/SettingsView/SecuritySection.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { BOUNCER_ELIGIBLE_MODELS, validateBouncerClassifier } from './settings.js';

describe('validateBouncerClassifier', () => {
  it('accepts every catalogued claude-code model', () => {
    for (const model of BOUNCER_ELIGIBLE_MODELS['claude-code']) {
      expect(validateBouncerClassifier({ engine: 'claude-code', model })).toEqual({
        engine: 'claude-code',
        model,
      });
    }
  });

  it('accepts every catalogued opencode model', () => {
    for (const model of BOUNCER_ELIGIBLE_MODELS.opencode) {
      expect(validateBouncerClassifier({ engine: 'opencode', model })).toEqual({
        engine: 'opencode',
        model,
      });
    }
  });

  it('rejects Opus for claude-code (frontier — would degrade the classifier)', () => {
    expect(() =>
      validateBouncerClassifier({ engine: 'claude-code', model: 'opus' }),
    ).toThrow(/not bouncer-eligible/);
  });

  it('rejects GPT-4o for opencode (frontier)', () => {
    expect(() =>
      validateBouncerClassifier({ engine: 'opencode', model: 'openai/gpt-4o' }),
    ).toThrow(/not bouncer-eligible/);
  });

  it('rejects cross-engine models (haiku on opencode, gpt-5-mini on claude-code)', () => {
    expect(() =>
      validateBouncerClassifier({ engine: 'opencode', model: 'haiku' }),
    ).toThrow(/not bouncer-eligible/);
    expect(() =>
      validateBouncerClassifier({ engine: 'claude-code', model: 'openai/gpt-5-mini' }),
    ).toThrow(/not bouncer-eligible/);
  });

  it('rejects unknown engine ids', () => {
    expect(() =>
      validateBouncerClassifier({ engine: 'nonsense', model: 'haiku' }),
    ).toThrow(/engine must be/);
  });

  it('rejects non-object payloads', () => {
    expect(() => validateBouncerClassifier(null)).toThrow(/must be an object/);
    expect(() => validateBouncerClassifier('haiku')).toThrow(/must be an object/);
    expect(() => validateBouncerClassifier(42)).toThrow(/must be an object/);
  });

  it('rejects empty / missing model', () => {
    expect(() =>
      validateBouncerClassifier({ engine: 'claude-code', model: '' }),
    ).toThrow(/non-empty string/);
    expect(() =>
      validateBouncerClassifier({ engine: 'claude-code' }),
    ).toThrow(/non-empty string/);
  });

  it('ignores extra junk fields on crafted payloads (only engine + model are used)', () => {
    // Simulate a crafted WebSocket payload with extra fields. The validator
    // returns a fresh object with only `engine` + `model` — anything else
    // the attacker added is dropped on the floor.
    const crafted = {
      engine: 'claude-code',
      model: 'haiku',
      extra: 'ignored',
      adminOverride: true,
    } as unknown;
    expect(validateBouncerClassifier(crafted)).toEqual({ engine: 'claude-code', model: 'haiku' });
  });
});
