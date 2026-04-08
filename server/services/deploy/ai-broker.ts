// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * AI Broker — HTTP endpoint for developer backends to invoke AI execution.
 *
 * POST /api/deploy/ai/invoke
 *   Accepts { capability, deploymentId, endUserId, prompt, ... }
 *   Authorization: Bearer <deploy-token>
 *
 * GET /api/deploy/ai/jobs/:jobId
 *   Poll board execution status.
 *
 * Deploy tokens are per-deployment. The CLI stores the SHA-256 hash; the
 * developer's backend sends the raw token. We hash the incoming token and
 * compare against the stored hash.
 *
 * Headless sessions return SSE (text/event-stream).
 * Board executions return { jobId, statusUrl } immediately.
 */

import { createHash } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  type BoardExecutionConfig,
  getBoardExecutionStatus,
  startBoardExecution,
} from './board-execution-handler.js';
import {
  type DeploymentAiConfig,
  type HeadlessSessionStreamCallbacks,
  type HealthUpdateData,
  handleHeadlessSession,
  type UsageReportData,
} from './headless-session-handler.js';

// ========== Types ==========

export interface AiBrokerInvokeBody {
  capability: 'headless' | 'pm-board';
  deploymentId: string;
  endUserId: string;
  prompt: string;
  boardTemplateId?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string;
}

interface DeployTokenRecord {
  deploymentId: string;
  tokenHash: string;
  capabilities: ('headless' | 'pm-board')[];
  rateLimit: {
    maxRequestsPerMinute: number | null;
    maxConcurrentSessions: number;
  };
  aiConfig: {
    aiEnabled: boolean;
    defaultSystemPrompt: string | null;
    defaultModel: string;
    maxTokensPerRequest: number | null;
    workingDir: string;
    allowedBoardTemplateIds: string[];
    maxConcurrentBoardExecutions: number;
    maxBoardExecutionsPerMinute: number | null;
  };
  /** When set, the deployment requires payment and this URL is returned on 402 */
  paymentUrl?: string;
  /** Whether the deployment is currently active */
  enabled: boolean;
}

// ========== Token Store ==========

/**
 * In-memory store for deploy tokens. Populated when deployments are created
 * via the WebSocket handlers. Each entry maps a deployment ID to its
 * hashed token and configuration.
 */
const tokenStore = new Map<string, DeployTokenRecord>();

export function registerDeployToken(record: DeployTokenRecord): void {
  tokenStore.set(record.deploymentId, record);
}

export function unregisterDeployToken(deploymentId: string): void {
  tokenStore.delete(deploymentId);
}

export function getDeployTokenRecord(deploymentId: string): DeployTokenRecord | undefined {
  return tokenStore.get(deploymentId);
}

/**
 * Update rate limit and AI config on an existing deploy token record.
 * Called when the server syncs updated deployment config to the CLI.
 */
export function updateDeployTokenConfig(
  deploymentId: string,
  updates: {
    maxRequestsPerMinute?: number | null;
    maxConcurrentSessions?: number;
    maxTokensPerRequest?: number | null;
    aiEnabled?: boolean;
  },
): boolean {
  const record = tokenStore.get(deploymentId);
  if (!record) return false;

  if (updates.maxRequestsPerMinute !== undefined) {
    record.rateLimit.maxRequestsPerMinute = updates.maxRequestsPerMinute;
  }
  if (updates.maxConcurrentSessions !== undefined) {
    record.rateLimit.maxConcurrentSessions = updates.maxConcurrentSessions;
  }
  if (updates.maxTokensPerRequest !== undefined) {
    record.aiConfig.maxTokensPerRequest = updates.maxTokensPerRequest;
  }
  if (updates.aiEnabled !== undefined) {
    record.aiConfig.aiEnabled = updates.aiEnabled;
  }

  return true;
}

// ========== Usage & Health Listeners ==========

