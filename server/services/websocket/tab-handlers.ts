// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { ImprovisationSessionManager } from '../../cli/improvisation-session-manager.js';
import { getModel } from '../settings.js';
import type { HandlerContext } from './handler-context.js';
import { buildOutputHistory, setupSessionListeners } from './session-handlers.js';
import type { WebSocketMessage, WSContext } from './types.js';

function buildActiveTabData(
  regTab: { tabName: string; createdAt: string; order: number; hasUnviewedCompletion?: boolean; sessionId: string },
  session: ImprovisationSessionManager,
  worktreePath: string | undefined,
  worktreeBranch: string | undefined,
): Record<string, unknown> {
  return {
    tabName: regTab.tabName,
    createdAt: regTab.createdAt,
    order: regTab.order,
    hasUnviewedCompletion: regTab.hasUnviewedCompletion,
    sessionInfo: session.getSessionInfo(),
    isExecuting: session.isExecuting,
    outputHistory: buildOutputHistory(session),
    executionEvents: session.isExecuting ? session.getExecutionEventLog() : undefined,
    ...(session.isExecuting && session.executionStartTimestamp ? { executionStartTimestamp: session.executionStartTimestamp } : {}),
    ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
  };
}

function buildInactiveTabData(
  regTab: { tabName: string; createdAt: string; order: number; hasUnviewedCompletion?: boolean; sessionId: string },
  worktreePath: string | undefined,
  worktreeBranch: string | undefined,
): Record<string, unknown> {
  return {
    tabName: regTab.tabName,
    createdAt: regTab.createdAt,
    order: regTab.order,
    hasUnviewedCompletion: regTab.hasUnviewedCompletion,
    sessionId: regTab.sessionId,
    isExecuting: false,
    outputHistory: [],
    ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
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

export function handleSyncPromptText(ctx: HandlerContext, _ws: WSContext, msg: WebSocketMessage, tabId: string): void {
  if (typeof msg.data?.text !== 'string') return;
  ctx.broadcastToAll({
    type: 'promptTextSync',
    tabId,
    data: { tabId, text: msg.data.text }
  });
}

export function handleRemoveTab(ctx: HandlerContext, _ws: WSContext, tabId: string, workingDir: string): void {
  const registry = ctx.getRegistry(workingDir);
  registry.unregisterTab(tabId);
  ctx.gitDirectories.delete(tabId);
  ctx.gitBranches.delete(tabId);

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

export async function handleCreateTab(ctx: HandlerContext, ws: WSContext, workingDir: string, tabName?: string, optimisticTabId?: string): Promise<void> {
  const registry = ctx.getRegistry(workingDir);

  const tabId = optimisticTabId || `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const existingSession = registry.getTabSession(tabId);
  if (existingSession) {
    const regTab = registry.getTab(tabId);
    ctx.broadcastToAll({
      type: 'tabCreated',
      data: {
        tabId,
        tabName: regTab?.tabName || 'Chat',
        createdAt: regTab?.createdAt,
        order: regTab?.order,
        sessionInfo: ctx.sessions.get(existingSession)?.getSessionInfo(),
      }
    });
    return;
  }

  const session = new ImprovisationSessionManager({ workingDir, model: getModel() });
  setupSessionListeners(ctx, session, ws, tabId);

  const sessionId = session.getSessionInfo().sessionId;
  ctx.sessions.set(sessionId, session);

  const tabMap = ctx.connections.get(ws);
  if (tabMap) tabMap.set(tabId, sessionId);

  registry.registerTab(tabId, sessionId, tabName);
  const registeredTab = registry.getTab(tabId);

  ctx.broadcastToAll({
    type: 'tabCreated',
    data: {
      tabId,
      tabName: registeredTab?.tabName || 'Chat',
      createdAt: registeredTab?.createdAt,
      order: registeredTab?.order,
      sessionInfo: session.getSessionInfo(),
    }
  });

  ctx.send(ws, {
    type: 'tabInitialized',
    tabId,
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
