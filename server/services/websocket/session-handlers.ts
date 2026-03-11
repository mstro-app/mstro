// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ImprovisationSessionManager } from '../../cli/improvisation-session-manager.js';
import { getModel } from '../settings.js';
import type { HandlerContext } from './handler-context.js';
import type { SessionRegistry } from './session-registry.js';
import type { WebSocketMessage, WSContext } from './types.js';

/** Convert tool history entries into OutputLine-compatible lines */
function convertToolHistoryToLines(tools: any[], ts: number): any[] {
  const lines: any[] = [];
  for (const tool of tools) {
    lines.push({ type: 'tool-call', text: '', toolName: tool.toolName, toolInput: tool.toolInput || {}, timestamp: ts });
    if (tool.result !== undefined) {
      lines.push({ type: 'tool-result', text: '', toolResult: tool.result || 'No output', toolStatus: tool.isError ? 'error' : 'success', timestamp: ts });
    }
  }
  return lines;
}

/** Convert a single movement record into OutputLine-compatible entries */
function convertMovementToLines(movement: { userPrompt: string; timestamp: string; thinkingOutput?: string; toolUseHistory?: any[]; assistantResponse?: string; errorOutput?: string; tokensUsed: number; durationMs?: number }): any[] {
  const lines: any[] = [];
  const ts = new Date(movement.timestamp).getTime();

  lines.push({ type: 'user', text: movement.userPrompt, timestamp: ts });

  if (movement.thinkingOutput) {
    lines.push({ type: 'thinking', text: '', thinking: movement.thinkingOutput, timestamp: ts });
  }

  if (movement.toolUseHistory) {
    lines.push(...convertToolHistoryToLines(movement.toolUseHistory, ts));
  }

  if (movement.assistantResponse) {
    lines.push({ type: 'assistant', text: movement.assistantResponse, timestamp: ts });
  }

  if (movement.errorOutput) {
    lines.push({ type: 'error', text: `Error: ${movement.errorOutput}`, timestamp: ts });
  }

  const durationText = movement.durationMs
    ? `Completed in ${(movement.durationMs / 1000).toFixed(2)}s`
    : 'Completed';
  lines.push({ type: 'system', text: durationText, timestamp: ts });
  return lines;
}

function requireSession(ctx: HandlerContext, ws: WSContext, tabId: string): ImprovisationSessionManager {
  const session = getSession(ctx, ws, tabId);
  if (!session) throw new Error(`No session found for tab ${tabId}`);
  return session;
}

function getSession(ctx: HandlerContext, ws: WSContext, tabId: string): ImprovisationSessionManager | null {
  const tabMap = ctx.connections.get(ws);
  if (!tabMap) return null;

  const sessionId = tabMap.get(tabId);
  if (!sessionId) return null;

  return ctx.sessions.get(sessionId) || null;
}

export function buildOutputHistory(session: ImprovisationSessionManager): any[] {
  const history = session.getHistory();
  return history.movements.flatMap(convertMovementToLines);
}

export function setupSessionListeners(ctx: HandlerContext, session: ImprovisationSessionManager, ws: WSContext, tabId: string): void {
  session.removeAllListeners();

  session.on('onOutput', (text: string) => {
    ctx.send(ws, { type: 'output', tabId, data: { text, timestamp: Date.now() } });
  });

  session.on('onThinking', (text: string) => {
    ctx.send(ws, { type: 'thinking', tabId, data: { text } });
  });

  session.on('onMovementStart', (sequenceNumber: number, prompt: string) => {
    ctx.send(ws, { type: 'movementStart', tabId, data: { sequenceNumber, prompt, timestamp: Date.now(), executionStartTimestamp: session.executionStartTimestamp } });
    ctx.broadcastToAll({ type: 'tabStateChanged', data: { tabId, isExecuting: true, executionStartTimestamp: session.executionStartTimestamp } });
  });

  session.on('onMovementComplete', (movement: any) => {
    ctx.send(ws, { type: 'movementComplete', tabId, data: movement });

    const registry = ctx.getRegistry('');
    // Use a try/catch since getRegistry may not have been initialized with the right workingDir
    try { registry.markTabUnviewed(tabId); } catch { /* ignore */ }

    ctx.broadcastToAll({ type: 'tabStateChanged', data: { tabId, isExecuting: false, hasUnviewedCompletion: true } });

    if (ctx.usageReporter && movement.tokensUsed) {
      ctx.usageReporter({
        tokensUsed: movement.tokensUsed,
        sessionId: session.getSessionInfo().sessionId,
        movementId: `${movement.sequenceNumber}`
      });
    }
  });

  session.on('onMovementError', (error: Error) => {
    ctx.send(ws, { type: 'movementError', tabId, data: { message: error.message } });
    ctx.broadcastToAll({ type: 'tabStateChanged', data: { tabId, isExecuting: false } });
  });

  session.on('onSessionUpdate', (history: any) => {
    ctx.send(ws, { type: 'sessionUpdate', tabId, data: history });
  });

  session.on('onPlanNeedsConfirmation', (plan: any) => {
    ctx.send(ws, { type: 'approvalRequired', tabId, data: plan });
  });

  session.on('onToolUse', (event: any) => {
    ctx.send(ws, { type: 'toolUse', tabId, data: { ...event, timestamp: Date.now() } });
  });

  session.on('onTokenUsage', (usage: { inputTokens: number; outputTokens: number }) => {
    ctx.send(ws, { type: 'streamingTokens', tabId, data: usage });
  });
}

