// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Headless Session Handler
 *
 * Handles headless Claude Code session requests from a developer's backend
 * on behalf of end users. Each session is isolated — no shared context
 * between end users.
 *
 * Security: End-user prompts are untrusted input. They are always passed as
 * user messages, never injected into system prompts or tool parameters.
 * The Security Bouncer governs tool access within each session.
 */

import type { ToolUseEvent } from '../../cli/headless/types.js';
import { DeployAiService, type DeployExecutionResult } from './deploy-ai-service.js';

// ========== Types ==========

export interface HeadlessSessionRequest {
  /** The end user's prompt (untrusted input) */
  prompt: string;
  /** Override the deployment's default system prompt */
  systemPrompt?: string;
  /** Restrict which tools Claude can use in this session */
  allowedTools?: string[];
  /** Override the deployment's default model */
  model?: string;
  /** Unique identifier for the end user (for isolation + rate tracking) */
  endUserId: string;
}

export interface DeploymentAiConfig {
  deploymentId: string;
  aiEnabled: boolean;
  allowedAiCapabilities: string[];
  maxTokensPerRequest: number | null;
  maxRequestsPerMinute: number | null;
  maxConcurrentSessions: number;
  defaultSystemPrompt: string | null;
  defaultModel: string;
  workingDir: string;
}

export type HeadlessSessionErrorCode =
  | 'CAPABILITY_DENIED'
  | 'AI_DISABLED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'CONCURRENT_LIMIT_EXCEEDED'
  | 'INVALID_REQUEST'
  | 'EXECUTION_FAILED';

export interface HeadlessSessionError {
  code: HeadlessSessionErrorCode;
  message: string;
}

export interface HeadlessSessionStreamCallbacks {
  onOutput?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolUse?: (event: ToolUseEvent) => void;
  onUsageReport?: (report: UsageReportData) => void;
  onHealthUpdate?: (update: HealthUpdateData) => void;
}

export interface UsageReportData {
  deploymentId: string;
  endUserId: string;
  capability: 'headless' | 'pm-board';
  tokensUsed: number;
  model: string;
  durationMs: number;
  boardId?: string;
}

export interface HealthUpdateData {
  deploymentId: string;
  status: 'healthy' | 'invalid_key' | 'no_credits' | 'rate_limited' | 'unknown_error';
  message: string;
  aiDisabled: boolean;
}

export type HeadlessSessionResult =
  | { ok: true; result: DeployExecutionResult }
  | { ok: false; error: HeadlessSessionError };

// ========== Rate Limiter ==========

interface RateBucket {
  timestamps: number[];
  activeSessions: number;
}

const rateBuckets = new Map<string, RateBucket>();

function getBucket(deploymentId: string): RateBucket {
  let bucket = rateBuckets.get(deploymentId);
  if (!bucket) {
    bucket = { timestamps: [], activeSessions: 0 };
    rateBuckets.set(deploymentId, bucket);
  }
  return bucket;
}

function pruneTimestamps(bucket: RateBucket): void {
  const oneMinuteAgo = Date.now() - 60_000;
  // Remove timestamps older than 1 minute
  while (bucket.timestamps.length > 0 && bucket.timestamps[0] < oneMinuteAgo) {
    bucket.timestamps.shift();
  }
}

