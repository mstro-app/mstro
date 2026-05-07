// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import type { EtaProfile } from '../../cli/eta-estimator.js';
import { ImprovisationSessionManager } from '../../cli/improvisation-session-manager.js';
import { getEffortLevel, getModel } from '../settings.js';
import type { HandlerContext } from './handler-context.js';
import { buildOutputHistory, resolveEngineForSession, setupSessionListeners } from './session-handlers.js';
import type { SessionRegistry, TabEngineOverride } from './session-registry.js';
import { type ReplayResult, replayTabEventsSince } from './tab-event-replay.js';
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

/**
 * When the session is mid-execution, expose the cached eta profile so the
 * web's ComposingIndicator can render an ETA immediately on reconnect
 * instead of waiting for the next movementStart (which won't fire until
 * the user submits a fresh prompt).
 */
function inflightEtaPayload(session: ImprovisationSessionManager): { etaProfile?: EtaProfile } {
  if (session.isExecuting && session.etaProfile) return { etaProfile: session.etaProfile };
  return {};
}

/**
 * Build the full-snapshot data payload for a `tabInitialized` message.
 *
 * Used in three situations:
 *   1. Cold init (no `lastSeenSeq`) — web has no prior state to merge with.
 *   2. Cold reattach (existing session, no prior seq) — same shape.
 *   3. Replay-gap recovery — `replayTabEventsSince` returned `hadGap`, so
 *      the web's incremental state is provably stale; we replace it.
 *
 * `replayGap` flags the recovery case so the web can branch: drop any
 * already-rendered tab output and rebuild from `outputHistory` +
 * `executionEvents` instead of merging on top of stale incremental state.
 * Old web clients that don't know the flag still get the full snapshot and
 * render correctly — `replayGap` is purely additive telemetry.
 */
