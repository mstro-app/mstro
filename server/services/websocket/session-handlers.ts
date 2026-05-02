// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { type FileAttachment, ImprovisationSessionManager } from '../../cli/improvisation-session-manager.js';
import { getEffortLevel, getModel } from '../settings.js';
import type { HandlerContext } from './handler-context.js';
import { runQualityScan } from './quality-service.js';
import type { SessionRegistry } from './session-registry.js';
import { resolveSkillPrompt } from './skill-handlers.js';
import { broadcastTabEvent } from './tab-broadcast.js';
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

function formatElapsedDuration(totalSeconds: number): string {
  const seconds = Math.floor(totalSeconds) % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const days = Math.floor(totalSeconds / 86400);
  if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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
    ? `Completed in ${formatElapsedDuration(movement.durationMs / 1000)}`
    : 'Completed';
  lines.push({ type: 'system', text: durationText, timestamp: ts });
  return lines;
}

function requireSession(ctx: HandlerContext, ws: WSContext, tabId: string): ImprovisationSessionManager {
  const session = resolveTabSession(ctx, ws, tabId);
  if (!session) throw new Error(`No session found for tab ${tabId}`);
  return session;
}

/**
 * Canonical tab → session resolver.
 *
 * Returns the `ImprovisationSessionManager` for `tabId`, attaching it to `ws`
 * if needed. Contract: after a successful return, the session is mapped in
 * `ctx.connections.get(ws)` and its event listeners are wired to this `ws`.
 *
 * Resolution order (cheapest first, each step caches for subsequent calls):
 *   1. Per-connection `tabMap` — the session is already attached to this `ws`.
 *   2. Registry + in-memory — another connection has the session loaded;
 *      re-attach listeners to this `ws` without re-reading disk.
 *   3. Registry + disk — session is persisted but not in memory (e.g. after
 *      a CLI restart); construct the manager from history and cache it.
 *
 * Returns `null` only when the tab is truly unknown (no registry entry AND
 * no history file). That is the only case where handlers should surface an
 * error to the caller — everything else self-heals so session ops never
 * race the `initTab` handshake.
 *
 * Also restores worktree bindings from the registry on miss so git/file ops
 * against this tab route to the correct directory even without initTab.
 */
export function resolveTabSession(ctx: HandlerContext, ws: WSContext, tabId: string): ImprovisationSessionManager | null {
  const tabMap = ctx.connections.get(ws);

  const mappedSessionId = tabMap?.get(tabId);
  if (mappedSessionId) {
    const session = ctx.sessions.get(mappedSessionId);
    if (session) return session;
  }

  const workingDir = ws._workingDir;
  if (!workingDir) return null;

  const registry = ctx.getRegistry(workingDir);
  const registrySessionId = registry.getTabSession(tabId);
  if (!registrySessionId) return null;

  const inMemorySession = ctx.sessions.get(registrySessionId);
  if (inMemorySession) {
    return attachSessionToConnection(ctx, ws, tabId, inMemorySession, registry);
  }

  try {
    const diskSession = ImprovisationSessionManager.resumeFromHistory(workingDir, registrySessionId);
    ctx.sessions.set(diskSession.getSessionInfo().sessionId, diskSession);
    registry.markTabPersisted(tabId);
    return attachSessionToConnection(ctx, ws, tabId, diskSession, registry);
  } catch {
    // History file doesn't exist — either the tab has never had a first
    // prompt (lazy persistence) or the file was deleted and the registry
    // hasn't been swept yet. Either way, construct a fresh session bound to
    // the registered sessionId so the tab keeps its identity.
    const freshSession = new ImprovisationSessionManager({
      workingDir,
      sessionId: registrySessionId,
      model: getModel(),
      effortLevel: getEffortLevel(),
    });
    ctx.sessions.set(freshSession.getSessionInfo().sessionId, freshSession);
    return attachSessionToConnection(ctx, ws, tabId, freshSession, registry);
  }
}

