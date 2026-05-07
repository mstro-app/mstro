// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Bouncer classifier factory.
 *
 * Two entry points:
 *
 * - `getClassifier()` — production path. Reads
 *   `settings.bouncerClassifier: { engine, model }` and returns the
 *   matching `BouncerClassifier` instance. If the persisted config is
 *   missing, malformed, or names a non-eligible model, it logs a clear
 *   warning and falls back to `ClaudeBouncerClassifier` + Haiku — the
 *   Bouncer must always have a classifier to call, so "no config" and
 *   "bad config" both collapse to the known-safe default rather than
 *   throwing.
 *
 * - `createBouncerClassifier(options?)` — direct-construction helper used
 *   by the engineSwap feature-flag gate (see `engine-swap-flag.test.ts`).
 *   Accepts an explicit `engineId` and is deliberately feature-flag-aware:
 *   when `engineSwap` is disabled, the flag short-circuits to Claude.
 *
 * New callers should prefer `getClassifier()` so the user-selected model
 * takes effect without plumbing. The bouncer-integration layer constructs
 * its default classifier lazily so env var changes and settings edits
 * propagate on the next classification call.
 */

import { OpenCodeServerManager } from '../../engines/opencode/OpenCodeServerManager.js';
import type { EngineId } from '../../engines/types.js';
import {
  BOUNCER_ELIGIBLE_MODELS,
  type BouncerClassifierConfig,
  DEFAULT_BOUNCER_CLASSIFIER,
  getBouncerClassifier,
  isEngineSwapEnabled,
} from '../../services/settings.js';
import type { BouncerClassifier } from './BouncerClassifier.js';
import { ClaudeBouncerClassifier } from './ClaudeBouncerClassifier.js';
import { OpenCodeBouncerClassifier } from './OpenCodeBouncerClassifier.js';

/** Options accepted by every classifier implementation. */
export interface ClassifierFactoryOptions {
  /**
   * Which engine backs the classifier. With `engineSwap` off this is
   * ignored and `'claude-code'` is used; with the flag on, non-Claude
   * engines throw until their implementations land (Epic 4).
   */
  engineId?: EngineId;
}

/**
 * Construct the Layer-2 Bouncer classifier by engine id (no settings
 * lookup). Exists for the `engineSwap` feature-flag gate, which asserts
 * that the factory is flag-aware in both on/off states. New production
 * callers should route through {@link getClassifier} instead.
 */
export function createBouncerClassifier(
  options: ClassifierFactoryOptions = {},
): BouncerClassifier {
  if (!isEngineSwapEnabled()) {
    return new ClaudeBouncerClassifier();
  }
  const engineId = options.engineId ?? 'claude-code';
  switch (engineId) {
    case 'claude-code':
      return new ClaudeBouncerClassifier();
    case 'opencode':
      // Wired through `getClassifier()` (settings path). Direct engine-id
      // construction stays intentionally narrow — callers that want the
      // OpenCode classifier should pick it via the Settings UI so the
      // shared `OpenCodeServerManager` is available.
      throw new Error(
        'OpenCode bouncer classifier is not implemented yet (Epic 4). ' +
          'Keep engineSwap off until the OpenCode classifier ships.',
      );
    default: {
      const exhaustive: never = engineId;
      throw new Error(`Unknown classifier engine id: ${String(exhaustive)}`);
    }
  }
}

/**
 * Process-lifetime singleton for the `opencode serve` subprocess used by
 * the classifier. Deliberately separate from the engines-side manager so
 * tests can inject a mock client without touching the engine factory.
 * Lazy: never created until an OpenCode classifier is first requested.
 */
let sharedOpenCodeManager: OpenCodeServerManager | null = null;
let openCodeManagerFactory: () => OpenCodeServerManager = () =>
  new OpenCodeServerManager({ registerProcessHandlers: true });

function getSharedOpenCodeServerManager(): OpenCodeServerManager {
  if (!sharedOpenCodeManager) {
    sharedOpenCodeManager = openCodeManagerFactory();
  }
  return sharedOpenCodeManager;
}

/**
 * Override the OpenCode manager used by the classifier factory. Test-only;
 * production code never calls this. Pass `null` to reset to the default.
 */
export function __setOpenCodeManagerFactoryForTests(
  factory: (() => OpenCodeServerManager) | null,
): void {
  sharedOpenCodeManager = null;
  openCodeManagerFactory = factory
    ?? (() => new OpenCodeServerManager({ registerProcessHandlers: true }));
}

/**
 * Log a fallback reason in a single place so grep + log analysis surface
 * every path where we silently dropped back to Claude+Haiku. Goes to
 * stderr (matching the rest of the Bouncer logs) so it shows up in the
 * CLI's `--trace` output and in audit transcripts.
 */
function logFallback(reason: string): void {
  console.warn(
    `[Bouncer] Classifier config invalid, falling back to Claude+Haiku: ${reason}`,
  );
}

/**
 * Construct a `BouncerClassifier` for the provided config. Throws on bad
 * config — callers that need fallback semantics should use
 * {@link getClassifier} instead.
 */
export function createClassifierForConfig(
  config: BouncerClassifierConfig,
): BouncerClassifier {
  const eligible = BOUNCER_ELIGIBLE_MODELS[config.engine];
  if (!eligible || !eligible.includes(config.model)) {
    throw new Error(
      `Model '${config.model}' is not bouncer-eligible for engine '${config.engine}'`,
    );
  }
  switch (config.engine) {
    case 'claude-code':
      // The Claude classifier currently hardcodes `--model haiku` in the
      // subprocess call. Passing `sonnet` still returns Haiku until a
      // later issue threads the model through — the eligibility check
      // guards correctness; the subprocess args are a follow-up.
      return new ClaudeBouncerClassifier();
    case 'opencode':
      return new OpenCodeBouncerClassifier({
        manager: getSharedOpenCodeServerManager(),
        model: config.model,
      });
    default: {
      const exhaustive: never = config.engine;
      throw new Error(`Unknown classifier engine id: ${String(exhaustive)}`);
    }
  }
}

/**
 * Production classifier accessor. Reads the user's current Bouncer
 * classifier choice from persistent settings and returns a fresh
 * `BouncerClassifier` instance. Invalid or missing config logs a clear
 * warning and falls back to the default Claude+Haiku classifier — the
 * Bouncer is a required security layer, so "no classifier available" is
 * never an acceptable outcome.
 *
 * Called on every `reviewOperation()` path (indirectly via the
 * integration layer's lazy default); cheap because classifier
 * construction is synchronous and does not spawn subprocesses until the
 * first `classify()` call.
 */
export function getClassifier(): BouncerClassifier {
  let config: BouncerClassifierConfig;
  try {
    config = getBouncerClassifier();
  } catch (err) {
    logFallback(err instanceof Error ? err.message : String(err));
    return new ClaudeBouncerClassifier();
  }

  try {
    return createClassifierForConfig(config);
  } catch (err) {
    logFallback(err instanceof Error ? err.message : String(err));
    // Last-resort fallback — if even the default config can't build the
    // classifier (e.g. OpenCode catalogue edit broke the model list), we
    // still return Claude+Haiku so the Bouncer keeps functioning.
    if (
      config.engine === DEFAULT_BOUNCER_CLASSIFIER.engine &&
      config.model === DEFAULT_BOUNCER_CLASSIFIER.model
    ) {
      return new ClaudeBouncerClassifier();
    }
    return new ClaudeBouncerClassifier();
  }
}
