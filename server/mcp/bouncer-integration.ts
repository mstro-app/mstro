// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Bouncer Integration V2 - Prompt Injection Protection
 *
 * PHILOSOPHY: Protect against BAD ACTORS, not dangerous commands.
 * The user is driving Claude - assume operations are user-requested.
 * Only block when it looks like a malicious injection attack.
 *
 * ARCHITECTURE:
 * ┌─────────────────────────────────────────────────────────────┐
 * │ LAYER 1: Pattern-Based Fast Path (< 5ms)                  │
 * │ - Known-safe operations → immediate ALLOW                  │
 * │ - Catastrophic commands (rm -rf /, fork bombs) → DENY      │
 * ├─────────────────────────────────────────────────────────────┤
 * │ LAYER 2: Haiku AI Analysis (bouncer-haiku.ts)             │
 * │ - Asks: "Does this look like injection or user request?"   │
 * │ - Defaults to ALLOW - user is actively working with Claude │
 * └─────────────────────────────────────────────────────────────┘
 *
 * SECURITY BOUNDARY: Layer 1 is a performance optimization, NOT a
 * security boundary. Haiku (Layer 2) is the security boundary.
 * Layer 1 patterns are public (open-source repo) and should be
 * treated as a fast-path filter only. Never expand SAFE_OPERATIONS
 * to include operations with side effects beyond the user's
 * working directory.
 *
 * Haiku AI analysis lives in bouncer-haiku.ts.
 * Pattern definitions live in security-patterns.ts.
 * Analysis logic lives in security-analysis.ts.
 */

import { AnalyticsEvents, trackEvent } from '../services/analytics.js';
import { captureException } from '../services/sentry.js';
import { analyzeWithHaiku, HAIKU_TIMEOUT_MS } from './bouncer-haiku.js';
import {
  CRITICAL_THREATS,
  matchesPattern,
  normalizeOperation,
  requiresAIReview,
  SAFE_OPERATIONS
} from './security-patterns.js';

// ── Types ─────────────────────────────────────────────────────

export interface BouncerReviewRequest {
  operation: string;
  context?: {
    purpose?: string;
    workingDirectory?: string;
    affectedFiles?: string[];
    alternatives?: string;
    userRequest?: string;
    conversationHistory?: string[];
    sessionId?: string;
    [key: string]: unknown;
  };
}

export interface BouncerDecision {
  decision: 'allow' | 'deny' | 'warn_allow';
  confidence: number;
  reasoning: string;
  threatLevel?: 'low' | 'medium' | 'high' | 'critical';
  alternative?: string;
  suggestedCommand?: string;
  enforceable?: boolean;
}

// ── Decision Cache ────────────────────────────────────────────

const CACHE_TTL_MS = parseInt(process.env.BOUNCER_CACHE_TTL_MS || '300000', 10);
const CACHE_MAX_SIZE = 200;

interface CachedDecision {
  decision: BouncerDecision;
  expiresAt: number;
}

const decisionCache = new Map<string, CachedDecision>();

function buildCacheKey(operation: string, context?: BouncerReviewRequest['context']): string {
  const sessionId = context?.sessionId ?? '_';
  return `${sessionId}:${operation}`;
}

function getCachedDecision(operation: string, context?: BouncerReviewRequest['context']): BouncerDecision | null {
  const key = buildCacheKey(operation, context);
  const entry = decisionCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    decisionCache.delete(key);
    return null;
  }
  return entry.decision;
}

/** Clear the decision cache. Exposed for testing. */
export function clearDecisionCache(): void {
  decisionCache.clear();
}