export function handleSessionMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, permission?: 'control' | 'view'): void {
  switch (msg.type) {
    case 'execute': {
      if (!msg.data?.prompt) throw new Error('Prompt is required');
      const session = requireSession(ctx, ws, tabId);
      const sandboxed = permission === 'control' || permission === 'view';
      const worktreeDir = ctx.gitDirectories.get(tabId);
      session.executePrompt(msg.data.prompt, msg.data.attachments, { sandboxed, workingDir: worktreeDir });
      break;
    }
    case 'cancel': {
      const session = requireSession(ctx, ws, tabId);
      session.cancel();
      break;
    }
    case 'getHistory': {
      const session = requireSession(ctx, ws, tabId);
      ctx.send(ws, { type: 'history', tabId, data: session.getHistory() });
      break;
    }
    case 'new': {
      const oldSession = requireSession(ctx, ws, tabId);
      const newSession = oldSession.startNewSession({ model: getModel() });
      setupSessionListeners(ctx, newSession, ws, tabId);
      const newSessionId = newSession.getSessionInfo().sessionId;
      ctx.sessions.set(newSessionId, newSession);
      const tabMap = ctx.connections.get(ws);
      if (tabMap) tabMap.set(tabId, newSessionId);
      const registry = ctx.getRegistry('');
      try { registry.updateTabSession(tabId, newSessionId); } catch { /* ignore */ }
      ctx.send(ws, { type: 'newSession', tabId, data: newSession.getSessionInfo() });
      break;
    }
    case 'approve': {
      const session = requireSession(ctx, ws, tabId);
      (session as any).respondToApproval?.(true);
      ctx.send(ws, { type: 'output', tabId, data: { text: '\n✅ Approved - proceeding with operation\n' } });
      break;
    }
    case 'reject': {
      const session = requireSession(ctx, ws, tabId);
      (session as any).respondToApproval?.(false);
      ctx.send(ws, { type: 'output', tabId, data: { text: '\n🚫 Rejected - operation cancelled\n' } });
      break;
    }
  }
}