/** Wire listeners + update caches when a resolved session first attaches to this ws. */
function attachSessionToConnection(
  ctx: HandlerContext,
  ws: WSContext,
  tabId: string,
  session: ImprovisationSessionManager,
  registry: SessionRegistry,
): ImprovisationSessionManager {
  setupSessionListeners(ctx, session, ws, tabId);
  const tabMap = ctx.connections.get(ws);
  if (tabMap) tabMap.set(tabId, session.getSessionInfo().sessionId);
  registry.touchTab(tabId);
  restoreWorktreeFromRegistry(ctx, registry, tabId);
  return session;
}

/** Copy worktree bindings from the persistent registry into the live context. */
export function restoreWorktreeFromRegistry(ctx: HandlerContext, registry: SessionRegistry, tabId: string): void {
  if (ctx.gitDirectories.has(tabId)) return;
  const regTab = registry.getTab(tabId);
  if (!regTab?.worktreePath) return;
  ctx.gitDirectories.set(tabId, regTab.worktreePath);
  if (regTab.worktreeBranch) ctx.gitBranches.set(tabId, regTab.worktreeBranch);
}

export function buildOutputHistory(session: ImprovisationSessionManager): Array<Record<string, unknown>> {
  const history = session.getHistory();
  // Skip in-progress movements (durationMs == 0). Their state is replayed on
  // the web via executionEvents; including them here would emit a bogus
  // "Completed" marker and duplicate the user prompt that executionEvents
  // is about to replay.
  return history.movements
    .filter((m) => (m.durationMs ?? 0) > 0)
    .flatMap(convertMovementToLines);
}

/**
 * Wire session events to the WebSocket fan-out.
 *
 * All session-driven messages broadcast to `allConnections` rather than the
 * `ws` that called `initTab`/`execute`. The CLI has exactly one live socket
 * at a time (the platform relay), and `allConnections` is maintained by
 * `handleConnection`/`handleClose` — so a broadcast always lands on the
 * *current* relay socket, even after a reconnect, and is fanned out to every
 * paired web client by the platform.
 *
 * Sending to the captured `ws` was the prior shape and silently dropped
 * streaming output for any tab whose `setupSessionListeners` hadn't been
 * re-run after a relay reconnect (i.e. background tabs the user wasn't
 * actively viewing). The `tabStateChanged` events still fired — they were
 * already broadcast — so the tab's executing dot showed up but the actual
 * stream content (`output`/`thinking`/`toolUse`/...) went nowhere.
 *
 * `ws` is retained in the signature for symmetry with other handlers and to
 * keep the call sites unchanged.
 */
export function setupSessionListeners(ctx: HandlerContext, session: ImprovisationSessionManager, _ws: WSContext, tabId: string): void {
  session.removeAllListeners();

  session.on('onHistoryPersisted', () => {
    const registry = ctx.getRegistry('');
    try { registry.markTabPersisted(tabId); } catch { /* ignore */ }
  });

  session.on('onOutput', (text: string) => {
    broadcastTabEvent(ctx, tabId, 'output', { text, timestamp: Date.now() });
  });

  session.on('onThinking', (text: string) => {
    broadcastTabEvent(ctx, tabId, 'thinking', { text });
  });

  session.on('onMovementStart', (sequenceNumber: number, prompt: string, isAutoContinue?: boolean) => {
    broadcastTabEvent(ctx, tabId, 'movementStart', { sequenceNumber, prompt, timestamp: Date.now(), executionStartTimestamp: session.executionStartTimestamp, isAutoContinue });
    ctx.broadcastToAll({ type: 'tabStateChanged', data: { tabId, isExecuting: true, executionStartTimestamp: session.executionStartTimestamp } });
  });

  session.on('onMovementComplete', (movement: Record<string, unknown>) => {
    broadcastTabEvent(ctx, tabId, 'movementComplete', movement);

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
    broadcastTabEvent(ctx, tabId, 'movementError', { message: error.message });
    ctx.broadcastToAll({ type: 'tabStateChanged', data: { tabId, isExecuting: false } });
  });

  session.on('onSessionUpdate', (history: Record<string, unknown>) => {
    broadcastTabEvent(ctx, tabId, 'sessionUpdate', history);
  });

  session.on('onPlanNeedsConfirmation', (plan: Record<string, unknown>) => {
    broadcastTabEvent(ctx, tabId, 'approvalRequired', plan);
  });

  session.on('onToolUse', (event: Record<string, unknown>) => {
    broadcastTabEvent(ctx, tabId, 'toolUse', { ...event, timestamp: Date.now() });
  });

  session.on('onTokenUsage', (usage: { inputTokens: number; outputTokens: number }) => {
    broadcastTabEvent(ctx, tabId, 'streamingTokens', usage);
  });
}