type UsageReportListener = (report: UsageReportData) => void;
type HealthUpdateListener = (update: HealthUpdateData) => void;

let usageReportListener: UsageReportListener | null = null;
let healthUpdateListener: HealthUpdateListener | null = null;

/**
 * Register a listener for deploy usage reports.
 * Called from the server setup to wire usage reports to the platform connection.
 */
export function setDeployUsageReportListener(listener: UsageReportListener): void {
  usageReportListener = listener;
}

/**
 * Register a listener for deploy AI health updates.
 * Called from the server setup to wire health updates to the platform connection.
 */
export function setDeployHealthUpdateListener(listener: HealthUpdateListener): void {
  healthUpdateListener = listener;
}

// ========== Token Validation ==========

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Validate a deploy token against the stored hash.
 * Returns the token record if valid, null otherwise.
 */
function validateDeployToken(
  rawToken: string,
  deploymentId: string,
): DeployTokenRecord | null {
  const record = tokenStore.get(deploymentId);
  if (!record) return null;

  const incomingHash = hashToken(rawToken);
  if (incomingHash !== record.tokenHash) return null;

  return record;
}

// ========== Rate Limiter ==========

interface BrokerRateBucket {
  timestamps: number[];
  activeSessions: number;
}

const brokerRateBuckets = new Map<string, BrokerRateBucket>();

function getBucket(key: string): BrokerRateBucket {
  let bucket = brokerRateBuckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [], activeSessions: 0 };
    brokerRateBuckets.set(key, bucket);
  }
  return bucket;
}

function pruneTimestamps(bucket: BrokerRateBucket): void {
  const oneMinuteAgo = Date.now() - 60_000;
  while (bucket.timestamps.length > 0 && bucket.timestamps[0] < oneMinuteAgo) {
    bucket.timestamps.shift();
  }
}

function checkBrokerRateLimit(
  record: DeployTokenRecord,
): { limited: boolean; retryAfterMs?: number } {
  const bucket = getBucket(record.deploymentId);

  if (bucket.activeSessions >= record.rateLimit.maxConcurrentSessions) {
    return { limited: true, retryAfterMs: 5_000 };
  }

  if (record.rateLimit.maxRequestsPerMinute !== null) {
    pruneTimestamps(bucket);
    if (bucket.timestamps.length >= record.rateLimit.maxRequestsPerMinute) {
      // Calculate retry-after based on oldest timestamp expiry
      const oldestTs = bucket.timestamps[0];
      const retryAfterMs = oldestTs + 60_000 - Date.now();
      return { limited: true, retryAfterMs: Math.max(1_000, retryAfterMs) };
    }
  }

  return { limited: false };
}

function recordBrokerRequestStart(deploymentId: string): void {
  const bucket = getBucket(deploymentId);
  bucket.timestamps.push(Date.now());
  bucket.activeSessions++;
}

function recordBrokerRequestEnd(deploymentId: string): void {
  const bucket = getBucket(deploymentId);
  bucket.activeSessions = Math.max(0, bucket.activeSessions - 1);
}

// ========== Request Validation ==========

type ValidatedRequest =
  | { ok: true; body: AiBrokerInvokeBody; record: DeployTokenRecord }
  | { ok: false; error: string; status: number; headers?: Record<string, string> };

function validateBody(body: AiBrokerInvokeBody): string | null {
  if (!body.capability || !body.deploymentId || !body.endUserId || !body.prompt) {
    return 'Missing required fields: capability, deploymentId, endUserId, prompt';
  }
  if (body.capability !== 'headless' && body.capability !== 'pm-board') {
    return "Invalid capability. Must be 'headless' or 'pm-board'";
  }
  if (body.capability === 'pm-board' && !body.boardTemplateId) {
    return "boardTemplateId is required when capability is 'pm-board'";
  }
  return null;
}

