// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HandlerContext } from './handler-context.js';
import type { WebSocketMessage, WSContext } from './types.js';

export function handleHistoryMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  switch (msg.type) {
    case 'getSessions': {
      getSessionsList(workingDir, msg.data?.limit ?? 20, msg.data?.offset ?? 0).then(result => {
        ctx.send(ws, { type: 'sessions', tabId, data: result });
      });
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

function getSessionsCount(workingDir: string): number {
  const sessionsDir = join(workingDir, '.mstro', 'history');
  if (!existsSync(sessionsDir)) return 0;
  return readdirSync(sessionsDir).filter((name: string) => name.endsWith('.json')).length;
}

async function getSessionsList(workingDir: string, limit: number = 20, offset: number = 0): Promise<{ sessions: Array<Record<string, unknown> | null>; total: number; hasMore: boolean }> {
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

  const sessions = await Promise.all(pageFiles.map(async (filename: string) => {
    const historyPath = join(sessionsDir, filename);
    try {
      const raw = await readFile(historyPath, 'utf-8');
      return buildSessionSummary(JSON.parse(raw));
    } catch {
      return null;
    }
  }));

  return { sessions: sessions.filter(Boolean), total, hasMore: offset + limit < total };
}

function getSessionById(workingDir: string, sessionId: string): Record<string, unknown> | null {
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

function movementMatchesQuery(movements: Array<Record<string, unknown>> | undefined, lowerQuery: string): boolean {
  if (!movements) return false;
  return movements.some((m: Record<string, unknown>) =>
    (typeof m.userPrompt === 'string' && m.userPrompt.toLowerCase().includes(lowerQuery)) ||
    (typeof m.summary === 'string' && m.summary.toLowerCase().includes(lowerQuery)) ||
    (typeof m.assistantResponse === 'string' && m.assistantResponse.toLowerCase().includes(lowerQuery))
  );
}

function buildSessionSummary(historyData: Record<string, unknown>): Record<string, unknown> {
  const movements = historyData.movements as Array<Record<string, unknown>> | undefined;
  const firstPrompt = (typeof movements?.[0]?.userPrompt === 'string' ? movements[0].userPrompt : '') || '';
  const movementPreviews = (movements || []).slice(0, 3).map((m: Record<string, unknown>) => ({
    userPrompt: (typeof m.userPrompt === 'string' ? m.userPrompt : '').slice(0, 100) || ''
  }));
  return {
    sessionId: historyData.sessionId,
    startedAt: historyData.startedAt,
    lastActivityAt: historyData.lastActivityAt,
    totalTokens: historyData.totalTokens,
    movementCount: movements?.length || 0,
    title: firstPrompt.slice(0, 80) + (firstPrompt.length > 80 ? '...' : ''),
    movements: movementPreviews
  };
}

function searchSessions(workingDir: string, query: string, limit: number = 20, offset: number = 0): { sessions: Array<Record<string, unknown>>; total: number; hasMore: boolean } {
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

    const allMatches: Array<Record<string, unknown>> = [];
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
