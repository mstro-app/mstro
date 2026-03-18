// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { AnalyticsEvents, trackEvent } from '../analytics.js';
import { getPTYManager } from '../terminal/pty-manager.js';
import type { HandlerContext } from './handler-context.js';
import type { WebSocketMessage, WSContext } from './types.js';

export function handleTerminalMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'control' | 'view'): void {
  const termId = msg.terminalId || tabId;
  switch (msg.type) {
    case 'terminalInit':
      handleTerminalInit(ctx, ws, termId, workingDir, msg.data?.shell, msg.data?.cols, msg.data?.rows, permission);
      break;
    case 'terminalReconnect':
      handleTerminalReconnect(ctx, ws, termId);
      break;
    case 'terminalList':
      handleTerminalList(ctx, ws);
      break;
    case 'terminalInput':
      handleTerminalInput(ctx, ws, termId, msg.data?.input);
      break;
    case 'terminalResize':
      handleTerminalResize(ctx, termId, msg.data?.cols, msg.data?.rows);
      break;
    case 'terminalClose':
      handleTerminalClose(ctx, ws, termId);
      break;
  }
}

function handleTerminalInit(
  ctx: HandlerContext,
  ws: WSContext,
  terminalId: string,
  workingDir: string,
  requestedShell?: string,
  cols?: number,
  rows?: number,
  permission?: 'control' | 'view'
): void {
  const ptyManager = getPTYManager();

  if (!ptyManager.isPtyAvailable()) {
    ctx.send(ws, {
      type: 'terminalError',
      terminalId,
      data: {
        error: 'PTY_NOT_AVAILABLE',
        instructions: ptyManager.getPtyInstallInstructions()
      }
    });
    return;
  }

  addTerminalSubscriber(ctx, terminalId, ws);
  setupTerminalBroadcastListeners(ctx, terminalId);

  try {
    const { shell, cwd, isReconnect } = ptyManager.create(
      terminalId,
      workingDir,
      cols || 80,
      rows || 24,
      requestedShell,
      { sandboxed: permission === 'control' || permission === 'view' }
    );

    if (!isReconnect) {
      ctx.broadcastToOthers(ws, {
        type: 'terminalCreated',
        data: { terminalId, shell, cwd }
      });
    }

    ctx.send(ws, {
      type: 'terminalReady',
      terminalId,
      data: { shell, cwd, isReconnect }
    });
    trackEvent(AnalyticsEvents.TERMINAL_SESSION_CREATED, {
      shell,
      is_reconnect: isReconnect,
    });
  } catch (error: unknown) {
    console.error(`[WebSocketImproviseHandler] Failed to create terminal:`, error);
    ctx.send(ws, {
      type: 'terminalError',
      terminalId,
      data: { error: (error instanceof Error ? error.message : String(error)) || 'Failed to create terminal' }
    });
    removeTerminalSubscriber(ctx, terminalId, ws);
  }
}

function handleTerminalReconnect(ctx: HandlerContext, ws: WSContext, terminalId: string): void {
  const ptyManager = getPTYManager();

  const sessionInfo = ptyManager.getSessionInfo(terminalId);
  if (!sessionInfo) {
    ctx.send(ws, {
      type: 'terminalError',
      terminalId,
      data: { error: 'Terminal session not found', sessionNotFound: true }
    });
    return;
  }

  addTerminalSubscriber(ctx, terminalId, ws);
  setupTerminalBroadcastListeners(ctx, terminalId);

  ctx.send(ws, {
    type: 'terminalReady',
    terminalId,
    data: {
      shell: sessionInfo.shell,
      cwd: sessionInfo.cwd,
      isReconnect: true
    }
  });

  ptyManager.resize(terminalId, sessionInfo.cols, sessionInfo.rows);
}

function handleTerminalList(ctx: HandlerContext, ws: WSContext): void {
  const ptyManager = getPTYManager();
  const terminalIds = ptyManager.getActiveTerminals();

  const terminals = terminalIds.map(id => {
    const info = ptyManager.getSessionInfo(id);
    return info ? { id, ...info } : null;
  }).filter(Boolean);

  ctx.send(ws, {
    type: 'terminalList',
    data: { terminals }
  });
}