function validateTokenAndConfig(
  rawToken: string,
  body: AiBrokerInvokeBody,
): ValidatedRequest {
  const record = validateDeployToken(rawToken, body.deploymentId);
  if (!record) {
    return { ok: false, error: 'Invalid deploy token', status: 401 };
  }
  if (!record.enabled) {
    return { ok: false, error: 'Deployment is disabled', status: 403 };
  }
  if (!record.aiConfig.aiEnabled) {
    return { ok: false, error: 'AI features are not enabled for this deployment', status: 403 };
  }
  if (!record.capabilities.includes(body.capability)) {
    return { ok: false, error: `Capability '${body.capability}' is not enabled for this deployment`, status: 403 };
  }

  const rateCheck = checkBrokerRateLimit(record);
  if (rateCheck.limited) {
    const retryAfterSec = Math.ceil((rateCheck.retryAfterMs ?? 5_000) / 1_000);
    return {
      ok: false,
      error: 'Rate limit exceeded. Try again later.',
      status: 429,
      headers: { 'Retry-After': String(retryAfterSec) },
    };
  }

  return { ok: true, body, record };
}

// ========== Route Factory ==========

export function createAiBrokerRoutes(): Hono {
  const routes = new Hono();

  // ── POST /invoke — trigger AI execution ────────────────────

  routes.post('/invoke', async (c) => {
    const rawToken = extractBearerToken(c.req.header('Authorization'));
    if (!rawToken) {
      return c.json({ error: 'Missing or malformed Authorization header. Expected: Bearer <deploy-token>' }, 401);
    }

    let body: AiBrokerInvokeBody;
    try {
      body = await c.req.json<AiBrokerInvokeBody>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const bodyError = validateBody(body);
    if (bodyError) {
      return c.json({ error: bodyError }, 400);
    }

    const validation = validateTokenAndConfig(rawToken, body);
    if (!validation.ok) {
      return c.json(
        { error: validation.error },
        { status: validation.status as 400, headers: validation.headers },
      );
    }

    if (body.capability === 'headless') {
      return handleHeadlessInvoke(c, body, validation.record);
    }
    return handleBoardInvoke(c, body, validation.record);
  });

  // ── GET /jobs/:jobId — poll board execution status ─────────

  routes.get('/jobs/:jobId', (c) => {
    const { jobId } = c.req.param();
    const endUserId = c.req.query('endUserId');

    const status = getBoardExecutionStatus(jobId, endUserId ?? undefined);
    if (!status) {
      return c.json({ error: 'Job not found' }, 404);
    }

    return c.json(status);
  });

  return routes;
}

// ========== Headless Dispatch ==========

async function handleHeadlessInvoke(
  c: Context,
  body: AiBrokerInvokeBody,
  record: DeployTokenRecord,
) {
  const config: DeploymentAiConfig = {
    deploymentId: record.deploymentId,
    aiEnabled: record.aiConfig.aiEnabled,
    allowedAiCapabilities: record.capabilities,
    maxTokensPerRequest: record.aiConfig.maxTokensPerRequest,
    maxRequestsPerMinute: record.rateLimit.maxRequestsPerMinute,
    maxConcurrentSessions: record.rateLimit.maxConcurrentSessions,
    defaultSystemPrompt: record.aiConfig.defaultSystemPrompt,
    defaultModel: record.aiConfig.defaultModel,
    workingDir: record.aiConfig.workingDir,
  };

  recordBrokerRequestStart(record.deploymentId);

  // Stream headless session output as SSE
  return streamSSE(c, async (stream) => {
    let resultSent = false;

    const callbacks: HeadlessSessionStreamCallbacks = {
      onOutput: (text) => {
        stream.writeSSE({ event: 'output', data: text }).catch(() => {});
      },
      onThinking: (text) => {
        stream.writeSSE({ event: 'thinking', data: text }).catch(() => {});
      },
      onToolUse: (event) => {
        stream.writeSSE({ event: 'tool_use', data: JSON.stringify(event) }).catch(() => {});
      },
      onUsageReport: (report) => {
        usageReportListener?.(report);
      },
      onHealthUpdate: (update) => {
        healthUpdateListener?.(update);
      },
    };

    try {
      const result = await handleHeadlessSession(
        {
          prompt: body.prompt,
          systemPrompt: body.systemPrompt,
          allowedTools: body.allowedTools,
          model: body.model,
          endUserId: body.endUserId,
        },
        config,
        callbacks,
      );

      if (result.ok) {
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            sessionId: result.result.sessionId,
            completed: result.result.completed,
            totalTokens: result.result.totalTokens,
            durationMs: result.result.durationMs,
          }),
        });
      } else {
        // Map error codes to appropriate SSE error events
        const statusCode = mapErrorCodeToStatus(result.error.code);
        const errorData: Record<string, unknown> = {
          code: result.error.code,
          message: result.error.message,
          statusCode,
        };
        if (statusCode === 402 && record.paymentUrl) {
          errorData.paymentUrl = record.paymentUrl;
        }
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify(errorData),
        });
      }
      resultSent = true;
    } catch (error: unknown) {
      if (!resultSent) {
        const message = error instanceof Error ? error.message : String(error);
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ code: 'EXECUTION_FAILED', message }),
        }).catch(() => {});
      }
    } finally {
      recordBrokerRequestEnd(record.deploymentId);
    }
  });
}