export function handleHistoryMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  switch (msg.type) {
    case 'getSessions': {
      const result = getSessionsList(workingDir, msg.data?.limit ?? 20, msg.data?.offset ?? 0);
      ctx.send(ws, { type: 'sessions', tabId, data: result });
      break;
    }
    case 'getSessionsCount':
      ctx.send(ws, { type: 'sessionsCount', tabId, data: { total: getSessionsCount(workingDir) } });
      break;
    case 'getSessionById':
      if (!msg.data?.sessionId) throw new Error('Session ID is required');
      ctx.send(ws, { type: 'sessionData', tabId, data: getSessionById(workingDir, msg.data.sessionId) });
      break;
    case 'deleteSession':
      if (!msg.data?.sessionId) throw new Error('Session ID is required');
      ctx.send(ws, { type: 'sessionDeleted', tabId, data: deleteSession(workingDir, msg.data.sessionId) });
      break;
    case 'clearHistory':
      ctx.send(ws, { type: 'historyCleared', tabId, data: clearAllSessions(workingDir) });
      break;
    case 'searchHistory': {
      if (!msg.data?.query) throw new Error('Search query is required');
      const result = searchSessions(workingDir, msg.data.query, msg.data?.limit ?? 20, msg.data?.offset ?? 0);
      ctx.send(ws, { type: 'searchResults', tabId, data: { ...result, query: msg.data.query } });
      break;
    }
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

    try {
      const diskSession = ImprovisationSessionManager.resumeFromHistory(workingDir, registrySessionId);
      setupSessionListeners(ctx, diskSession, ws, tabId);
      const diskSessionId = diskSession.getSessionInfo().sessionId;
      ctx.sessions.set(diskSessionId, diskSession);
      if (tabMap) tabMap.set(tabId, diskSessionId);
      registry.touchTab(tabId);

      ctx.send(ws, {
        type: 'tabInitialized',
        tabId,
        data: {
          ...diskSession.getSessionInfo(),
          outputHistory: buildOutputHistory(diskSession),
        }
      });
      return;
    } catch {
      // Disk session not found — fall through to create new
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
  } catch (error: any) {
    console.warn(`[WebSocketImproviseHandler] Could not resume session ${historicalSessionId}: ${error.message}. Creating new session.`);
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
    }
  });
}

// ============================================
// History persistence functions
// ============================================

function getSessionsCount(workingDir: string): number {
  const sessionsDir = join(workingDir, '.mstro', 'history');
  if (!existsSync(sessionsDir)) return 0;
  return readdirSync(sessionsDir).filter((name: string) => name.endsWith('.json')).length;
}

function getSessionsList(workingDir: string, limit: number = 20, offset: number = 0): { sessions: any[]; total: number; hasMore: boolean } {
  const sessionsDir = join(workingDir, '.mstro', 'history');

  if (!existsSync(sessionsDir)) {
    return { sessions: [], total: 0, hasMore: false };
  }

  const historyFiles = readdirSync(sessionsDir)
    .filter((name: string) => name.endsWith('.json'))
    .sort((a: string, b: string) => {
      const timestampA = parseInt(a.replace('.json', ''), 10);
      const timestampB = parseInt(b.replace('.json', ''), 10);
      return timestampB - timestampA;
    });

  const total = historyFiles.length;
  const pageFiles = historyFiles.slice(offset, offset + limit);

  const sessions = pageFiles.map((filename: string) => {
    const historyPath = join(sessionsDir, filename);
    try {
      const historyData = JSON.parse(readFileSync(historyPath, 'utf-8'));
      const firstPrompt = historyData.movements?.[0]?.userPrompt || '';

      const movementPreviews = (historyData.movements || []).slice(0, 3).map((m: any) => ({
        userPrompt: m.userPrompt?.slice(0, 100) || ''
      }));

      return {
        sessionId: historyData.sessionId,
        startedAt: historyData.startedAt,
        lastActivityAt: historyData.lastActivityAt,
        totalTokens: historyData.totalTokens,
        movementCount: historyData.movements?.length || 0,
        title: firstPrompt.slice(0, 80) + (firstPrompt.length > 80 ? '...' : ''),
        movements: movementPreviews
      };
    } catch {
      return null;
    }
  }).filter(Boolean);

  return { sessions, total, hasMore: offset + limit < total };
}

