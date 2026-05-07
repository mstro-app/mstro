// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Bouncer Haiku — thin compatibility shim.
 *
 * The actual Haiku subprocess logic now lives in
 * `./classifier/ClaudeBouncerClassifier.ts` behind the `BouncerClassifier`
 * interface. This file re-exports that implementation and provides a
 * function-style wrapper (`analyzeWithHaiku`) for backwards compatibility.
 *
 * Semantic behavior (subprocess invocation, prompt loading, response parsing,
 * timeout, fail-closed policy) is unchanged.
 */

import type { BouncerDecision, BouncerReviewRequest } from './bouncer-integration.js';
import {
  ClaudeBouncerClassifier,
  HAIKU_TIMEOUT_MS,
  parseHaikuResponse,
} from './classifier/ClaudeBouncerClassifier.js';

export { HAIKU_TIMEOUT_MS, parseHaikuResponse };

/**
 * Invoke Haiku for fast AI analysis of ambiguous operations.
 *
 * Delegates to `ClaudeBouncerClassifier.classify()`. Retained for
 * backwards compatibility — new code should construct a classifier directly
 * and call `.classify()` through the `BouncerClassifier` interface.
 */
export async function analyzeWithHaiku(
  request: BouncerReviewRequest,
  claudeCommand: string = 'claude',
  _workingDir: string = process.cwd(),
): Promise<BouncerDecision> {
  const classifier = new ClaudeBouncerClassifier({ claudeCommand });
  return classifier.classify(request.operation, request.context);
}