function cacheDecision(operation: string, context: BouncerReviewRequest['context'] | undefined, decision: BouncerDecision): void {
  if (decision.confidence < 50) return;
  if (decisionCache.size >= CACHE_MAX_SIZE) {
    const firstKey = decisionCache.keys().next().value;
    if (firstKey !== undefined) decisionCache.delete(firstKey);
  }
  const key = buildCacheKey(operation, context);
  decisionCache.set(key, { decision, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Decision Finalization ─────────────────────────────────────

function finalizeDecision(
  operation: string,
  decision: BouncerDecision,
  layer: string,
  startTime: number,
  context: BouncerReviewRequest['context'],
  logFn: typeof import('./security-audit.js')['logBouncerDecision'],
  opts?: { error?: string; skipCache?: boolean; skipAnalytics?: boolean; skipLog?: boolean },
): BouncerDecision {
  const latencyMs = Math.round(performance.now() - startTime);

  if (!opts?.skipLog) {
    logFn(operation, decision.decision, decision.confidence, decision.reasoning, {
      context, threatLevel: decision.threatLevel, layer, latencyMs, ...(opts?.error && { error: opts.error }),
    });
  }

  if (!opts?.skipAnalytics) {
    const event = decision.decision === 'deny' ? AnalyticsEvents.BOUNCER_TOOL_DENIED : AnalyticsEvents.BOUNCER_TOOL_ALLOWED;
    trackEvent(event, {
      layer,
      operation_length: operation.length,
      threat_level: decision.threatLevel,
      confidence: decision.confidence,
      latency_ms: latencyMs,
    });
  }

  if (!opts?.skipCache) cacheDecision(operation, context, decision);
  return decision;
}

// ── Haiku Error Handling ──────────────────────────────────────

function handleHaikuError(
  error: unknown,
  operation: string,
  attempt: number,
  maxAttempts: number,
  fin: (d: BouncerDecision, layer: string, opts?: Parameters<typeof finalizeDecision>[6]) => BouncerDecision,
): BouncerDecision | null {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const isTimeout = errorMessage.includes('timed out');

  if (isTimeout && attempt < maxAttempts) {
    console.error(`[Bouncer] ⚠️  Haiku timed out (attempt ${attempt}/${maxAttempts}), retrying...`);
    captureException(error, { context: 'bouncer.haiku_timeout_retry', operation, attempt });
    return null;
  }

  if (isTimeout) {
    console.error(`[Bouncer] 🚫 Haiku timed out after ${maxAttempts} attempts — DENYING for safety`);
    captureException(error, { context: 'bouncer.haiku_timeout', operation });
    return fin({ decision: 'deny', confidence: 0, reasoning: `Security analysis timed out after ${maxAttempts} attempts (${HAIKU_TIMEOUT_MS}ms each). Denying for safety — operation could not be verified.`, threatLevel: 'critical' }, 'haiku-timeout', { skipCache: true });
  }

  console.error(`[Bouncer] ⚠️  Haiku analysis failed: ${errorMessage}`);
  captureException(error, { context: 'bouncer.haiku_analysis', operation });
  return fin({ decision: 'deny', confidence: 0, reasoning: `Security analysis failed: ${errorMessage}. Denying for safety.`, threatLevel: 'critical' }, 'ai-error', { skipCache: true, skipAnalytics: true, error: errorMessage });
}

// ── Layer 2: Haiku AI Analysis ────────────────────────────────

async function runHaikuAnalysis(
  request: BouncerReviewRequest,
  operation: string,
  startTime: number,
  fin: (d: BouncerDecision, layer: string, opts?: Parameters<typeof finalizeDecision>[6]) => BouncerDecision,
): Promise<BouncerDecision> {
  const aiDisabledByEnv = process.env.BOUNCER_USE_AI === 'false';
  if (aiDisabledByEnv || request.context?._skipAI === true) {
    console.error('[Bouncer] AI analysis disabled');
    return fin({ decision: 'warn_allow', confidence: 60, reasoning: 'Operation requires review but AI analysis is disabled. Proceeding with caution.', threatLevel: 'medium' }, 'ai-disabled', { skipCache: true, skipAnalytics: true });
  }

  console.error('[Bouncer] 🤖 Invoking Haiku for AI analysis...');
  trackEvent(AnalyticsEvents.BOUNCER_HAIKU_REVIEW, { operation_length: operation.length });

  const claudeCommand = process.env.CLAUDE_COMMAND || 'claude';
  const workingDir = request.context?.workingDirectory || process.cwd();

  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const decision = await analyzeWithHaiku(request, claudeCommand, workingDir);
      console.error(`[Bouncer] ✓ Haiku decision: ${decision.decision} (${decision.confidence}% confidence) [${Math.round(performance.now() - startTime)}ms]`);
      console.error(`[Bouncer] Reasoning: ${decision.reasoning}`);
      return fin(decision, 'haiku-ai');
    } catch (error: unknown) {
      const result = handleHaikuError(error, operation, attempt, MAX_ATTEMPTS, fin);
      if (result) return result;
    }
  }

  return fin({ decision: 'deny', confidence: 0, reasoning: 'Security analysis exhausted all attempts. Denying for safety.', threatLevel: 'critical' }, 'ai-error', { skipCache: true });
}

// ── Main Review Function ──────────────────────────────────────

/**
 * Main bouncer review function - 2-layer hybrid system
 */
export async function reviewOperation(request: BouncerReviewRequest): Promise<BouncerDecision> {
  const { logBouncerDecision } = await import('./security-audit.js');
  const startTime = performance.now();
  const { operation: rawOperation } = request;
  const operation = normalizeOperation(rawOperation);
  const fin = (d: BouncerDecision, layer: string, opts?: Parameters<typeof finalizeDecision>[6]) =>
    finalizeDecision(operation, d, layer, startTime, request.context, logBouncerDecision, opts);

  // Check cache first (keyed on operation + session to prevent cross-context bypass)
  const cached = getCachedDecision(operation, request.context);
  if (cached) {
    console.error(`[Bouncer] ⚡ Cache hit: ${cached.decision} (${cached.confidence}%)`);
    return cached;
  }

  console.error('[Bouncer] Analyzing operation...');
  console.error(`[Bouncer] Operation: ${operation}`);
  if (request.context?.userRequest) {
    console.error(`[Bouncer] User request: ${request.context.userRequest}`);
  }

  // PRE-CHECK: Empty-param Edit/Write calls are no-ops — allow immediately
  const toolInput = request.context?.toolInput;
  if (toolInput && typeof toolInput === 'object' && Object.keys(toolInput).length === 0) {
    console.error('[Bouncer] ⚡ Fast path: Empty tool parameters (no-op)');
    return fin({ decision: 'allow', confidence: 95, reasoning: 'Empty tool parameters - operation is a no-op with no side effects.', threatLevel: 'low' }, 'pattern-noop', { skipAnalytics: true, skipLog: true });
  }

  // LAYER 1: Pattern-Based Fast Path
  const criticalThreat = matchesPattern(operation, CRITICAL_THREATS);
  if (criticalThreat) {
    console.error('[Bouncer] ⚡ Fast path: CRITICAL THREAT detected');
    return fin({
      decision: 'deny', confidence: 99, reasoning: `🚨 CRITICAL THREAT: ${criticalThreat.reason}`, threatLevel: 'critical',
      alternative: 'This operation should never be performed. If you need to accomplish a specific task, please describe your goal and I can suggest safe alternatives.',
      enforceable: true,
    }, 'pattern-critical');
  }

  if (!requiresAIReview(operation)) {
    const isSafe = matchesPattern(operation, SAFE_OPERATIONS);
    console.error(`[Bouncer] ⚡ Fast path: ${isSafe ? 'Safe operation approved' : 'No concerning patterns, allowing'}`);
    return fin({
      decision: 'allow',
      confidence: isSafe ? 95 : 80,
      reasoning: isSafe
        ? 'Operation matches known-safe patterns. No security concerns detected.'
        : 'Operation appears safe based on pattern analysis. No obvious threats detected.',
      threatLevel: 'low'
    }, isSafe ? 'pattern-safe' : 'pattern-default');
  }

  // LAYER 2: Haiku AI Analysis
  return runHaikuAnalysis(request, operation, startTime, fin);
}

/**
 * Export risk classification utility
 */
export { classifyRisk as classifyOperationRisk } from './security-patterns.js';

/**
 * Legacy compatibility — redirects to reviewOperation.
 * When useAI=false, skips AI analysis by injecting a context flag
 * that runHaikuAnalysis checks (avoids racy process.env mutation).
 */
export async function launchBouncerAgent(
  request: BouncerReviewRequest,
  useAI: boolean = true
): Promise<BouncerDecision> {
  if (!useAI) {
    // Inject skipAI flag into the request context so runHaikuAnalysis
    // can check it without mutating process.env (which races under concurrency).
    request = {
      ...request,
      context: { ...request.context, _skipAI: true },
    };
  }
  return reviewOperation(request);
}
