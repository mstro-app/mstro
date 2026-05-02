// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Quality Handlers — WebSocket message router for quality scanning
 * and code review operations. Fixes are handled via chat tabs from the
 * web client (see web/src/components/views/QualityView/qualityUtils.ts)
 * so there is no server-side fix message anymore.
 *
 * Agent logic lives in focused modules:
 * - quality-review-agent.ts  — AI code review prompt, parsing, handler
 */

import { join, resolve } from 'node:path';
import { validatePathWithinWorkingDir } from '../pathUtils.js';
import type { HandlerContext } from './handler-context.js';
import { QualityPersistence } from './quality-persistence.js';
import { handleCodeReview } from './quality-review-agent.js';
import { detectTools, installTools, runQualityScan } from './quality-service.js';
import type { WebSocketMessage, WSContext } from './types.js';

// ── Shared state ──────────────────────────────────────────────

const persistenceCache = new Map<string, QualityPersistence>();
const activeReviews = new Set<string>();

function getPersistence(workingDir: string): QualityPersistence {
  let persistence = persistenceCache.get(workingDir);
  if (!persistence) {
    persistence = new QualityPersistence(workingDir);
    persistenceCache.set(workingDir, persistence);
  }
  return persistence;
}

function resolvePath(workingDir: string, dirPath?: string): string {
  if (!dirPath || dirPath === '.' || dirPath === './') return workingDir;
  const resolved = dirPath.startsWith('/') ? dirPath : join(workingDir, dirPath);
  // Ensure path is within working directory even for non-sandboxed users
  const normalizedResolved = resolve(resolved);
  const normalizedWorkingDir = resolve(workingDir);
  if (!normalizedResolved.startsWith(normalizedWorkingDir)) return workingDir;
  return normalizedResolved;
}

/**
 * Resolve and validate a directory path for sandboxed users.
 * Returns null if the path escapes the working directory.
 */
function resolveAndValidatePath(
  workingDir: string,
  dirPath: string | undefined,
  isSandboxed: boolean,
): { resolved: string; error?: string } {
  const resolved = resolvePath(workingDir, dirPath);
  if (isSandboxed) {
    const validation = validatePathWithinWorkingDir(resolved, workingDir);
    if (!validation.valid) {
      return { resolved: '', error: validation.error || 'Path outside project directory' };
    }
    return { resolved: validation.resolvedPath };
  }
  return { resolved };
}

// ── Message router ────────────────────────────────────────────

export function handleQualityMessage(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  _tabId: string,
  workingDir: string,
  permission?: 'view',
): void {
  const isSandboxed = !!permission;
  const sendPathError = (path: string, error: string) => {
    ctx.send(ws, { type: 'qualityError', data: { path, error } });
  };

  const handlers: Record<string, () => void> = {
    qualityDetectTools: () => handleDetectTools(ctx, ws, msg, workingDir, isSandboxed),
    qualityScan: () => handleScan(ctx, ws, msg, workingDir, isSandboxed),
    qualityInstallTools: () => handleInstallTools(ctx, ws, msg, workingDir, isSandboxed),
    qualityCodeReview: () => {
      const { resolved: dirPath, error } = resolveAndValidatePath(workingDir, msg.data?.path, isSandboxed);
      if (error) { sendPathError(msg.data?.path || '.', error); return; }
      const reportPath = msg.data?.path || '.';
      const persistence = getPersistence(workingDir);
      persistence.setActiveOperation(reportPath, 'reviewing');
      handleCodeReview(ctx, ws, reportPath, dirPath, workingDir, activeReviews, getPersistence)
        .finally(() => persistence.clearActiveOperation(reportPath));
    },
    qualityLoadState: () => handleLoadState(ctx, ws, workingDir),
    qualityClearPending: () => {
      const persistence = getPersistence(workingDir);
      const path: string | undefined = msg.data?.path;
      persistence.clearPendingResults(path);
    },
    qualitySaveDirectories: () => handleSaveDirectories(ctx, ws, msg, workingDir, isSandboxed),
  };

  const handler = handlers[msg.type];
  if (!handler) return;

  try {
    handler();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: msg.data?.path || workingDir, error: errMsg },
    });
  }
}

// ── Scan / detect / install handlers ──────────────────────────

