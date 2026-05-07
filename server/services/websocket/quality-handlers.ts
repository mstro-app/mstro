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
import { estimateCodebaseSize, estimateScanMs } from './quality-eta.js';
import { operationRegistry } from './quality-operations.js';
import { QualityPersistence } from './quality-persistence.js';
import { handleCodeReview } from './quality-review-agent.js';
import { detectTools, installTools, QualityScanAbortedError, runQualityScan } from './quality-service.js';
import type { WebSocketMessage, WSContext } from './types.js';

// ── Shared state ──────────────────────────────────────────────

const persistenceCache = new Map<string, QualityPersistence>();

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
      let controller: AbortController;
      try {
        controller = operationRegistry.start(workingDir, reportPath, 'reviewing');
      } catch {
        // Look up what's actually running so the user sees the right message
        // — clicking "Run checks" during an in-flight AI review used to surface
        // "A scan is already running" because the error was hardcoded to the
        // *new* op kind rather than the existing one.
        const runningKind = operationRegistry.getKind(workingDir, reportPath);
        const error = runningKind === 'scanning'
          ? 'A scan is already running for this directory.'
          : 'An AI review is already running for this directory.';
        ctx.send(ws, { type: 'qualityError', data: { path: reportPath, error } });
        return;
      }
      persistence.setActiveOperation(reportPath, 'reviewing');
      // The review agent is responsible for emitting the first progress
      // message with an ETA; the handler just wires up the controller +
      // persistence cleanup.
      handleCodeReview(ctx, ws, reportPath, dirPath, workingDir, getPersistence, controller.signal)
        .finally(() => {
          operationRegistry.finish(workingDir, reportPath);
          persistence.clearActiveOperation(reportPath);
        });
    },
    qualityCancel: () => handleCancel(ctx, msg, workingDir),
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

    // Reconcile orphaned active operations: anything persisted to disk that
    // has no live `AbortController` in the registry was interrupted by a CLI
    // restart or crash. Surface as an error so the UI clears the spinner and
    // remove from disk so the same op doesn't keep haunting future reconnects.
    const orphans = state.activeOperations.filter(
      (op) => !operationRegistry.has(workingDir, op.path),
    );
    if (orphans.length > 0) {
      for (const op of orphans) {
        persistence.clearActiveOperation(op.path);
        ctx.send(ws, {
          type: 'qualityError',
          data: { path: op.path, error: 'Operation interrupted — please run again.' },
        });
      }
      // Reload so the response reflects the cleared ops.
      const refreshed = persistence.loadState();
      ctx.send(ws, { type: 'qualityStateLoaded', data: refreshed });
      return;
    }

    ctx.send(ws, { type: 'qualityStateLoaded', data: state });
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: '.', error: error instanceof Error ? error.message : String(error) },
    });
  }
}

function handleCancel(
  ctx: HandlerContext,
  msg: WebSocketMessage,
  workingDir: string,
): void {
  const reportPath = msg.data?.path || '.';
  const persistence = getPersistence(workingDir);
  const wasRunning = operationRegistry.cancel(workingDir, reportPath);
  // Always clear persistence — cancel for an orphan should still leave the
  // disk clean so future reconnects don't re-emit the orphan reconciliation
  // error.
  persistence.clearActiveOperation(reportPath);
  // Broadcast so every paired device sees the operation end (multi-device
  // sync). If nothing was running we still emit so a stale spinner on a
  // second device gets cleared by the `qualityError` handler.
  ctx.broadcastToAll({
    type: 'qualityError',
    data: {
      path: reportPath,
      error: wasRunning ? 'Cancelled by user' : 'Operation already finished',
    },
  });
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

  let controller: AbortController;
  try {
    controller = operationRegistry.start(workingDir, reportPath, 'scanning');
  } catch {
    // Same reasoning as the qualityCodeReview handler above — surface the
    // *running* op kind, not the requested one.
    const runningKind = operationRegistry.getKind(workingDir, reportPath);
    const error = runningKind === 'reviewing'
      ? 'An AI review is already running for this directory.'
      : 'A scan is already running for this directory.';
    ctx.send(ws, { type: 'qualityError', data: { path: reportPath, error } });
    return;
  }

  const scanStartedAt = Date.now();
  // Pre-compute a size + ETA so the very first progress event carries an
  // estimate. We deliberately do this *before* `setActiveOperation` so a
  // freshly-clicked scan shows numbers immediately rather than after a
  // file-collection round-trip.
  let etaMs: number | undefined;
  try {
    const size = await estimateCodebaseSize(dirPath);
    etaMs = estimateScanMs(size, persistence.loadHistory(), reportPath);
  } catch {
    // Falling back to no ETA is fine — the UI will simply hide the remaining-time chip.
  }

  try {
    persistence.setActiveOperation(reportPath, 'scanning');

    // Emit a "Detecting tools" frame *before* the long detect call so the
    // user sees motion immediately on click — `detectTools` spawns one
    // child process per ecosystem tool and can sit silent for several
    // seconds on a cold cache.
    ctx.send(ws, {
      type: 'qualityScanProgress',
      data: {
        path: reportPath,
        progress: { step: 'Detecting tools', current: 0, total: 8, etaMs, startedAt: scanStartedAt },
      },
    });
    const { tools: detectedTools } = await detectTools(dirPath);
    const installedToolNames = detectedTools.filter((t) => t.installed).map((t) => t.name);

    // Heartbeat — keeps the progress UI showing elapsed time during long
    // sub-steps (lint/format/build) where `runQualityScan` doesn't get a
    // chance to call the progress callback again.
    let lastProgress: { step: string; current: number; total: number } = {
      step: 'Detecting tools',
      current: 0,
      total: 8,
    };
    const heartbeat = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - scanStartedAt) / 1000);
      ctx.send(ws, {
        type: 'qualityScanProgress',
        data: {
          path: reportPath,
          progress: { ...lastProgress, etaMs, startedAt: scanStartedAt, detail: `${elapsedSec}s elapsed` },
        },
      });
    }, 5_000);

    let results: Awaited<ReturnType<typeof runQualityScan>>;
    try {
      results = await runQualityScan(dirPath, (progress) => {
        lastProgress = progress;
        ctx.send(ws, {
          type: 'qualityScanProgress',
          data: {
            path: reportPath,
            progress: { ...progress, etaMs, startedAt: scanStartedAt },
          },
        });
      }, installedToolNames, controller.signal);
    } finally {
      clearInterval(heartbeat);
    }

    // Annotate the report with the wall-clock duration so subsequent scans
    // of this directory have real history to base their ETA on. Same pattern
    // applies for the AI review duration written by the review agent.
    const scanDurationMs = Date.now() - scanStartedAt;
    results.scanDurationMs = scanDurationMs;

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
    if (error instanceof QualityScanAbortedError) {
      // Cancellation already broadcast a `qualityError` from `handleCancel`.
      // Don't send a second error message.
      return;
    }
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: reportPath, error: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    operationRegistry.finish(workingDir, reportPath);
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