// ========== Board Dispatch ==========

function handleBoardInvoke(
  c: Context,
  body: AiBrokerInvokeBody,
  record: DeployTokenRecord,
) {
  const config: BoardExecutionConfig = {
    deploymentId: record.deploymentId,
    aiEnabled: record.aiConfig.aiEnabled,
    allowedAiCapabilities: record.capabilities.map((cap) =>
      cap === 'pm-board' ? 'board-execution' : cap,
    ),
    allowedBoardTemplateIds: record.aiConfig.allowedBoardTemplateIds,
    maxConcurrentBoardExecutions: record.aiConfig.maxConcurrentBoardExecutions,
    maxBoardExecutionsPerMinute: record.aiConfig.maxBoardExecutionsPerMinute,
    defaultModel: record.aiConfig.defaultModel,
    workingDir: record.aiConfig.workingDir,
  };

  const result = startBoardExecution(
    {
      boardTemplateId: body.boardTemplateId!,
      endUserPrompt: body.prompt,
      endUserId: body.endUserId,
      deploymentId: body.deploymentId,
    },
    config,
  );

  if (!result.ok) {
    const statusCode = mapErrorCodeToStatus(result.error.code);
    const body: Record<string, unknown> = { error: result.error.message, code: result.error.code };
    if (statusCode === 402 && record.paymentUrl) {
      body.paymentUrl = record.paymentUrl;
    }
    return c.json(body, statusCode as 400);
  }

  // Construct polling URL relative to the request
  const host = c.req.header('Host') || 'localhost';
  const protocol = c.req.header('X-Forwarded-Proto') || 'http';
  const statusUrl = `${protocol}://${host}/api/deploy/ai/jobs/${result.jobId}`;

  return c.json({
    jobId: result.jobId,
    statusUrl,
  }, 202);
}

// ========== Error Mapping ==========

function mapErrorCodeToStatus(code: string): number {
  switch (code) {
    case 'CAPABILITY_DENIED':
    case 'AI_DISABLED':
      return 403;
    case 'RATE_LIMIT_EXCEEDED':
    case 'CONCURRENT_LIMIT_EXCEEDED':
      return 429;
    case 'INVALID_REQUEST':
    case 'INVALID_BOARD_TEMPLATE':
    case 'BOARD_TEMPLATE_NOT_FOUND':
      return 400;
    case 'PAYMENT_REQUIRED':
      return 402;
    default:
      return 500;
  }
}