function handleTerminalInput(
  ctx: HandlerContext,
  ws: WSContext,
  terminalId: string,
  input?: string
): void {
  if (!input) return;

  const ptyManager = getPTYManager();
  const success = ptyManager.write(terminalId, input);

  if (!success) {
    ctx.send(ws, {
      type: 'terminalError',
      terminalId,
      data: { error: 'Terminal not found or write failed' }
    });
  }
}

function handleTerminalResize(
  _ctx: HandlerContext,
  terminalId: string,
  cols?: number,
  rows?: number
): void {
  if (!cols || !rows) return;

  const ptyManager = getPTYManager();
  ptyManager.resize(terminalId, cols, rows);
}

function handleTerminalClose(ctx: HandlerContext, ws: WSContext, terminalId: string): void {
  trackEvent(AnalyticsEvents.TERMINAL_SESSION_CLOSED);

  const listenerCleanup = ctx.terminalListenerCleanups.get(terminalId);
  if (listenerCleanup) {
    listenerCleanup();
    ctx.terminalListenerCleanups.delete(terminalId);
  }

  const ptyManager = getPTYManager();
  ptyManager.close(terminalId);

  ctx.terminalSubscribers.delete(terminalId);

  ctx.broadcastToOthers(ws, {
    type: 'terminalClosed',
    data: { terminalId }
  });
}

function addTerminalSubscriber(ctx: HandlerContext, terminalId: string, ws: WSContext): void {
  let subs = ctx.terminalSubscribers.get(terminalId);
  if (!subs) {
    subs = new Set();
    ctx.terminalSubscribers.set(terminalId, subs);
  }
  subs.add(ws);
}

function removeTerminalSubscriber(ctx: HandlerContext, terminalId: string, ws: WSContext): void {
  const subs = ctx.terminalSubscribers.get(terminalId);
  if (!subs) return;
  subs.delete(ws);
  if (subs.size > 0) return;
  ctx.terminalSubscribers.delete(terminalId);
  const cleanup = ctx.terminalListenerCleanups.get(terminalId);
  if (cleanup) {
    cleanup();
    ctx.terminalListenerCleanups.delete(terminalId);
  }
}

function setupTerminalBroadcastListeners(ctx: HandlerContext, terminalId: string): void {
  if (ctx.terminalListenerCleanups.has(terminalId)) return;

  const ptyManager = getPTYManager();

  const onOutput = (tid: string, data: string) => {
    if (tid === terminalId) {
      const subs = ctx.terminalSubscribers.get(terminalId);
      if (subs) {
        for (const ws of subs) {
          ctx.send(ws, { type: 'terminalOutput', terminalId, data: { output: data } });
        }
      }
    }
  };

  const onExit = (tid: string, exitCode: number) => {
    if (tid === terminalId) {
      const subs = ctx.terminalSubscribers.get(terminalId);
      if (subs) {
        for (const ws of subs) {
          ctx.send(ws, { type: 'terminalExit', terminalId, data: { exitCode } });
        }
      }
      ptyManager.off('output', onOutput);
      ptyManager.off('exit', onExit);
      ptyManager.off('error', onError);
      ctx.terminalListenerCleanups.delete(terminalId);
      ctx.terminalSubscribers.delete(terminalId);
    }
  };

  const onError = (tid: string, error: string) => {
    if (tid === terminalId) {
      const subs = ctx.terminalSubscribers.get(terminalId);
      if (subs) {
        for (const ws of subs) {
          ctx.send(ws, { type: 'terminalError', terminalId, data: { error } });
        }
      }
    }
  };

  ptyManager.on('output', onOutput);
  ptyManager.on('exit', onExit);
  ptyManager.on('error', onError);

  ctx.terminalListenerCleanups.set(terminalId, () => {
    ptyManager.off('output', onOutput);
    ptyManager.off('exit', onExit);
    ptyManager.off('error', onError);
  });
}

/**
 * Clean up terminal subscribers for a disconnected WS context.
 * Called from handler.ts handleClose().
 */
export function cleanupTerminalSubscribers(ctx: HandlerContext, ws: WSContext): void {
  for (const subs of ctx.terminalSubscribers.values()) {
    subs.delete(ws);
  }
}