function buildFullSnapshotData(
  session: ImprovisationSessionManager,
  options: {
    worktreePath?: string;
    worktreeBranch?: string;
    engineOverride?: TabEngineOverride;
    replayGap?: boolean;
    extra?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const isExecuting = session.isExecuting;
  return {
    ...session.getSessionInfo(),
    engine: resolveEngineForSession(session),
    outputHistory: buildOutputHistory(session),
    isExecuting,
    ...(isExecuting ? { executionEvents: session.getExecutionEventLog() } : {}),
    ...(isExecuting && session.executionStartTimestamp
      ? { executionStartTimestamp: session.executionStartTimestamp }
      : {}),
    ...inflightEtaPayload(session),
    ...(options.worktreePath
      ? { worktreePath: options.worktreePath, worktreeBranch: options.worktreeBranch }
      : {}),
    ...(options.engineOverride ? { engineOverride: options.engineOverride } : {}),
    ...(options.replayGap ? { replayGap: true } : {}),
    ...(options.extra ?? {}),
  };
}

/**
 * Snapshot vs incremental decision based on the replay outcome.
 *
 * - `incremental`: the web should keep its current state and append the
 *   replayed events that already arrived (handled by `replayTabEventsSince`
 *   itself when there's no gap). We send `tabInitialized` with
 *   `resumedFromSeq: true`.
 * - `snapshot`: the web should discard tab output and rebuild from a full
 *   snapshot. Triggered either by `lastSeenSeq === undefined` (cold start)
 *   or by `result.hadGap` (replay would silently skip events).
 */
function decideRecoveryMode(
  result: ReplayResult,
  lastSeenSeq: number | undefined,
): 'incremental' | 'snapshot' {
  if (lastSeenSeq === undefined) return 'snapshot';
  if (result.hadGap) return 'snapshot';
  return 'incremental';
}

/**
 * Send `tabInitialized` for a resume path (`tryResumeFromDisk` /
 * `resumeHistoricalSession`). Picks the snapshot or incremental envelope
 * shape based on `mode` and threads any extra fields the caller needs to
 * carry (e.g. `resumeFailed`, worktree state, engine override).
 *
 * Extracted to keep the resume call sites flat — without this helper, each
 * caller pushes the function over the project's cognitive-complexity gate.
 */
function sendResumedTabInitialized(
  ctx: HandlerContext,
  ws: WSContext,
  tabId: string,
  session: ImprovisationSessionManager,
  mode: 'incremental' | 'snapshot',
  replay: ReplayResult,
  options: {
    worktreePath?: string;
    worktreeBranch?: string;
    engineOverride?: TabEngineOverride;
    extra?: Record<string, unknown>;
  } = {},
): void {
  const engine = resolveEngineForSession(session);
  if (mode === 'snapshot') {
    ctx.send(ws, {
      type: 'tabInitialized',
      tabId,
      engine,
      data: buildFullSnapshotData(session, {
        worktreePath: options.worktreePath,
        worktreeBranch: options.worktreeBranch,
        engineOverride: options.engineOverride,
        replayGap: replay.hadGap,
        extra: options.extra,
      }),
    });
    return;
  }
  ctx.send(ws, {
    type: 'tabInitialized',
    tabId,
    engine,
    data: {
      ...session.getSessionInfo(),
      engine,
      resumedFromSeq: true,
      ...(options.worktreePath
        ? { worktreePath: options.worktreePath, worktreeBranch: options.worktreeBranch }
        : {}),
      ...(options.engineOverride ? { engineOverride: options.engineOverride } : {}),
      ...(options.extra ?? {}),
    },
  });
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
    //
    // If `replayTabEventsSince` reports `hadGap`, no events were emitted and
    // we fall back to a full-snapshot `tabInitialized` so the web replaces
    // its (now-known-stale) incremental state instead of merging on top.
    const replay = replayTabEventsSince(ctx, ws, tabId, lastSeenSeq);
    const mode = decideRecoveryMode(replay, lastSeenSeq);

    sendResumedTabInitialized(ctx, ws, tabId, diskSession, mode, replay, {
      worktreePath,
      worktreeBranch,
      engineOverride: regTab?.engineOverride,
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
  const engine = resolveEngineForSession(session);
  // Mirror terminal-handlers.ts: broadcastToOthers, not broadcastToAll. The
  // requesting client already drove this initTab and will receive
  // `tabInitialized` below — echoing `tabCreated` back risks racing the
  // discovery handler during a flicker and producing a phantom tab.
  ctx.broadcastToOthers(ws, {
    type: 'tabCreated',
    engine,
    data: { tabId, tabName: registeredTab?.tabName || 'Chat', createdAt: registeredTab?.createdAt, order: registeredTab?.order, engine, sessionInfo: session.getSessionInfo() }
  });

  // Fresh session (no disk/memory predecessor) has nothing to replay,
  // but we still pass lastSeenSeq through so the web flag is consistent.
  // hadGap is impossible here (buffer is empty for a brand-new tab), but
  // route through `decideRecoveryMode` for uniformity with the resume paths.
  const replay = replayTabEventsSince(ctx, ws, tabId, lastSeenSeq);
  const mode = decideRecoveryMode(replay, lastSeenSeq);

  ctx.send(ws, {
    type: 'tabInitialized',
    tabId,
    engine,
    data: {
      ...session.getSessionInfo(),
      ...(mode === 'incremental' ? { resumedFromSeq: true } : {}),
      ...(replay.hadGap ? { replayGap: true } : {}),
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

  const replay = replayTabEventsSince(ctx, ws, tabId, lastSeenSeq);
  const mode = decideRecoveryMode(replay, lastSeenSeq);

  sendResumedTabInitialized(ctx, ws, tabId, session, mode, replay, {
    extra: {
      resumeFailed: isNewSession,
      originalSessionId: isNewSession ? historicalSessionId : undefined,
    },
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

  const inflightEta = inflightEtaPayload(session);
  const replay = replayTabEventsSince(ctx, ws, tabId, lastSeenSeq);
  const mode = decideRecoveryMode(replay, lastSeenSeq);

  // Fast path: the web already has local state (via Zustand) AND the replay
  // covered the gap cleanly — just replay the buffered events and tell the
  // client to skip the destructive reset in its tabInitialized handler.
  if (mode === 'incremental') {
    ctx.send(ws, {
      type: 'tabInitialized',
      tabId,
      data: {
        ...session.getSessionInfo(),
        resumedFromSeq: true,
        isExecuting: session.isExecuting,
        ...(session.isExecuting && session.executionStartTimestamp ? { executionStartTimestamp: session.executionStartTimestamp } : {}),
        ...inflightEta,
        ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
      }
    });
    return;
  }

  // Snapshot path: either cold-start reattach (no prior seq) or replay-gap
  // recovery (`hadGap=true`, no events sent). Both want a full snapshot so
  // the web rebuilds from `outputHistory` + `executionEvents`. The
  // `replayGap` flag distinguishes the two for telemetry — the wire
  // payload shape is otherwise identical.
  ctx.send(ws, {
    type: 'tabInitialized',
    tabId,
    engine: resolveEngineForSession(session),
    data: buildFullSnapshotData(session, {
      worktreePath,
      worktreeBranch,
      engineOverride: regTab?.engineOverride,
      replayGap: replay.hadGap,
    }),
  });
}
