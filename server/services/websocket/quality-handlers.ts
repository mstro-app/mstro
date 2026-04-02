// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Quality Handlers — WebSocket message router for quality scanning,
 * code review, and fix operations.
 *
 * Agent logic lives in focused modules:
 * - quality-review-agent.ts  — AI code review prompt, parsing, handler
 * - quality-fix-agent.ts     — AI fix prompt, progress tracking, handler
 */

import { join } from 'node:path';
import type { HandlerContext } from './handler-context.js';
import type { FindingForFix } from './quality-fix-agent.js';
import { handleFixIssues } from './quality-fix-agent.js';
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
  if (dirPath.startsWith('/')) return dirPath;
  return join(workingDir, dirPath);
}

// ── Message router ────────────────────────────────────────────

export function handleQualityMessage(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  _tabId: string,
  workingDir: string,
): void {
  const handlers: Record<string, () => void> = {
    qualityDetectTools: () => handleDetectTools(ctx, ws, msg, workingDir),
    qualityScan: () => handleScan(ctx, ws, msg, workingDir),
    qualityInstallTools: () => handleInstallTools(ctx, ws, msg, workingDir),
    qualityCodeReview: () => {
      const dirPath = resolvePath(workingDir, msg.data?.path);
      const reportPath = msg.data?.path || '.';
      handleCodeReview(ctx, ws, reportPath, dirPath, workingDir, activeReviews, getPersistence);
    },
    qualityFixIssues: () => {
      const dirPath = resolvePath(workingDir, msg.data?.path);
      const reportPath = msg.data?.path || '.';
      const section: string | undefined = msg.data?.section;
      const findings: FindingForFix[] = msg.data?.findings || [];
      handleFixIssues(ctx, ws, reportPath, dirPath, workingDir, section, findings, getPersistence);
    },
    qualityLoadState: () => handleLoadState(ctx, ws, workingDir),
    qualitySaveDirectories: () => handleSaveDirectories(ctx, ws, msg, workingDir),
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
): Promise<void> {
  try {
    const persistence = getPersistence(workingDir);
    const directories: Array<{ path: string; label: string }> = msg.data?.directories || [];
    persistence.saveConfig(directories);
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
): Promise<void> {
  const dirPath = resolvePath(workingDir, msg.data?.path);
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
): Promise<void> {
  const dirPath = resolvePath(workingDir, msg.data?.path);
  const reportPath = msg.data?.path || '.';

  try {
    const { tools: detectedTools } = await detectTools(dirPath);
    const installedToolNames = detectedTools.filter((t) => t.installed).map((t) => t.name);

    const results = await runQualityScan(dirPath, (progress) => {
      ctx.send(ws, {
        type: 'qualityScanProgress',
        data: { path: reportPath, progress },
      });
    }, installedToolNames);
    ctx.send(ws, {
      type: 'qualityScanResults',
      data: { path: reportPath, results },
    });

    try {
      const persistence = getPersistence(workingDir);
      persistence.saveReport(reportPath, results);
      persistence.appendHistory(results, reportPath);
    } catch {
      // Persistence failure should not break the scan flow
    }
  } catch (error) {
    ctx.send(ws, {
      type: 'qualityError',
      data: { path: reportPath, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function handleInstallTools(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  workingDir: string,
): Promise<void> {
  const dirPath = resolvePath(workingDir, msg.data?.path);
  const reportPath = msg.data?.path || '.';
  const toolNames: string[] | undefined = msg.data?.tools;

  try {
    ctx.send(ws, {
      type: 'qualityInstallProgress',
      data: { path: reportPath, installing: true },
    });

    const { tools, ecosystem } = await installTools(dirPath, toolNames);

    ctx.send(ws, {
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
