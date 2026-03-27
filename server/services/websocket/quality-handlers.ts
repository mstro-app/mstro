// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { join } from 'node:path';
import type { HandlerContext } from './handler-context.js';
import { detectTools, installTools, runQualityScan } from './quality-service.js';
import type { WebSocketMessage, WSContext } from './types.js';

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
    qualityCodeReview: () => handleCodeReview(ctx, ws, msg, workingDir),
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

function resolvePath(workingDir: string, dirPath?: string): string {
  if (!dirPath || dirPath === '.' || dirPath === './') return workingDir;
  if (dirPath.startsWith('/')) return dirPath;
  return join(workingDir, dirPath);
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
    const results = await runQualityScan(dirPath, (progress) => {
      ctx.send(ws, {
        type: 'qualityScanProgress',
        data: { path: reportPath, progress },
      });
    });
    ctx.send(ws, {
      type: 'qualityScanResults',
      data: { path: reportPath, results },
    });
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

async function handleCodeReview(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  _workingDir: string,
): Promise<void> {
  const reportPath = msg.data?.path || '.';

  // Code review via headless Claude will be implemented in a follow-up.
  // For now, send an empty result to unblock the UI.
  ctx.send(ws, {
    type: 'qualityCodeReview',
    data: {
      path: reportPath,
      findings: [],
      summary: 'Code review requires a Claude Code session. Run from the Chat view for a detailed code review.',
    },
  });
}