function getSessionById(workingDir: string, sessionId: string): any {
  const sessionsDir = join(workingDir, '.mstro', 'history');
  if (!existsSync(sessionsDir)) return null;

  const historyFiles = readdirSync(sessionsDir).filter((name: string) => name.endsWith('.json'));

  for (const filename of historyFiles) {
    const historyPath = join(sessionsDir, filename);
    try {
      const historyData = JSON.parse(readFileSync(historyPath, 'utf-8'));
      if (historyData.sessionId === sessionId) {
        const firstPrompt = historyData.movements?.[0]?.userPrompt || '';
        return {
          sessionId: historyData.sessionId,
          startedAt: historyData.startedAt,
          lastActivityAt: historyData.lastActivityAt,
          totalTokens: historyData.totalTokens,
          movementCount: historyData.movements?.length || 0,
          title: firstPrompt.slice(0, 80) + (firstPrompt.length > 80 ? '...' : ''),
          movements: historyData.movements || [],
        };
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  return null;
}

function deleteSession(workingDir: string, sessionId: string): { sessionId: string; success: boolean } {
  const sessionsDir = join(workingDir, '.mstro', 'history');
  if (!existsSync(sessionsDir)) return { sessionId, success: false };

  try {
    const historyFiles = readdirSync(sessionsDir).filter((name: string) => name.endsWith('.json'));

    for (const filename of historyFiles) {
      const historyPath = join(sessionsDir, filename);
      try {
        const historyData = JSON.parse(readFileSync(historyPath, 'utf-8'));
        if (historyData.sessionId === sessionId) {
          unlinkSync(historyPath);
          return { sessionId, success: true };
        }
      } catch {
        // Skip files that can't be parsed
      }
    }

    return { sessionId, success: false };
  } catch (error) {
    console.error('[WebSocketImproviseHandler] Error deleting session:', error);
    return { sessionId, success: false };
  }
}

function clearAllSessions(workingDir: string): { success: boolean; deletedCount: number } {
  const sessionsDir = join(workingDir, '.mstro', 'history');
  if (!existsSync(sessionsDir)) return { success: true, deletedCount: 0 };

  try {
    const historyFiles = readdirSync(sessionsDir).filter((name: string) => name.endsWith('.json'));

    let deletedCount = 0;
    for (const filename of historyFiles) {
      const historyPath = join(sessionsDir, filename);
      try {
        unlinkSync(historyPath);
        deletedCount++;
      } catch {
        // Skip files that can't be deleted
      }
    }

    return { success: true, deletedCount };
  } catch (error) {
    console.error('[WebSocketImproviseHandler] Error clearing sessions:', error);
    return { success: false, deletedCount: 0 };
  }
}

function movementMatchesQuery(movements: any[] | undefined, lowerQuery: string): boolean {
  if (!movements) return false;
  return movements.some((m: any) =>
    m.userPrompt?.toLowerCase().includes(lowerQuery) ||
    m.summary?.toLowerCase().includes(lowerQuery) ||
    m.assistantResponse?.toLowerCase().includes(lowerQuery)
  );
}

function buildSessionSummary(historyData: any): any {
  const firstPrompt = historyData.movements?.[0]?.userPrompt || '';
  const movementPreviews = (historyData.movements || []).slice(0, 3).map((m: any) => ({
    userPrompt: m.userPrompt?.slice(0, 100) || ''
  }));
  return {
    sessionId: historyData.sessionId,
    startedAt: historyData.startedAt,
    lastActivityAt: historyData.lastActivityAt,
    totalTokens: historyData.totalTokens,
    movementCount: historyData.movements?.length || 0,
    title: firstPrompt.slice(0, 80) + (firstPrompt.length > 80 ? '...' : ''),
    movements: movementPreviews
  };
}

function searchSessions(workingDir: string, query: string, limit: number = 20, offset: number = 0): { sessions: any[]; total: number; hasMore: boolean } {
  const sessionsDir = join(workingDir, '.mstro', 'history');
  if (!existsSync(sessionsDir)) return { sessions: [], total: 0, hasMore: false };

  const lowerQuery = query.toLowerCase();

  try {
    const historyFiles = readdirSync(sessionsDir)
      .filter((name: string) => name.endsWith('.json'))
      .sort((a: string, b: string) => {
        const timestampA = parseInt(a.replace('.json', ''), 10);
        const timestampB = parseInt(b.replace('.json', ''), 10);
        return timestampB - timestampA;
      });

    const allMatches: any[] = [];
    for (const filename of historyFiles) {
      try {
        const content = readFileSync(join(sessionsDir, filename), 'utf-8');
        const historyData = JSON.parse(content);
        if (movementMatchesQuery(historyData.movements, lowerQuery)) {
          allMatches.push(buildSessionSummary(historyData));
        }
      } catch {
        // Skip files that can't be parsed
      }
    }

    const total = allMatches.length;
    return {
      sessions: allMatches.slice(offset, offset + limit),
      total,
      hasMore: offset + limit < total
    };
  } catch (error) {
    console.error('[WebSocketImproviseHandler] Error searching sessions:', error);
    return { sessions: [], total: 0, hasMore: false };
  }
}
