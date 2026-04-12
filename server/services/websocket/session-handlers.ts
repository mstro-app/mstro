// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import type { FileAttachment, ImprovisationSessionManager } from '../../cli/improvisation-session-manager.js';
import { getModel } from '../settings.js';
import type { HandlerContext } from './handler-context.js';
import { runQualityScan } from './quality-service.js';
import type { WebSocketMessage, WSContext } from './types.js';

// Re-export from extracted modules for backward compatibility
export { handleHistoryMessage } from './session-history.js';
export { initializeTab, resumeHistoricalSession } from './session-initialization.js';

const WRITE_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function movementHadWrites(movement: Record<string, unknown>): boolean {
  const history = movement.toolUseHistory as Array<{ toolName: string; result?: string; isError?: boolean }> | undefined;
  if (!history) return false;
  return history.some((t) => WRITE_TOOL_NAMES.has(t.toolName) && t.result !== undefined && !t.isError);
}

function triggerPostSessionQualityScan(ctx: HandlerContext, workingDir: string): void {
  runQualityScan(workingDir).then((results) => {
    ctx.broadcastToAll({
      type: 'qualityPostSession',
      data: { path: '.', results },
    });
  }).catch(() => {
    // Quality scan failure should not affect session flow
  });
}

/** Convert tool history entries into OutputLine-compatible lines */
function convertToolHistoryToLines(tools: Array<{ toolName: string; toolInput?: Record<string, unknown>; result?: string; isError?: boolean }>, ts: number): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    lines.push({ type: 'tool-call', text: '', toolName: tool.toolName, toolInput: tool.toolInput || {}, timestamp: ts });
    if (tool.result !== undefined) {
      lines.push({ type: 'tool-result', text: '', toolResult: tool.result || 'No output', toolStatus: tool.isError ? 'error' : 'success', timestamp: ts });
    }
  }
  return lines;
}

/** Convert a single movement record into OutputLine-compatible entries */
function convertMovementToLines(movement: { userPrompt: string; timestamp: string; thinkingOutput?: string; toolUseHistory?: Array<{ toolName: string; toolInput?: Record<string, unknown>; result?: string; isError?: boolean }>; assistantResponse?: string; errorOutput?: string; tokensUsed: number; durationMs?: number }): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
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

export function buildOutputHistory(session: ImprovisationSessionManager): Array<Record<string, unknown>> {
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

  session.on('onMovementStart', (sequenceNumber: number, prompt: string, isAutoContinue?: boolean) => {
    ctx.send(ws, { type: 'movementStart', tabId, data: { sequenceNumber, prompt, timestamp: Date.now(), executionStartTimestamp: session.executionStartTimestamp, isAutoContinue } });
    ctx.broadcastToAll({ type: 'tabStateChanged', data: { tabId, isExecuting: true, executionStartTimestamp: session.executionStartTimestamp } });
  });

  session.on('onMovementComplete', (movement: Record<string, unknown>) => {
    ctx.send(ws, { type: 'movementComplete', tabId, data: movement });

    const registry = ctx.getRegistry('');
    // Use a try/catch since getRegistry may not have been initialized with the right workingDir
    try { registry.markTabUnviewed(tabId); } catch { /* ignore */ }

    ctx.broadcastToAll({ type: 'tabStateChanged', data: { tabId, isExecuting: false, hasUnviewedCompletion: true } });

    if (ctx.usageReporter && movement.tokensUsed) {
      ctx.usageReporter({
        tokensUsed: movement.tokensUsed as number,
        sessionId: session.getSessionInfo().sessionId,
        movementId: `${movement.sequenceNumber}`
      });
    }

    // Post-session quality gate: if the session wrote/edited files, re-scan
    if (movementHadWrites(movement)) {
      const scanDir = ctx.gitDirectories.get(tabId) || session.getSessionInfo().workingDir;
      triggerPostSessionQualityScan(ctx, scanDir);
    }
  });

  session.on('onMovementError', (error: Error) => {
    ctx.send(ws, { type: 'movementError', tabId, data: { message: error.message } });
    ctx.broadcastToAll({ type: 'tabStateChanged', data: { tabId, isExecuting: false } });
  });

  session.on('onSessionUpdate', (history: Record<string, unknown>) => {
    ctx.send(ws, { type: 'sessionUpdate', tabId, data: history });
  });

  session.on('onPlanNeedsConfirmation', (plan: Record<string, unknown>) => {
    ctx.send(ws, { type: 'approvalRequired', tabId, data: plan });
  });

  session.on('onToolUse', (event: Record<string, unknown>) => {
    ctx.send(ws, { type: 'toolUse', tabId, data: { ...event, timestamp: Date.now() } });
  });

  session.on('onTokenUsage', (usage: { inputTokens: number; outputTokens: number }) => {
    ctx.send(ws, { type: 'streamingTokens', tabId, data: usage });
  });
}

/** Merge pre-uploaded files (from chunked upload) with any inline attachments */
function mergePreUploadedAttachments(ctx: HandlerContext, tabId: string, inlineAttachments?: FileAttachment[]): FileAttachment[] | undefined {
  if (!ctx.fileUploadHandler) return inlineAttachments;
  const preUploaded = ctx.fileUploadHandler.getAndClearCompletedUploads(tabId);
  if (preUploaded.length === 0) return inlineAttachments;

  const merged: (FileAttachment & { _preUploaded?: boolean })[] = [...(inlineAttachments || [])];
  for (const upload of preUploaded) {
    const alreadyIncluded = merged.some(a => a.fileName === upload.fileName);
    if (!alreadyIncluded) {
      merged.push({
        fileName: upload.fileName,
        filePath: upload.filePath,
        content: '',
        isImage: upload.isImage,
        mimeType: upload.mimeType,
        _preUploaded: true,
      });
    }
  }
  return merged;
}

const WRITE_OPS = new Set(['execute', 'cancel', 'new', 'approve', 'reject']);

export function handleSessionMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, permission?: 'view'): void {
  if (permission === 'view' && WRITE_OPS.has(msg.type)) {
    throw new Error('View-only users cannot perform write operations');
  }

  switch (msg.type) {
    case 'execute': {
      if (!msg.data?.prompt) throw new Error('Prompt is required');
      const session = requireSession(ctx, ws, tabId);
      const worktreeDir = ctx.gitDirectories.get(tabId);
      const attachments = mergePreUploadedAttachments(ctx, tabId, msg.data.attachments);
      session.executePrompt(msg.data.prompt, attachments, { workingDir: worktreeDir });
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
      const oldSessionId = oldSession.getSessionInfo().sessionId;
      const newSession = oldSession.startNewSession({ model: getModel() });
      oldSession.destroy();
      ctx.sessions.delete(oldSessionId);
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
      session.respondToApproval(true);
      ctx.send(ws, { type: 'output', tabId, data: { text: '\n✅ Approved - proceeding with operation\n' } });
      break;
    }
    case 'reject': {
      const session = requireSession(ctx, ws, tabId);
      session.respondToApproval(false);
      ctx.send(ws, { type: 'output', tabId, data: { text: '\n🚫 Rejected - operation cancelled\n' } });
      break;
    }
  }
}