async function handleLoadState(
  ctx: HandlerContext,
  ws: WSContext,
  workingDir: string,
): Promise<void> {
  try {
    const persistence = getPersistence(workingDir);
    const state = persistence.loadState();

    // Deliver pending results that were completed while the client was disconnected.
    // Clear them after delivery so they don't re-send on the next reconnect.
    if (state.pendingResults.length > 0) {
      for (const pending of state.pendingResults) {
        if (pending.type === 'scanResults') {
          ctx.send(ws, { type: 'qualityScanResults', data: pending.data });
        } else if (pending.type === 'codeReview') {
          ctx.send(ws, { type: 'qualityCodeReview', data: pending.data });
        }
      }
      persistence.clearPendingResults();
    }

    ctx.send(ws, { type: 'qualityStateLoaded', data: state });
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: '.', error: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function handleSaveDirectories(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  workingDir: string,
  isSandboxed = false,
): Promise<void> {
  try {
    const persistence = getPersistence(workingDir);
    const directories: Array<{ path: string; label: string }> = msg.data?.directories || [];

    // Validate all directory paths when sandboxed
    if (isSandboxed) {
      for (const dir of directories) {
        const { error } = resolveAndValidatePath(workingDir, dir.path, true);
        if (error) {
          ctx.send(ws, {
            type: 'qualityError',
            data: { path: dir.path, error: `Cannot save directory: ${error}` },
          });
          return;
        }
      }
    }

    persistence.saveConfig(directories);

    // Broadcast the updated set so every paired web (on any Fly instance)
    // reflects the change. This is how Quality subdirectory tabs stay in
    // sync across devices — the type is listed in the cross-instance
    // set in `server/src/relay/handlers/clientHandlers.ts`.
    ctx.broadcastToAll({
      type: 'qualityDirectoriesUpdated',
      data: { directories },
    });
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: '.', error: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function handleDetectTools(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  workingDir: string,
  isSandboxed = false,
): Promise<void> {
  const { resolved: dirPath, error: pathError } = resolveAndValidatePath(workingDir, msg.data?.path, isSandboxed);
  if (pathError) {
    ctx.send(ws, { type: 'qualityError', data: { path: msg.data?.path || '.', error: pathError } });
    return;
  }
  try {
    const { tools, ecosystem } = await detectTools(dirPath);
    ctx.send(ws, {
      type: 'qualityToolsDetected',
      data: { path: msg.data?.path || '.', tools, ecosystem },
    });
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: msg.data?.path || '.', error: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function handleScan(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  workingDir: string,
  isSandboxed = false,
): Promise<void> {
  const { resolved: dirPath, error: pathError } = resolveAndValidatePath(workingDir, msg.data?.path, isSandboxed);
  if (pathError) {
    ctx.send(ws, { type: 'qualityError', data: { path: msg.data?.path || '.', error: pathError } });
    return;
  }
  const reportPath = msg.data?.path || '.';
  const persistence = getPersistence(workingDir);

  try {
    persistence.setActiveOperation(reportPath, 'scanning');

    const { tools: detectedTools } = await detectTools(dirPath);
    const installedToolNames = detectedTools.filter((t) => t.installed).map((t) => t.name);

    const results = await runQualityScan(dirPath, (progress) => {
      ctx.send(ws, {
        type: 'qualityScanProgress',
        data: { path: reportPath, progress },
      });
    }, installedToolNames);

    // Persist before sending — results survive if WebSocket drops
    try {
      persistence.saveReport(reportPath, results);
      persistence.appendHistory(results, reportPath);
    } catch {
      // Persistence failure should not break the scan flow
    }

    const resultData = { path: reportPath, results };
    try {
      // Broadcast so every device sees the new scan — the Quality view on
      // another device otherwise stays stuck on the previous scan results.
      ctx.broadcastToAll({ type: 'qualityScanResults', data: resultData });
    } catch {
      // Broadcast failed — save as pending for delivery on reconnect
      persistence.addPendingResult({
        type: 'scanResults',
        path: reportPath,
        data: resultData as unknown as Record<string, unknown>,
        completedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: reportPath, error: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    persistence.clearActiveOperation(reportPath);
  }
}

async function handleInstallTools(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  workingDir: string,
  isSandboxed = false,
): Promise<void> {
  const { resolved: dirPath, error: pathError } = resolveAndValidatePath(workingDir, msg.data?.path, isSandboxed);
  if (pathError) {
    ctx.send(ws, { type: 'qualityError', data: { path: msg.data?.path || '.', error: pathError } });
    return;
  }
  const reportPath = msg.data?.path || '.';
  const toolNames: string[] | undefined = msg.data?.tools;

  try {
    ctx.send(ws, {
      type: 'qualityInstallProgress',
      data: { path: reportPath, installing: true },
    });

    const { tools, ecosystem } = await installTools(dirPath, toolNames);

    // Broadcast so every device sees the install result (status of tools
    // changes orchestra-wide once installed on the machine).
    ctx.broadcastToAll({
      type: 'qualityInstallComplete',
      data: { path: reportPath, tools, ecosystem },
    });
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: reportPath, error: error instanceof Error ? error.message : String(error) },
    });
  }
}