/** Merge pre-uploaded files (from chunked upload) with any inline attachments */
export function mergePreUploadedAttachments(ctx: HandlerContext, tabId: string, inlineAttachments?: FileAttachment[]): FileAttachment[] | undefined {
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

function emitExecuteAck(ctx: HandlerContext, tabId: string, sessionId: string, msgId: string, duplicate = false): void {
  ctx.broadcastToAll({
    type: 'executeAck',
    tabId,
    data: duplicate ? { msgId, sessionId, duplicate: true } : { msgId, sessionId },
  });
}

/**
 * Handle an `execute` request: validate, dedupe on msgId, run the prompt,
 * and ack every paired web so their outbox drains.
 *
 * Extracted from `handleSessionMessage` to keep its cyclomatic complexity
 * within the biome threshold; the switch-body pattern was pushing past 15.
 */
function handleExecuteMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string): void {
  if (!msg.data?.prompt) throw new Error('Prompt is required');
  const session = requireSession(ctx, ws, tabId);
  const { sessionId } = session.getSessionInfo();
  const msgId = typeof msg.data.msgId === 'string' ? msg.data.msgId as string : undefined;

  // Idempotency: a web reconnect may replay the same msgId. Re-ack so its
  // outbox drains, but don't run the prompt a second time.
  if (msgId && !ctx.msgIdTracker.recordIfFirst(tabId, msgId)) {
    console.log(`[session] execute duplicate msgId=${msgId} tabId=${tabId} — re-acking without re-run`);
    emitExecuteAck(ctx, tabId, sessionId, msgId, /* duplicate */ true);
    return;
  }

  if (msgId) {
    console.log(`[session] execute accepted msgId=${msgId} tabId=${tabId} sessionId=${sessionId}`);
  }

  const worktreeDir = ctx.gitDirectories.get(tabId);
  const attachments = mergePreUploadedAttachments(ctx, tabId, msg.data.attachments);

  // Resolve slash commands (e.g. "/code-review") to their SKILL.md content.
  // Claude Code's -p headless mode doesn't support skills natively, so we
  // load the skill's instructions and pass them as the actual prompt.
  const rawPrompt = msg.data.prompt as string;
  const effectiveDir = worktreeDir || session.getSessionInfo().workingDir;
  const resolved = resolveSkillPrompt(rawPrompt, effectiveDir);

  session.executePrompt(
    resolved ? resolved.prompt : rawPrompt,
    attachments,
    {
      workingDir: worktreeDir,
      displayPrompt: resolved ? rawPrompt : undefined,
    },
  );

  // Ack AFTER enqueue so the web knows the CLI accepted the work.
  if (msgId) emitExecuteAck(ctx, tabId, sessionId, msgId);
}

function handleNewSessionMessage(ctx: HandlerContext, ws: WSContext, tabId: string): void {
  const oldSession = requireSession(ctx, ws, tabId);
  const oldSessionId = oldSession.getSessionInfo().sessionId;
  const newSession = oldSession.startNewSession({ model: getModel(), effortLevel: getEffortLevel() });
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
}

export function handleSessionMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, permission?: 'view'): void {
  if (permission === 'view' && WRITE_OPS.has(msg.type)) {
    throw new Error('View-only users cannot perform write operations');
  }

  switch (msg.type) {
    case 'execute':
      handleExecuteMessage(ctx, ws, msg, tabId);
      break;
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
    case 'new':
      handleNewSessionMessage(ctx, ws, tabId);
      break;
    case 'approve': {
      const session = requireSession(ctx, ws, tabId);
      session.respondToApproval(true);
      broadcastTabEvent(ctx, tabId, 'output', { text: '\n✅ Approved - proceeding with operation\n' });
      break;
    }
    case 'reject': {
      const session = requireSession(ctx, ws, tabId);
      session.respondToApproval(false);
      broadcastTabEvent(ctx, tabId, 'output', { text: '\n🚫 Rejected - operation cancelled\n' });
      break;
    }
  }
}
