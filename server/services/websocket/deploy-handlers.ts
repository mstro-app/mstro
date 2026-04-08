// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Deploy Handlers — WebSocket message router for deployment management.
 *
 * Handles deployCreate, deployStop, deployResume, deployDelete,
 * deployList, deployGetStatus, deployUpdateConfig, deploySetApiKey,
 * and delegates deployHttpRequest to the HTTP relay handler.
 */

import { connect } from 'node:net';
import {
  checkValidationRateLimit,
  getApiKeyStatus,
  storeApiKey,
  validateAnthropicKey,
} from '../deploy/credentials.js';
import { getCredentials } from '../platform-credentials.js';
import type { HandlerContext } from './handler-context.js';
import { handleDeployHttpRequest } from './handlers/deploy-handlers.js';
import type {
  DeployCreateData,
  DeployDeleteData,
  DeployGetStatusData,
  DeploymentInfo,
  DeployResumeData,
  DeploySetApiKeyData,
  DeployStopData,
  DeployUpdateConfigData,
  WebSocketMessage,
  WSContext,
} from './types.js';

// ── Platform API ─────────��───────────────────────────────────

const PLATFORM_URL = process.env.PLATFORM_URL || 'https://api.mstro.app';

async function platformFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const creds = getCredentials();
  if (!creds) {
    throw new Error('Not authenticated. Run `mstro login` first.');
  }
  const url = `${PLATFORM_URL}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creds.token}`,
      ...options.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
}

// ── Local deployment state ────��──────────────────────────────

interface LocalDeployment {
  info: DeploymentInfo;
  proxyActive: boolean;
}

const localDeployments = new Map<string, LocalDeployment>();

function toDeploymentInfo(serverRow: Record<string, unknown>): DeploymentInfo {
  return {
    deploymentId: serverRow.id as string,
    config: {
      subdomain: serverRow.subdomain as string,
      port: (serverRow.port as number) || 0,
      aiEnabled: false,
    },
    status: (serverRow.status as string) === 'active' ? 'running' : (serverRow.status as string) === 'stopped' ? 'stopped' : 'starting',
    url: `https://${serverRow.subdomain as string}.mstro.app`,
    createdAt: (serverRow.createdAt as string) || new Date().toISOString(),
    updatedAt: (serverRow.updatedAt as string) || new Date().toISOString(),
  };
}

// ── Port validation ──────────────────────────────────────────

function validatePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(2_000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

// ── Error helper ───────���─────────────────────────────────────

function sendDeployError(
  ctx: HandlerContext,
  ws: WSContext,
  error: string,
  deploymentId?: string,
): void {
  ctx.send(ws, {
    type: 'deployError',
    data: { error, deploymentId },
  });
}

// ── Message router ───────────────────────────────────────────

export function handleDeployMessage(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  _tabId: string,
  _workingDir: string,
  _permission?: 'view',
): void {
  const handlers: Record<string, () => void | Promise<void>> = {
    deployCreate: () => handleDeployCreate(ctx, ws, msg),
    deployStop: () => handleDeployStop(ctx, ws, msg),
    deployResume: () => handleDeployResume(ctx, ws, msg),
    deployDelete: () => handleDeployDelete(ctx, ws, msg),
    deployList: () => handleDeployList(ctx, ws),
    deployGetStatus: () => handleDeployGetStatus(ctx, ws, msg),
    deployUpdateConfig: () => handleDeployUpdateConfig(ctx, ws, msg),
    deploySetApiKey: () => handleDeploySetApiKey(ctx, ws, msg),
    deployValidateApiKey: () => handleDeployValidateApiKey(ctx, ws),
    deployHttpRequest: () => handleDeployHttpRequest(ctx, ws, msg),
  };

  const handler = handlers[msg.type];
  if (!handler) return;

  try {
    const result = handler();
    // Handle async handlers — catch rejections
    if (result instanceof Promise) {
      result.catch((error: unknown) => {
        const errMsg = error instanceof Error ? error.message : String(error);
        sendDeployError(ctx, ws, errMsg);
      });
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    sendDeployError(ctx, ws, errMsg);
  }
}

// ── Handler implementations ──────────────────────────────────

/**
 * deployCreate — validate port, call platform API, store local state.
 */
async function handleDeployCreate(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
): Promise<void> {
  const data = msg.data as DeployCreateData | undefined;
  if (!data?.subdomain || !data?.port) {
    sendDeployError(ctx, ws, 'subdomain and port are required');
    return;
  }

  // Validate local port is in use
  const portInUse = await validatePort(data.port);
  if (!portInUse) {
    sendDeployError(ctx, ws, `No service running on port ${data.port}. Start your app first.`);
    return;
  }

  // Call platform server API to create deployment record
  const creds = getCredentials();
  if (!creds) {
    sendDeployError(ctx, ws, 'Not authenticated. Run `mstro login` first.');
    return;
  }

  const response = await platformFetch('/api/deployments', {
    method: 'POST',
    body: JSON.stringify({
      orchestraPairingId: creds.clientId,
      subdomain: data.subdomain,
      port: data.port,
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Failed to create deployment' })) as { error?: string };
    sendDeployError(ctx, ws, body.error || `Server returned ${response.status}`);
    return;
  }

  const { deployment: serverDeployment } = await response.json() as { deployment: Record<string, unknown> };
  const info = toDeploymentInfo(serverDeployment);
  info.config.port = data.port;
  info.config.aiEnabled = data.aiEnabled ?? false;
  info.status = 'running';

  // Store local state
  localDeployments.set(info.deploymentId, { info, proxyActive: true });

  ctx.send(ws, {
    type: 'deployCreated',
    data: { deployment: info },
  });

  // Notify the platform server that this deployment is now active
  ctx.broadcastToAll({
    type: 'deployStatus',
    data: { deploymentId: info.deploymentId, status: 'running' },
  });
}

/**
 * deployStop — toggle local HTTP proxy off.
 */
async function handleDeployStop(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
): Promise<void> {
  const data = msg.data as DeployStopData | undefined;
  if (!data?.deploymentId) {
    sendDeployError(ctx, ws, 'deploymentId is required');
    return;
  }

  const local = localDeployments.get(data.deploymentId);
  if (!local) {
    sendDeployError(ctx, ws, 'Deployment not found locally', data.deploymentId);
    return;
  }

  local.proxyActive = false;
  local.info.status = 'stopped';
  local.info.updatedAt = new Date().toISOString();

  // Update server status
  await platformFetch(`/api/deployments/${data.deploymentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'stopped' }),
  }).catch(() => {
    // Non-critical: local state is authoritative for stop/resume
  });

  ctx.send(ws, {
    type: 'deployStopped',
    data: { deploymentId: data.deploymentId },
  });

  ctx.broadcastToAll({
    type: 'deployStatus',
    data: { deploymentId: data.deploymentId, status: 'stopped' },
  });
}

/**
 * deployResume — toggle local HTTP proxy on.
 */
async function handleDeployResume(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
): Promise<void> {
  const data = msg.data as DeployResumeData | undefined;
  if (!data?.deploymentId) {
    sendDeployError(ctx, ws, 'deploymentId is required');
    return;
  }

  const local = localDeployments.get(data.deploymentId);
  if (!local) {
    sendDeployError(ctx, ws, 'Deployment not found locally', data.deploymentId);
    return;
  }

  // Validate the port is still in use before resuming
  const portInUse = await validatePort(local.info.config.port);
  if (!portInUse) {
    sendDeployError(
      ctx,
      ws,
      `No service running on port ${local.info.config.port}. Start your app first.`,
      data.deploymentId,
    );
    return;
  }

  local.proxyActive = true;
  local.info.status = 'running';
  local.info.updatedAt = new Date().toISOString();

  // Update server status
  await platformFetch(`/api/deployments/${data.deploymentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'active' }),
  }).catch(() => {
    // Non-critical
  });

  ctx.send(ws, {
    type: 'deployResumed',
    data: { deploymentId: data.deploymentId },
  });

  ctx.broadcastToAll({
    type: 'deployStatus',
    data: { deploymentId: data.deploymentId, status: 'running' },
  });
}

/**
 * deployList — return all local deployment states.
 */
function handleDeployList(ctx: HandlerContext, ws: WSContext): void {
  const deployments: DeploymentInfo[] = [];
  for (const local of localDeployments.values()) {
    deployments.push(local.info);
  }
  ctx.send(ws, {
    type: 'deployListResult',
    data: { deployments },
  });
}

/**
 * deployGetStatus — return detailed status for one deployment.
 */
function handleDeployGetStatus(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
): void {
  const data = msg.data as DeployGetStatusData | undefined;
  if (!data?.deploymentId) {
    sendDeployError(ctx, ws, 'deploymentId is required');
    return;
  }

  const local = localDeployments.get(data.deploymentId);
  if (!local) {
    sendDeployError(ctx, ws, 'Deployment not found', data.deploymentId);
    return;
  }

  ctx.send(ws, {
    type: 'deployStatusResult',
    data: { deployment: local.info },
  });
}

/**
 * deployUpdateConfig — update config locally and on server.
 */
async function handleDeployUpdateConfig(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
): Promise<void> {
  const data = msg.data as DeployUpdateConfigData | undefined;
  if (!data?.deploymentId) {
    sendDeployError(ctx, ws, 'deploymentId is required');
    return;
  }

  const local = localDeployments.get(data.deploymentId);
  if (!local) {
    sendDeployError(ctx, ws, 'Deployment not found', data.deploymentId);
    return;
  }

  // Apply config updates locally
  if (data.config.subdomain !== undefined) {
    local.info.config.subdomain = data.config.subdomain;
    local.info.url = `https://${data.config.subdomain}.mstro.app`;
  }
  if (data.config.port !== undefined) {
    local.info.config.port = data.config.port;
  }
  if (data.config.aiEnabled !== undefined) {
    local.info.config.aiEnabled = data.config.aiEnabled;
  }
  if (data.config.customDomain !== undefined) {
    local.info.config.customDomain = data.config.customDomain;
  }
  local.info.updatedAt = new Date().toISOString();

  // Sync to platform server
  const serverUpdates: Record<string, unknown> = {};
  if (data.config.subdomain !== undefined) {
    serverUpdates.subdomain = data.config.subdomain;
  }
  if (data.config.port !== undefined) {
    serverUpdates.port = data.config.port;
  }

  if (Object.keys(serverUpdates).length > 0) {
    const response = await platformFetch(`/api/deployments/${data.deploymentId}`, {
      method: 'PATCH',
      body: JSON.stringify(serverUpdates),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'Failed to update deployment' })) as { error?: string };
      sendDeployError(ctx, ws, body.error || `Server returned ${response.status}`, data.deploymentId);
      return;
    }
  }

  ctx.send(ws, {
    type: 'deployConfigUpdated',
    data: { deployment: local.info },
  });
}

/**
 * deploySetApiKey — validate with Anthropic API, encrypt, and store locally.
 * The API key is NEVER logged, even partially.
 * Rate limited to max 10 validation attempts per minute.
 */
async function handleDeploySetApiKey(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
): Promise<void> {
  const data = msg.data as DeploySetApiKeyData | undefined;
  if (!data?.apiKey) {
    sendDeployError(ctx, ws, 'apiKey is required');
    return;
  }

  // Enforce rate limit before calling the Anthropic API
  if (!checkValidationRateLimit()) {
    ctx.send(ws, {
      type: 'deployApiKeyStatus',
      data: { status: 'rate_limited' as const },
    });
    return;
  }

  // Validate the key with Anthropic API
  const isValid = await validateAnthropicKey(data.apiKey);
  if (!isValid) {
    ctx.send(ws, {
      type: 'deployApiKeyStatus',
      data: { status: 'invalid' as const },
    });
    return;
  }

  // Encrypt and store locally
  const { lastFour } = storeApiKey(data.apiKey);

  ctx.send(ws, {
    type: 'deployApiKeyStatus',
    data: { status: 'valid' as const, lastFour, source: 'stored' as const },
  });
}

/**
 * deployValidateApiKey — check current key status (env var or stored).
 * When env var is detected, source is 'env' so the UI can show
 * "detected from environment".
 */
function handleDeployValidateApiKey(ctx: HandlerContext, ws: WSContext): void {
  const keyStatus = getApiKeyStatus();

  ctx.send(ws, {
    type: 'deployApiKeyStatus',
    data: keyStatus,
  });
}

/**
 * deployDelete — stop proxy and call server API to delete.
 */
async function handleDeployDelete(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
): Promise<void> {
  const data = msg.data as DeployDeleteData | undefined;
  if (!data?.deploymentId) {
    sendDeployError(ctx, ws, 'deploymentId is required');
    return;
  }

  // Stop local proxy
  const local = localDeployments.get(data.deploymentId);
  if (local) {
    local.proxyActive = false;
  }

  // Call server API to delete
  const response = await platformFetch(`/api/deployments/${data.deploymentId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Failed to delete deployment' })) as { error?: string };
    sendDeployError(ctx, ws, body.error || `Server returned ${response.status}`, data.deploymentId);
    return;
  }

  // Remove from local state
  localDeployments.delete(data.deploymentId);

  ctx.send(ws, {
    type: 'deployDeleted',
    data: { deploymentId: data.deploymentId },
  });

  ctx.broadcastToAll({
    type: 'deployStatus',
    data: { deploymentId: data.deploymentId, status: 'stopped' },
  });
}

/**
 * Check if a deployment's proxy is active. Used by the HTTP relay
 * to decide whether to forward incoming requests.
 */
export function isDeploymentProxyActive(deploymentId: string): boolean {
  const local = localDeployments.get(deploymentId);
  return local?.proxyActive ?? false;
}

/**
 * Get the local port for a deployment. Used by the HTTP relay
 * to forward requests to the correct local service.
 */
export function getDeploymentPort(deploymentId: string): number | null {
  const local = localDeployments.get(deploymentId);
  return local?.info.config.port ?? null;
}
