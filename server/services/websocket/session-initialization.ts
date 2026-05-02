// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { ImprovisationSessionManager } from '../../cli/improvisation-session-manager.js';
import { getEffortLevel, getModel } from '../settings.js';
import type { HandlerContext } from './handler-context.js';
import { buildOutputHistory, setupSessionListeners } from './session-handlers.js';
import type { SessionRegistry } from './session-registry.js';
import { replayTabEventsSince } from './tab-event-replay.js';
import type { WSContext } from './types.js';

/**
 * Extract `lastSeenSeq` from an initTab/resumeSession data payload.
 *
 * Keeps the narrow-typing scoped to the initialization module instead of
 * leaking into the broader `HandlerContext`. Returns `undefined` for first
 * init (no replay needed) or malformed payloads (treated as first init —
 * safer than surfacing an error the user can't act on).
 */
function extractLastSeenSeq(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const candidate = (data as { lastSeenSeq?: unknown }).lastSeenSeq;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

function tryResumeFromDisk(
  ctx: HandlerContext,
  ws: WSContext,
  tabId: string,
  workingDir: string,
  registrySessionId: string,
  tabMap: Map<string, string> | undefined,
  registry: SessionRegistry,
  lastSeenSeq: number | undefined,
): boolean {
  try {
    const diskSession = ImprovisationSessionManager.resumeFromHistory(workingDir, registrySessionId);
    setupSessionListeners(ctx, diskSession, ws, tabId);
    const diskSessionId = diskSession.getSessionInfo().sessionId;
    ctx.sessions.set(diskSessionId, diskSession);
    if (tabMap) tabMap.set(tabId, diskSessionId);
    registry.touchTab(tabId);
    registry.markTabPersisted(tabId);

    // Restore worktree state from registry
    const regTab = registry.getTab(tabId);
    if (regTab?.worktreePath && !ctx.gitDirectories.has(tabId)) {
      ctx.gitDirectories.set(tabId, regTab.worktreePath);
      if (regTab.worktreeBranch) ctx.gitBranches.set(tabId, regTab.worktreeBranch);
    }
    const worktreePath = ctx.gitDirectories.get(tabId);
    const worktreeBranch = ctx.gitBranches.get(tabId);

    // Replay any tab-scoped events the web missed during the transport gap
    // BEFORE tabInitialized so they arrive in the right order. Web-side
    // handlers append; `tabInitialized` does NOT reset when `resumedFromSeq`
    // is set, preserving the replayed additions.
    replayTabEventsSince(ctx, ws, tabId, lastSeenSeq);

    ctx.send(ws, {
      type: 'tabInitialized',
      tabId,
      data: {
        ...diskSession.getSessionInfo(),
        ...(lastSeenSeq === undefined ? { outputHistory: buildOutputHistory(diskSession) } : { resumedFromSeq: true }),
        ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
      }
    });
    return true;
  } catch {
    return false;
  }
}

export async function initializeTab(ctx: HandlerContext, ws: WSContext, tabId: string, workingDir: string, tabName?: string, rawData?: unknown): Promise<void> {
  const tabMap = ctx.connections.get(ws);
  const registry = ctx.getRegistry(workingDir);
  const lastSeenSeq = extractLastSeenSeq(rawData);

  // 1. Check per-connection map (same WS reconnect)
  const existingSessionId = tabMap?.get(tabId);
  if (existingSessionId) {
    const existingSession = ctx.sessions.get(existingSessionId);
    if (existingSession) {
      reattachSession(ctx, existingSession, ws, tabId, registry, lastSeenSeq);
      return;
    }
  }

  // 2. Check session registry (cross-connection reattach)
  const registrySessionId = registry.getTabSession(tabId);
  if (registrySessionId) {
    const inMemorySession = ctx.sessions.get(registrySessionId);
    if (inMemorySession) {
      reattachSession(ctx, inMemorySession, ws, tabId, registry, lastSeenSeq);
      return;
    }

    if (tryResumeFromDisk(ctx, ws, tabId, workingDir, registrySessionId, tabMap, registry, lastSeenSeq)) {
      return;
    }
  }

  // 3. Create new session. If the tab is already registered (no file on
  // disk — tab is pending first prompt or file was deleted), reuse its
  // sessionId so the tab keeps its identity across restarts.
  const existingTab = registry.getTab(tabId);
  const session = new ImprovisationSessionManager({
    workingDir,
    ...(registrySessionId ? { sessionId: registrySessionId } : {}),
    model: getModel(),
    effortLevel: getEffortLevel(),
  });
  setupSessionListeners(ctx, session, ws, tabId);

  const sessionId = session.getSessionInfo().sessionId;
  ctx.sessions.set(sessionId, session);

  if (tabMap) {
    tabMap.set(tabId, sessionId);
  }

  registry.registerTab(tabId, sessionId, tabName || existingTab?.tabName);
  const registeredTab = registry.getTab(tabId);
  ctx.broadcastToAll({
    type: 'tabCreated',
    data: { tabId, tabName: registeredTab?.tabName || 'Chat', createdAt: registeredTab?.createdAt, order: registeredTab?.order, sessionInfo: session.getSessionInfo() }
  });

  // Fresh session (no disk/memory predecessor) has nothing to replay,
  // but we still pass lastSeenSeq through so the web flag is consistent.
  replayTabEventsSince(ctx, ws, tabId, lastSeenSeq);

  ctx.send(ws, {
    type: 'tabInitialized',
    tabId,
    data: {
      ...session.getSessionInfo(),
      ...(lastSeenSeq !== undefined ? { resumedFromSeq: true } : {}),
    }
  });
}

export async function resumeHistoricalSession(
  ctx: HandlerContext,
  ws: WSContext,
  tabId: string,
  workingDir: string,
  historicalSessionId: string,
  rawData?: unknown,
): Promise<void> {
  const tabMap = ctx.connections.get(ws);
  const registry = ctx.getRegistry(workingDir);
  const lastSeenSeq = extractLastSeenSeq(rawData);

  const existingSessionId = tabMap?.get(tabId);
  if (existingSessionId) {
    const existingSession = ctx.sessions.get(existingSessionId);
    if (existingSession) {
      reattachSession(ctx, existingSession, ws, tabId, registry, lastSeenSeq);
      return;
    }
  }

  const registrySessionId = registry.getTabSession(tabId);
  if (registrySessionId) {
    const inMemorySession = ctx.sessions.get(registrySessionId);
    if (inMemorySession) {
      reattachSession(ctx, inMemorySession, ws, tabId, registry, lastSeenSeq);
      return;
    }
  }

  let session: ImprovisationSessionManager;
  let isNewSession = false;

  try {
    session = ImprovisationSessionManager.resumeFromHistory(workingDir, historicalSessionId, { model: getModel(), effortLevel: getEffortLevel() });
  } catch (error: unknown) {
    console.warn(`[WebSocketImproviseHandler] Could not resume session ${historicalSessionId}: ${error instanceof Error ? error.message : String(error)}. Creating new session.`);
    session = new ImprovisationSessionManager({ workingDir, model: getModel(), effortLevel: getEffortLevel() });
    isNewSession = true;
  }

  setupSessionListeners(ctx, session, ws, tabId);

  const sessionId = session.getSessionInfo().sessionId;
  ctx.sessions.set(sessionId, session);

  if (tabMap) {
    tabMap.set(tabId, sessionId);
  }

  registry.registerTab(tabId, sessionId);

  replayTabEventsSince(ctx, ws, tabId, lastSeenSeq);

  ctx.send(ws, {
    type: 'tabInitialized',
    tabId,
    data: {
      ...session.getSessionInfo(),
      ...(lastSeenSeq === undefined ? { outputHistory: buildOutputHistory(session) } : { resumedFromSeq: true }),
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
  registry: SessionRegistry,
  lastSeenSeq: number | undefined,
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

  const worktreePath = ctx.gitDirectories.get(tabId);
  const worktreeBranch = ctx.gitBranches.get(tabId);

  // Fast path: the web already has local state (via Zustand), so just replay
  // anything newer than `lastSeenSeq` and tell the client to skip the
  // destructive reset in its tabInitialized handler.
  if (lastSeenSeq !== undefined) {
    replayTabEventsSince(ctx, ws, tabId, lastSeenSeq);
    ctx.send(ws, {
      type: 'tabInitialized',
      tabId,
      data: {
        ...session.getSessionInfo(),
        resumedFromSeq: true,
        isExecuting: session.isExecuting,
        ...(session.isExecuting && session.executionStartTimestamp ? { executionStartTimestamp: session.executionStartTimestamp } : {}),
        ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
      }
    });
    return;
  }

  // Cold-start reattach (no prior seq): send the full snapshot so the web
  // can rebuild from scratch.
  const outputHistory = buildOutputHistory(session);
  const executionEvents = session.isExecuting
    ? session.getExecutionEventLog()
    : undefined;

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
