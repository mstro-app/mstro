// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { ImprovisationSessionManager } from '../../cli/improvisation-session-manager.js';
import { getEffortLevel, getModel } from '../settings.js';
import type { HandlerContext } from './handler-context.js';
import { buildOutputHistory, resolveEngineForSession, setupSessionListeners } from './session-handlers.js';
import type { TabEngineOverride } from './session-registry.js';
import { DEFAULT_ENGINE_ID, type EngineId, type WebSocketMessage, type WSContext } from './types.js';

function buildActiveTabData(
  regTab: { tabName: string; createdAt: string; order: number; hasUnviewedCompletion?: boolean; sessionId: string; engineOverride?: TabEngineOverride },
  session: ImprovisationSessionManager,
  worktreePath: string | undefined,
  worktreeBranch: string | undefined,
): Record<string, unknown> {
  return {
    tabName: regTab.tabName,
    createdAt: regTab.createdAt,
    order: regTab.order,
    hasUnviewedCompletion: regTab.hasUnviewedCompletion,
    engine: resolveEngineForSession(session),
    sessionInfo: session.getSessionInfo(),
    isExecuting: session.isExecuting,
    outputHistory: buildOutputHistory(session),
    executionEvents: session.isExecuting ? session.getExecutionEventLog() : undefined,
    ...(session.isExecuting && session.executionStartTimestamp ? { executionStartTimestamp: session.executionStartTimestamp } : {}),
    ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
    ...(regTab.engineOverride ? { engineOverride: regTab.engineOverride } : {}),
  };
}

function buildInactiveTabData(
  regTab: { tabName: string; createdAt: string; order: number; hasUnviewedCompletion?: boolean; sessionId: string; engineOverride?: TabEngineOverride },
  worktreePath: string | undefined,
  worktreeBranch: string | undefined,
): Record<string, unknown> {
  return {
    tabName: regTab.tabName,
    createdAt: regTab.createdAt,
    order: regTab.order,
    hasUnviewedCompletion: regTab.hasUnviewedCompletion,
    engine: DEFAULT_ENGINE_ID,
    sessionId: regTab.sessionId,
    isExecuting: false,
    outputHistory: [],
    ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
    ...(regTab.engineOverride ? { engineOverride: regTab.engineOverride } : {}),
  };
}

export function handleGetActiveTabs(ctx: HandlerContext, ws: WSContext, workingDir: string): void {
  const registry = ctx.getRegistry(workingDir);
  const allTabs = registry.getAllTabs();

  const tabs: Record<string, unknown> = {};
  for (const [tabId, regTab] of Object.entries(allTabs)) {
    const session = ctx.sessions.get(regTab.sessionId);
    let worktreePath = ctx.gitDirectories.get(tabId);
    let worktreeBranch = ctx.gitBranches.get(tabId);
    if (!worktreePath && regTab.worktreePath) {
      worktreePath = regTab.worktreePath;
      worktreeBranch = regTab.worktreeBranch;
      ctx.gitDirectories.set(tabId, worktreePath);
      if (worktreeBranch) ctx.gitBranches.set(tabId, worktreeBranch);
    }
    tabs[tabId] = session
      ? buildActiveTabData(regTab, session, worktreePath, worktreeBranch)
      : buildInactiveTabData(regTab, worktreePath, worktreeBranch);
  }

  ctx.send(ws, { type: 'activeTabs', data: { tabs } });
}

export function handleSyncTabMeta(ctx: HandlerContext, _ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  const registry = ctx.getRegistry(workingDir);
  if (msg.data?.tabName) {
    registry.updateTabName(tabId, msg.data.tabName);
    ctx.broadcastToAll({
      type: 'tabRenamed',
      data: { tabId, tabName: msg.data.tabName }
    });
  }
}

export function handleRemoveTab(ctx: HandlerContext, _ws: WSContext, tabId: string, workingDir: string): void {
  const registry = ctx.getRegistry(workingDir);
  registry.unregisterTab(tabId);
  ctx.gitDirectories.delete(tabId);
  ctx.gitBranches.delete(tabId);
  ctx.tabEventBuffers.delete(tabId);
  ctx.msgIdTracker.forget(tabId);

  ctx.broadcastToAll({
    type: 'tabRemoved',
    data: { tabId }
  });
}

