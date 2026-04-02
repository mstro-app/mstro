// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { ImprovisationSessionManager } from '../../cli/improvisation-session-manager.js';
import { getModel } from '../settings.js';
import type { HandlerContext } from './handler-context.js';
import { buildOutputHistory, setupSessionListeners } from './session-handlers.js';
import type { SessionRegistry } from './session-registry.js';
import type { WSContext } from './types.js';

function tryResumeFromDisk(
  ctx: HandlerContext,
  ws: WSContext,
  tabId: string,
  workingDir: string,
  registrySessionId: string,
  tabMap: Map<string, string> | undefined,
  registry: SessionRegistry
): boolean {
  try {
    const diskSession = ImprovisationSessionManager.resumeFromHistory(workingDir, registrySessionId);
    setupSessionListeners(ctx, diskSession, ws, tabId);
    const diskSessionId = diskSession.getSessionInfo().sessionId;
    ctx.sessions.set(diskSessionId, diskSession);
    if (tabMap) tabMap.set(tabId, diskSessionId);
    registry.touchTab(tabId);

    // Restore worktree state from registry
    const regTab = registry.getTab(tabId);
    if (regTab?.worktreePath && !ctx.gitDirectories.has(tabId)) {
      ctx.gitDirectories.set(tabId, regTab.worktreePath);
      if (regTab.worktreeBranch) ctx.gitBranches.set(tabId, regTab.worktreeBranch);
    }
    const worktreePath = ctx.gitDirectories.get(tabId);
    const worktreeBranch = ctx.gitBranches.get(tabId);

    ctx.send(ws, {
      type: 'tabInitialized',
      tabId,
      data: {
        ...diskSession.getSessionInfo(),
        outputHistory: buildOutputHistory(diskSession),
        ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
      }
    });
    return true;
  } catch {
    return false;
  }
}

export async function initializeTab(ctx: HandlerContext, ws: WSContext, tabId: string, workingDir: string, tabName?: string): Promise<void> {
  const tabMap = ctx.connections.get(ws);
  const registry = ctx.getRegistry(workingDir);

  // 1. Check per-connection map (same WS reconnect)
  const existingSessionId = tabMap?.get(tabId);
  if (existingSessionId) {
    const existingSession = ctx.sessions.get(existingSessionId);
    if (existingSession) {
      reattachSession(ctx, existingSession, ws, tabId, registry);
      return;
    }
  }

  // 2. Check session registry (cross-connection reattach)
  const registrySessionId = registry.getTabSession(tabId);
  if (registrySessionId) {
    const inMemorySession = ctx.sessions.get(registrySessionId);
    if (inMemorySession) {
      reattachSession(ctx, inMemorySession, ws, tabId, registry);
      return;
    }

    if (tryResumeFromDisk(ctx, ws, tabId, workingDir, registrySessionId, tabMap, registry)) {
      return;
    }
  }

  // 3. Create new session
  const session = new ImprovisationSessionManager({ workingDir, model: getModel() });
  setupSessionListeners(ctx, session, ws, tabId);

  const sessionId = session.getSessionInfo().sessionId;
  ctx.sessions.set(sessionId, session);

  if (tabMap) {
    tabMap.set(tabId, sessionId);
  }

  registry.registerTab(tabId, sessionId, tabName);
  const registeredTab = registry.getTab(tabId);
  ctx.broadcastToAll({
    type: 'tabCreated',
    data: { tabId, tabName: registeredTab?.tabName || 'Chat', createdAt: registeredTab?.createdAt, order: registeredTab?.order, sessionInfo: session.getSessionInfo() }
  });

  ctx.send(ws, {
    type: 'tabInitialized',
    tabId,
    data: session.getSessionInfo()
  });
}

export async function resumeHistoricalSession(
  ctx: HandlerContext,
  ws: WSContext,
  tabId: string,
  workingDir: string,
  historicalSessionId: string
): Promise<void> {
  const tabMap = ctx.connections.get(ws);
  const registry = ctx.getRegistry(workingDir);

  const existingSessionId = tabMap?.get(tabId);
  if (existingSessionId) {
    const existingSession = ctx.sessions.get(existingSessionId);
    if (existingSession) {
      reattachSession(ctx, existingSession, ws, tabId, registry);
      return;
    }
  }

  const registrySessionId = registry.getTabSession(tabId);
  if (registrySessionId) {
    const inMemorySession = ctx.sessions.get(registrySessionId);
    if (inMemorySession) {
      reattachSession(ctx, inMemorySession, ws, tabId, registry);
      return;
    }
  }

  let session: ImprovisationSessionManager;
  let isNewSession = false;

  try {
    session = ImprovisationSessionManager.resumeFromHistory(workingDir, historicalSessionId, { model: getModel() });
  } catch (error: unknown) {
    console.warn(`[WebSocketImproviseHandler] Could not resume session ${historicalSessionId}: ${error instanceof Error ? error.message : String(error)}. Creating new session.`);
    session = new ImprovisationSessionManager({ workingDir, model: getModel() });
    isNewSession = true;
  }

  setupSessionListeners(ctx, session, ws, tabId);

  const sessionId = session.getSessionInfo().sessionId;
  ctx.sessions.set(sessionId, session);

  if (tabMap) {
    tabMap.set(tabId, sessionId);
  }

  registry.registerTab(tabId, sessionId);

  ctx.send(ws, {
    type: 'tabInitialized',
    tabId,
    data: {
      ...session.getSessionInfo(),
      outputHistory: buildOutputHistory(session),
      resumeFailed: isNewSession,
      originalSessionId: isNewSession ? historicalSessionId : undefined
    }
  });
}

function reattachSession(
  ctx: HandlerContext,
  session: ImprovisationSessionManager,
  ws: WSContext,
  tabId: string,
  registry: SessionRegistry
): void {
  setupSessionListeners(ctx, session, ws, tabId);

  const tabMap = ctx.connections.get(ws);
  const sessionId = session.getSessionInfo().sessionId;
  if (tabMap) tabMap.set(tabId, sessionId);
  registry.touchTab(tabId);

  // Restore worktree state from registry if not already in memory
  const regTab = registry.getTab(tabId);
  if (regTab?.worktreePath && !ctx.gitDirectories.has(tabId)) {
    ctx.gitDirectories.set(tabId, regTab.worktreePath);
    if (regTab.worktreeBranch) ctx.gitBranches.set(tabId, regTab.worktreeBranch);
  }

  const outputHistory = buildOutputHistory(session);

  const executionEvents = session.isExecuting
    ? session.getExecutionEventLog()
    : undefined;

  const worktreePath = ctx.gitDirectories.get(tabId);
  const worktreeBranch = ctx.gitBranches.get(tabId);

  ctx.send(ws, {
    type: 'tabInitialized',
    tabId,
    data: {
      ...session.getSessionInfo(),
      outputHistory,
      isExecuting: session.isExecuting,
      executionEvents,
      ...(session.isExecuting && session.executionStartTimestamp ? { executionStartTimestamp: session.executionStartTimestamp } : {}),
      ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
    }
  });
}