function checkRateLimit(
  config: DeploymentAiConfig,
): HeadlessSessionError | null {
  const bucket = getBucket(config.deploymentId);

  // Check concurrent sessions
  if (bucket.activeSessions >= config.maxConcurrentSessions) {
    return {
      code: 'CONCURRENT_LIMIT_EXCEEDED',
      message: `Deployment has reached the maximum of ${config.maxConcurrentSessions} concurrent sessions. Wait for an existing session to complete.`,
    };
  }

  // Check requests per minute
  if (config.maxRequestsPerMinute !== null) {
    pruneTimestamps(bucket);
    if (bucket.timestamps.length >= config.maxRequestsPerMinute) {
      return {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Deployment has exceeded the rate limit of ${config.maxRequestsPerMinute} requests per minute. Try again shortly.`,
      };
    }
  }

  return null;
}

function recordRequestStart(deploymentId: string): void {
  const bucket = getBucket(deploymentId);
  bucket.timestamps.push(Date.now());
  bucket.activeSessions++;
}

function recordRequestEnd(deploymentId: string): void {
  const bucket = getBucket(deploymentId);
  bucket.activeSessions = Math.max(0, bucket.activeSessions - 1);
}

// ========== Prompt Composition ==========

/**
 * Compose the final prompt sent to Claude. The system prompt (from deployment
 * config or per-request override) is prepended as a system instruction block.
 * The end-user prompt follows as a clearly delimited user message.
 *
 * SECURITY: The end-user prompt is always in the user-message section,
 * never interpolated into the system instruction.
 */
function composePrompt(systemPrompt: string | null, userPrompt: string): string {
  if (!systemPrompt) {
    return userPrompt;
  }

  return [
    '<system-instruction>',
    systemPrompt,
    '</system-instruction>',
    '',
    userPrompt,
  ].join('\n');
}

// ========== Validation ==========

/** Validate request fields and deployment config. Returns an error or null if valid. */
function validateRequest(
  request: HeadlessSessionRequest,
  config: DeploymentAiConfig,
): HeadlessSessionError | null {
  if (!request.prompt || request.prompt.trim().length === 0) {
    return { code: 'INVALID_REQUEST', message: 'prompt is required and must not be empty.' };
  }
  if (!request.endUserId || request.endUserId.trim().length === 0) {
    return { code: 'INVALID_REQUEST', message: 'endUserId is required.' };
  }
  if (!config.aiEnabled) {
    return { code: 'AI_DISABLED', message: 'AI features are not enabled for this deployment.' };
  }
  if (!config.allowedAiCapabilities.includes('headless')) {
    return {
      code: 'CAPABILITY_DENIED',
      message: "This deployment does not have the 'headless' AI capability enabled.",
    };
  }
  return null;
}

/** Check estimated input tokens against the per-request cap. Returns an error or null. */
function checkTokenLimit(
  promptLength: number,
  maxTokensPerRequest: number | null,
): HeadlessSessionError | null {
  if (maxTokensPerRequest === null) return null;
  const estimatedInputTokens = Math.ceil(promptLength / 4);
  if (estimatedInputTokens > maxTokensPerRequest) {
    return {
      code: 'RATE_LIMIT_EXCEEDED',
      message: `Estimated input tokens (${estimatedInputTokens}) exceeds maxTokensPerRequest (${maxTokensPerRequest}). Shorten your prompt.`,
    };
  }
  return null;
}

/** Emit health update and usage report callbacks after execution. */
function emitPostExecutionCallbacks(
  result: DeployExecutionResult,
  config: DeploymentAiConfig,
  request: HeadlessSessionRequest,
  effectiveModel: string,
  callbacks?: HeadlessSessionStreamCallbacks,
): void {
  callbacks?.onUsageReport?.({
    deploymentId: config.deploymentId,
    endUserId: request.endUserId,
    capability: 'headless',
    tokensUsed: result.totalTokens,
    model: effectiveModel,
    durationMs: result.durationMs,
  });

  const healthStatus = detectAiHealthIssue(result.error);
  if (healthStatus) {
    callbacks?.onHealthUpdate?.({
      deploymentId: config.deploymentId,
      ...healthStatus,
    });
  }
}

// ========== Handler ==========

/**
 * Handle a headless session request for an end user.
 *
 * Validates the deployment config, checks rate limits, composes the prompt
 * with the system instruction, and launches an isolated headless session
 * via DeployAiService. Streams results back through the provided callbacks.
 *
 * @returns Structured result with either the execution result or an error.
 */
export async function handleHeadlessSession(
  request: HeadlessSessionRequest,
  config: DeploymentAiConfig,
  callbacks?: HeadlessSessionStreamCallbacks,
): Promise<HeadlessSessionResult> {
  // ── Validate request ───────────────────────────────────────
  const validationError = validateRequest(request, config);
  if (validationError) return { ok: false, error: validationError };

  // ── Rate limit checks ─────────────────────────────────────
  const rateLimitError = checkRateLimit(config);
  if (rateLimitError) return { ok: false, error: rateLimitError };

  // ── Token limit pre-check ─────────────────────────────────
  const tokenError = checkTokenLimit(request.prompt.length, config.maxTokensPerRequest);
  if (tokenError) return { ok: false, error: tokenError };

  // ── Compose prompt ─────────────────────────────────────────
  // Use per-request system prompt if provided, otherwise deployment default
  const effectiveSystemPrompt = request.systemPrompt ?? config.defaultSystemPrompt;
  const composedPrompt = composePrompt(effectiveSystemPrompt, request.prompt);

  // Use per-request model if provided, otherwise deployment default
  const effectiveModel = request.model ?? config.defaultModel;

  // ── Launch isolated session ────────────────────────────────
  const service = DeployAiService.getInstance();

  recordRequestStart(config.deploymentId);

  try {
    const result = await service.execute({
      deploymentId: config.deploymentId,
      prompt: composedPrompt,
      workingDir: config.workingDir,
      model: effectiveModel,
      outputCallback: callbacks?.onOutput,
      thinkingCallback: callbacks?.onThinking,
      toolUseCallback: callbacks?.onToolUse,
      // allowedTools from request are inverted: any tool NOT in the list is disallowed.
      // If allowedTools is not specified, no additional restrictions are applied
      // (Security Bouncer still governs tool access).
      disallowedTools: request.allowedTools
        ? invertAllowedTools(request.allowedTools)
        : undefined,
    });

    // Token overage is informational — session already ran, don't fail the response.
    // The developer can use usage reports for billing or to tighten limits.

    emitPostExecutionCallbacks(result, config, request, effectiveModel, callbacks);

    return { ok: true, result };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    // Check for API key health issues from caught errors
    const healthStatus = detectAiHealthIssue(message);
    if (healthStatus) {
      callbacks?.onHealthUpdate?.({
        deploymentId: config.deploymentId,
        ...healthStatus,
      });
    }

    return {
      ok: false,
      error: { code: 'EXECUTION_FAILED', message },
    };
  } finally {
    recordRequestEnd(config.deploymentId);
  }
}

// ========== Health Detection ==========

/**
 * Detect API key health issues from error messages returned by Claude Code.
 *
 * Anthropic API errors that indicate credential/billing problems:
 * - 401: Invalid API key
 * - 402/insufficient_funds: Account has no credits
 * - 429: Rate limited by Anthropic
 */
function detectAiHealthIssue(
  errorMessage: string | undefined,
): { status: HealthUpdateData['status']; message: string; aiDisabled: boolean } | null {
  if (!errorMessage) return null;

  const lower = errorMessage.toLowerCase();

  if (lower.includes('invalid api key') || lower.includes('invalid x-api-key') || lower.includes('authentication_error')) {
    return { status: 'invalid_key', message: 'Anthropic API key is invalid or revoked.', aiDisabled: true };
  }

  if (lower.includes('insufficient_funds') || lower.includes('no credits') || lower.includes('billing') || lower.includes('credit balance')) {
    return { status: 'no_credits', message: 'Anthropic account has insufficient credits.', aiDisabled: true };
  }

  if (lower.includes('rate_limit') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return { status: 'rate_limited', message: 'Anthropic API rate limit exceeded.', aiDisabled: false };
  }

  return null;
}

// ========== Helpers ==========

/**
 * The DeployAiService accepts `disallowedTools` (blocklist), but the
 * headless session API exposes `allowedTools` (allowlist) for a better
 * developer UX. This converts an allowlist into a blocklist by marking
 * everything outside the allowlist as disallowed.
 *
 * We use a known set of standard Claude Code tool names. Tools not in
 * the known set are left unrestricted (the Security Bouncer handles them).
 */
const KNOWN_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoRead',
  'TodoWrite',
  'NotebookEdit',
  'Agent',
] as const;

function invertAllowedTools(allowedTools: string[]): string[] {
  const allowed = new Set(allowedTools);
  return KNOWN_TOOLS.filter((tool) => !allowed.has(tool));
}

/**
 * Get the current rate limit state for a deployment.
 * Useful for status/monitoring endpoints.
 */
export function getDeploymentRateLimitState(deploymentId: string): {
  requestsInLastMinute: number;
  activeSessions: number;
} {
  const bucket = getBucket(deploymentId);
  pruneTimestamps(bucket);
  return {
    requestsInLastMinute: bucket.timestamps.length,
    activeSessions: bucket.activeSessions,
  };
}

/**
 * Reset rate limit state for a deployment. Call when a deployment
 * is deleted or all its sessions are force-stopped.
 */
export function resetDeploymentRateLimit(deploymentId: string): void {
  rateBuckets.delete(deploymentId);
}