export function handleMarkTabViewed(ctx: HandlerContext, _ws: WSContext, tabId: string, workingDir: string): void {
  const registry = ctx.getRegistry(workingDir);
  registry.markTabViewed(tabId);

  ctx.broadcastToAll({
    type: 'tabViewed',
    data: { tabId }
  });
}

/**
 * Persist a per-tab engine override. `msg.data.override` is either a full
 * `{ engine, model, effortLevel }` payload or `null` to clear the override.
 * Persisted via the session registry so the override survives WebSocket
 * disconnects — the core guarantee of IS-019. Broadcasts the change to all
 * connected clients so multi-device sessions stay in sync.
 */
export function handleSetTabEngine(ctx: HandlerContext, _ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  const raw = msg.data?.override;
  let override: TabEngineOverride | null;
  if (raw === null || raw === undefined) {
    override = null;
  } else if (
    typeof raw === 'object' &&
    (raw.engine === 'claude-code' || raw.engine === 'opencode') &&
    typeof raw.model === 'string' && raw.model.length > 0 &&
    typeof raw.effortLevel === 'string' && raw.effortLevel.length > 0
  ) {
    override = { engine: raw.engine, model: raw.model, effortLevel: raw.effortLevel };
  } else {
    // Malformed payload — ignore rather than crash. The client will re-emit
    // from the canonical server-side value on the next reconnect.
    return;
  }

  const registry = ctx.getRegistry(workingDir);
  registry.updateTabEngineOverride(tabId, override);

  ctx.broadcastToAll({
    type: 'tabEngineOverride',
    tabId,
    data: { tabId, override },
  });
}

export async function handleCreateTab(ctx: HandlerContext, ws: WSContext, workingDir: string, tabName?: string, optimisticTabId?: string): Promise<void> {
  const registry = ctx.getRegistry(workingDir);

  const tabId = optimisticTabId || `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const existingSession = registry.getTabSession(tabId);
  if (existingSession) {
    const regTab = registry.getTab(tabId);
    const existingSessionObj = ctx.sessions.get(existingSession);
    const engine: EngineId = resolveEngineForSession(existingSessionObj);
    ctx.broadcastToAll({
      type: 'tabCreated',
      engine,
      data: {
        tabId,
        tabName: regTab?.tabName || 'Chat',
        createdAt: regTab?.createdAt,
        order: regTab?.order,
        engine,
        sessionInfo: existingSessionObj?.getSessionInfo(),
      }
    });
    return;
  }

  const session = new ImprovisationSessionManager({ workingDir, model: getModel(), effortLevel: getEffortLevel() });
  setupSessionListeners(ctx, session, ws, tabId);

  const sessionId = session.getSessionInfo().sessionId;
  ctx.sessions.set(sessionId, session);

  const tabMap = ctx.connections.get(ws);
  if (tabMap) tabMap.set(tabId, sessionId);

  registry.registerTab(tabId, sessionId, tabName);
  const registeredTab = registry.getTab(tabId);
  const engine: EngineId = resolveEngineForSession(session);

  ctx.broadcastToAll({
    type: 'tabCreated',
    engine,
    data: {
      tabId,
      tabName: registeredTab?.tabName || 'Chat',
      createdAt: registeredTab?.createdAt,
      order: registeredTab?.order,
      engine,
      sessionInfo: session.getSessionInfo(),
    }
  });

  ctx.send(ws, {
    type: 'tabInitialized',
    tabId,
    engine,
    data: session.getSessionInfo()
  });
}

export function handleReorderTabs(ctx: HandlerContext, _ws: WSContext, workingDir: string, tabOrder?: string[]): void {
  if (!Array.isArray(tabOrder)) return;
  const registry = ctx.getRegistry(workingDir);
  registry.reorderTabs(tabOrder);

  const allTabs = registry.getAllTabs();
  const orderMap = tabOrder
    .filter((id) => allTabs[id])
    .map((id) => ({ tabId: id, order: allTabs[id].order }));

  ctx.broadcastToAll({
    type: 'tabsReordered',
    data: { tabOrder: orderMap }
  });
}
