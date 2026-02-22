// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * WebSocket Handler for Improvisation Sessions
 *
 * Manages WebSocket connections for real-time improvisation sessions.
 * Integrates with ImprovisationSessionManager to execute Claude Code commands.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ImprovisationSessionManager } from '../../cli/improvisation-session-manager.js';
import { AnalyticsEvents, trackEvent } from '../analytics.js';
import {
  createDirectory,
  createFile,
  deleteFile,
  listDirectory,
  renameFile, 
  writeFile
} from '../files.js';
import { validatePathWithinWorkingDir } from '../pathUtils.js';
import { sanitizeEnvForSandbox } from '../sandbox-utils.js';
import { captureException } from '../sentry.js';
import { getModel, getPrBaseBranch, getSettings, setModel, setPrBaseBranch } from '../settings.js';
import { getPTYManager } from '../terminal/pty-manager.js';
import { AutocompleteService } from './autocomplete.js';
import { readFileContent } from './file-utils.js';
import { SessionRegistry } from './session-registry.js';
import type { FrecencyData, GitDirectorySetResponse, GitFileStatus, GitLogEntry, GitRepoInfo, GitReposDiscoveredResponse, GitStatusResponse, WebSocketMessage, WebSocketResponse, WSContext } from './types.js';

export interface UsageReport {
  tokensUsed: number;
  sessionId?: string;
  movementId?: string;
}

export type UsageReporter = (report: UsageReport) => void;

/** Convert a single movement record into OutputLine-compatible entries */
function convertMovementToLines(movement: { userPrompt: string; timestamp: string; thinkingOutput?: string; toolUseHistory?: any[]; assistantResponse?: string; errorOutput?: string; tokensUsed: number }): any[] {
  const lines: any[] = [];
  const ts = new Date(movement.timestamp).getTime();

  lines.push({ type: 'user', text: `> ${movement.userPrompt}`, timestamp: ts });

  if (movement.thinkingOutput) {
    lines.push({ type: 'thinking', text: '', thinking: movement.thinkingOutput, timestamp: ts });
  }

  if (movement.toolUseHistory) {
    for (const tool of movement.toolUseHistory) {
      lines.push({ type: 'tool-call', text: '', toolName: tool.toolName, toolInput: tool.toolInput || {}, timestamp: ts });
      if (tool.result !== undefined) {
        lines.push({ type: 'tool-result', text: '', toolResult: tool.result || 'No output', toolStatus: tool.isError ? 'error' : 'success', timestamp: ts });
      }
    }
  }

  if (movement.assistantResponse) {
    lines.push({ type: 'assistant', text: movement.assistantResponse, timestamp: ts });
  }

  if (movement.errorOutput) {
    lines.push({ type: 'error', text: `Error: ${movement.errorOutput}`, timestamp: ts });
  }

  lines.push({ type: 'system', text: `Command completed (tokens: ${movement.tokensUsed.toLocaleString()})`, timestamp: ts });
  return lines;
}

export class WebSocketImproviseHandler {
  private sessions: Map<string, ImprovisationSessionManager> = new Map();
  private connections: Map<WSContext, Map<string, string>> = new Map();
  private autocompleteService: AutocompleteService;
  private frecencyPath: string;
  private usageReporter: UsageReporter | null = null;
  /** Per-tab selected git directory (tabId -> directory path) */
  private gitDirectories: Map<string, string> = new Map();
  /** Persistent tab→session mapping that survives WS disconnections */
  private sessionRegistry: SessionRegistry | null = null;
  /** All connected WS contexts (for broadcasting to all clients) */
  private allConnections: Set<WSContext> = new Set();

  constructor() {
    this.frecencyPath = join(homedir(), '.mstro', 'autocomplete-frecency.json');
    const frecencyData = this.loadFrecencyData();
    this.autocompleteService = new AutocompleteService(frecencyData);
  }

  /**
   * Lazily initialize session registry for a working directory
   */
  private getRegistry(workingDir: string): SessionRegistry {
    if (!this.sessionRegistry) {
      this.sessionRegistry = new SessionRegistry(workingDir);
    }
    return this.sessionRegistry;
  }

  /**
   * Set the usage reporter callback for sending usage data to platform
   */
  setUsageReporter(reporter: UsageReporter): void {
    this.usageReporter = reporter;
  }

  /**
   * Load frecency data from disk
   */
  private loadFrecencyData(): FrecencyData {
    try {
      if (existsSync(this.frecencyPath)) {
        const data = readFileSync(this.frecencyPath, 'utf-8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('[WebSocketImproviseHandler] Error loading frecency data:', error);
    }
    return {};
  }

  /**
   * Save frecency data to disk
   */
  private saveFrecencyData(): void {
    try {
      const dir = dirname(this.frecencyPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.frecencyPath, JSON.stringify(this.autocompleteService.getFrecencyData(), null, 2));
    } catch (error) {
      console.error('[WebSocketImproviseHandler] Error saving frecency data:', error);
    }
  }

  /**
   * Record a file selection for frecency scoring
   */
  recordFileSelection(filePath: string): void {
    this.autocompleteService.recordFileSelection(filePath);
    this.saveFrecencyData();
  }

  /**
   * Handle new WebSocket connection
   */
  handleConnection(ws: WSContext, _workingDir: string): void {
    this.connections.set(ws, new Map());
    this.allConnections.add(ws);
  }

  /**
   * Handle incoming WebSocket message
   */
  async handleMessage(
    ws: WSContext,
    message: string,
    workingDir: string
  ): Promise<void> {
    try {
      const msg: WebSocketMessage = JSON.parse(message);
      const tabId = msg.tabId || 'default';
      // Extract sandbox permission injected by server relay (for sandboxed shared users)
      const permission = msg._permission;
      delete msg._permission;

      await this.dispatchMessage(ws, msg, tabId, workingDir, permission);
    } catch (error: any) {
      console.error('[WebSocketImproviseHandler] Error handling message:', error);
      captureException(error, { context: 'websocket.handleMessage' });
      this.send(ws, {
        type: 'error',
        data: { message: error.message }
      });
    }
  }

  /**
   * Dispatch a parsed message to the appropriate handler
   */
  private async dispatchMessage(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'control' | 'view'): Promise<void> {
    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong', tabId });
        return;
      case 'initTab':
        return void await this.initializeTab(ws, tabId, workingDir, msg.data?.tabName);
      case 'resumeSession':
        if (!msg.data?.historicalSessionId) throw new Error('Historical session ID is required');
        return void await this.resumeHistoricalSession(ws, tabId, workingDir, msg.data.historicalSessionId);
      case 'execute':
      case 'cancel':
      case 'getHistory':
      case 'new':
      case 'approve':
      case 'reject':
        return this.handleSessionMessage(ws, msg, tabId, permission);
      case 'getSessions':
      case 'getSessionsCount':
      case 'getSessionById':
      case 'deleteSession':
      case 'clearHistory':
      case 'searchHistory':
        return this.handleHistoryMessage(ws, msg, tabId, workingDir);
      case 'autocomplete':
      case 'readFile':
      case 'recordSelection':
      case 'requestNotificationSummary':
        return this.handleFileMessage(ws, msg, tabId, workingDir, permission);
      case 'terminalInit':
      case 'terminalReconnect':
      case 'terminalList':
      case 'terminalInput':
      case 'terminalResize':
      case 'terminalClose':
        return this.handleTerminalMessage(ws, msg, tabId, workingDir, permission);
      case 'listDirectory':
      case 'writeFile':
      case 'createFile':
      case 'createDirectory':
      case 'deleteFile':
      case 'renameFile':
      case 'notifyFileOpened':
        return this.handleFileExplorerMessage(ws, msg, tabId, workingDir, permission);
      case 'gitStatus':
      case 'gitStage':
      case 'gitUnstage':
      case 'gitCommit':
      case 'gitCommitWithAI':
      case 'gitPush':
      case 'gitLog':
      case 'gitDiscoverRepos':
      case 'gitSetDirectory':
      case 'gitGetRemoteInfo':
      case 'gitCreatePR':
      case 'gitGeneratePRDescription':
        return this.handleGitMessage(ws, msg, tabId, workingDir);
      // Session sync messages
      case 'getActiveTabs':
        return this.handleGetActiveTabs(ws, workingDir);
      case 'createTab':
        return void await this.handleCreateTab(ws, workingDir, msg.data?.tabName, msg.data?.optimisticTabId);
      case 'reorderTabs':
        return this.handleReorderTabs(ws, workingDir, msg.data?.tabOrder);
      case 'syncTabMeta':
        return this.handleSyncTabMeta(ws, msg, tabId, workingDir);
      case 'syncPromptText':
        return this.handleSyncPromptText(ws, msg, tabId);
      case 'removeTab':
        return this.handleRemoveTab(ws, tabId, workingDir);
      case 'markTabViewed':
        return this.handleMarkTabViewed(ws, tabId, workingDir);
      // Settings messages
      case 'getSettings':
        return this.handleGetSettings(ws);
      case 'updateSettings':
        return this.handleUpdateSettings(ws, msg);
      default:
        throw new Error(`Unknown message type: ${msg.type}`);
    }
  }

  /**
   * Handle session-related messages (execute, cancel, history, new, approve, reject)
   */
  private handleSessionMessage(ws: WSContext, msg: WebSocketMessage, tabId: string, permission?: 'control' | 'view'): void {
    switch (msg.type) {
      case 'execute': {
        if (!msg.data?.prompt) throw new Error('Prompt is required');
        const session = this.requireSession(ws, tabId);
        const sandboxed = permission === 'control' || permission === 'view';
        session.executePrompt(msg.data.prompt, msg.data.attachments, { sandboxed });
        break;
      }
      case 'cancel': {
        const session = this.requireSession(ws, tabId);
        session.cancel();
        break;
      }
      case 'getHistory': {
        const session = this.requireSession(ws, tabId);
        this.send(ws, { type: 'history', tabId, data: session.getHistory() });
        break;
      }
      case 'new': {
        const oldSession = this.requireSession(ws, tabId);
        const newSession = oldSession.startNewSession({ model: getModel() });
        this.setupSessionListeners(newSession, ws, tabId);
        const newSessionId = newSession.getSessionInfo().sessionId;
        this.sessions.set(newSessionId, newSession);
        const tabMap = this.connections.get(ws);
        if (tabMap) tabMap.set(tabId, newSessionId);
        // Update registry with new session ID
        if (this.sessionRegistry) {
          this.sessionRegistry.updateTabSession(tabId, newSessionId);
        }
        this.send(ws, { type: 'newSession', tabId, data: newSession.getSessionInfo() });
        break;
      }
      case 'approve': {
        const session = this.requireSession(ws, tabId);
        (session as any).respondToApproval?.(true);
        this.send(ws, { type: 'output', tabId, data: { text: '\n✅ Approved - proceeding with operation\n' } });
        break;
      }
      case 'reject': {
        const session = this.requireSession(ws, tabId);
        (session as any).respondToApproval?.(false);
        this.send(ws, { type: 'output', tabId, data: { text: '\n🚫 Rejected - operation cancelled\n' } });
        break;
      }
    }
  }

  /**
   * Handle history/session listing messages
   */
  private handleHistoryMessage(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
    switch (msg.type) {
      case 'getSessions': {
        const result = this.getSessionsList(workingDir, msg.data?.limit ?? 20, msg.data?.offset ?? 0);
        this.send(ws, { type: 'sessions', tabId, data: result });
        break;
      }
      case 'getSessionsCount':
        this.send(ws, { type: 'sessionsCount', tabId, data: { total: this.getSessionsCount(workingDir) } });
        break;
      case 'getSessionById':
        if (!msg.data?.sessionId) throw new Error('Session ID is required');
        this.send(ws, { type: 'sessionData', tabId, data: this.getSessionById(workingDir, msg.data.sessionId) });
        break;
      case 'deleteSession':
        if (!msg.data?.sessionId) throw new Error('Session ID is required');
        this.send(ws, { type: 'sessionDeleted', tabId, data: this.deleteSession(workingDir, msg.data.sessionId) });
        break;
      case 'clearHistory':
        this.send(ws, { type: 'historyCleared', tabId, data: this.clearAllSessions(workingDir) });
        break;
      case 'searchHistory': {
        if (!msg.data?.query) throw new Error('Search query is required');
        const result = this.searchSessions(workingDir, msg.data.query, msg.data?.limit ?? 20, msg.data?.offset ?? 0);
        this.send(ws, { type: 'searchResults', tabId, data: { ...result, query: msg.data.query } });
        break;
      }
    }
  }

  /**
   * Handle file-related messages (autocomplete, readFile, recordSelection, notifications)
   */
  private handleFileMessage(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'control' | 'view'): void {
    const isSandboxed = permission === 'control' || permission === 'view';
    switch (msg.type) {
      case 'autocomplete':
        if (!msg.data?.partialPath) throw new Error('Partial path is required');
        this.send(ws, { type: 'autocomplete', tabId, data: { completions: this.autocompleteService.getFileCompletions(msg.data.partialPath, workingDir) } });
        break;
      case 'readFile': {
        if (!msg.data?.filePath) throw new Error('File path is required');
        // Sandboxed users (control + view) can only read files within the project directory
        if (isSandboxed) {
          const validation = validatePathWithinWorkingDir(msg.data.filePath, workingDir);
          if (!validation.valid) {
            this.send(ws, { type: 'fileContent', tabId, data: { path: msg.data.filePath, fileName: msg.data.filePath.split('/').pop() || '', content: '', error: 'Sandboxed: path outside project directory' } });
            break;
          }
        }
        this.send(ws, { type: 'fileContent', tabId, data: readFileContent(msg.data.filePath, workingDir) });
        break;
      }
      case 'recordSelection':
        if (msg.data?.filePath) this.recordFileSelection(msg.data.filePath);
        break;
      case 'requestNotificationSummary':
        if (!msg.data?.prompt || !msg.data?.output) throw new Error('Prompt and output are required for notification summary');
        this.generateNotificationSummary(ws, tabId, msg.data.prompt, msg.data.output, workingDir);
        break;
    }
  }

  /**
   * Handle terminal messages
   */
  private handleTerminalMessage(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'control' | 'view'): void {
    const termId = msg.terminalId || tabId;
    switch (msg.type) {
      case 'terminalInit':
        this.handleTerminalInit(ws, termId, workingDir, msg.data?.shell, msg.data?.cols, msg.data?.rows, permission);
        break;
      case 'terminalReconnect':
        this.handleTerminalReconnect(ws, termId);
        break;
      case 'terminalList':
        this.handleTerminalList(ws);
        break;
      case 'terminalInput':
        this.handleTerminalInput(ws, termId, msg.data?.input);
        break;
      case 'terminalResize':
        this.handleTerminalResize(ws, termId, msg.data?.cols, msg.data?.rows);
        break;
      case 'terminalClose':
        this.handleTerminalClose(ws, termId);
        break;
    }
  }

  /**
   * Handle file explorer operations with success/error response pattern
   */
  private sendFileResult(ws: WSContext, type: WebSocketResponse['type'], tabId: string, result: any, successData?: Record<string, any>): void {
    const data = result.success
      ? { success: true, path: result.path, ...successData }
      : { success: false, path: result.path, error: result.error };
    this.send(ws, { type, tabId, data });
  }

  private handleListDirectory(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
    if (msg.data?.dirPath === undefined) throw new Error('Directory path is required');
    const result = listDirectory(msg.data.dirPath, workingDir, msg.data.showHidden ?? false);
    this.send(ws, { type: 'directoryListing', tabId, data: result.success ? { success: true, path: msg.data.dirPath, entries: result.entries } : { success: false, path: msg.data.dirPath, error: result.error } });
  }

  private handleWriteFile(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
    if (!msg.data?.filePath) throw new Error('File path is required');
    if (msg.data.content === undefined) throw new Error('Content is required');
    const result = writeFile(msg.data.filePath, msg.data.content, workingDir);
    this.sendFileResult(ws, 'fileWritten', tabId, result);
    if (result.success) {
      this.broadcastToOthers(ws, {
        type: 'fileContentChanged',
        data: { path: result.path, content: msg.data.content }
      });
    }
  }

  private handleCreateFile(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
    if (!msg.data?.filePath) throw new Error('File path is required');
    const result = createFile(msg.data.filePath, workingDir);
    this.sendFileResult(ws, 'fileCreated', tabId, result);
    if (result.success && result.path) {
      const name = result.path.split('/').pop() || 'unknown';
      this.broadcastToOthers(ws, {
        type: 'fileCreated',
        data: { path: result.path, name, size: 0, modifiedAt: new Date().toISOString() }
      });
    }
  }

  private handleCreateDirectory(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
    if (!msg.data?.dirPath) throw new Error('Directory path is required');
    const result = createDirectory(msg.data.dirPath, workingDir);
    this.sendFileResult(ws, 'directoryCreated', tabId, result);
    if (result.success && result.path) {
      const name = result.path.split('/').pop() || 'unknown';
      this.broadcastToOthers(ws, {
        type: 'directoryCreated',
        data: { path: result.path, name }
      });
    }
  }

  private handleDeleteFile(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
    if (!msg.data?.filePath) throw new Error('File path is required');
    const result = deleteFile(msg.data.filePath, workingDir);
    this.sendFileResult(ws, 'fileDeleted', tabId, result);
    if (result.success && result.path) {
      this.broadcastToOthers(ws, {
        type: 'fileDeleted',
        data: { path: result.path }
      });
    }
  }

  private handleRenameFile(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
    if (!msg.data?.oldPath) throw new Error('Old path is required');
    if (!msg.data?.newPath) throw new Error('New path is required');
    const result = renameFile(msg.data.oldPath, msg.data.newPath, workingDir);
    this.sendFileResult(ws, 'fileRenamed', tabId, result);
    if (result.success && result.path) {
      const name = result.path.split('/').pop() || 'unknown';
      this.broadcastToOthers(ws, {
        type: 'fileRenamed',
        data: { oldPath: msg.data.oldPath, newPath: result.path, name }
      });
    }
  }

  private handleNotifyFileOpened(ws: WSContext, msg: WebSocketMessage, workingDir: string): void {
    if (!msg.data?.filePath) return;
    const fileData = readFileContent(msg.data.filePath, workingDir);
    if (!fileData.error) {
      this.broadcastToOthers(ws, {
        type: 'fileOpened',
        data: {
          path: msg.data.filePath,
          fileName: fileData.fileName,
          content: fileData.content
        }
      });
    }
  }

  private handleFileExplorerMessage(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'control' | 'view'): void {
    const isSandboxed = permission === 'control' || permission === 'view';
    const handlers: Record<string, () => void> = {
      listDirectory: () => {
        // Sandboxed users can only list directories within the project
        if (isSandboxed && msg.data?.dirPath) {
          const validation = validatePathWithinWorkingDir(msg.data.dirPath, workingDir);
          if (!validation.valid) {
            this.send(ws, { type: 'directoryListing', tabId, data: { success: false, path: msg.data.dirPath, error: 'Sandboxed: path outside project directory' } });
            return;
          }
        }
        this.handleListDirectory(ws, msg, tabId, workingDir);
      },
      writeFile: () => this.handleWriteFile(ws, msg, tabId, workingDir),
      createFile: () => this.handleCreateFile(ws, msg, tabId, workingDir),
      createDirectory: () => this.handleCreateDirectory(ws, msg, tabId, workingDir),
      deleteFile: () => this.handleDeleteFile(ws, msg, tabId, workingDir),
      renameFile: () => this.handleRenameFile(ws, msg, tabId, workingDir),
      notifyFileOpened: () => this.handleNotifyFileOpened(ws, msg, workingDir),
    };
    handlers[msg.type]?.();
  }

  /**
   * Get a session or throw
   */
  private requireSession(ws: WSContext, tabId: string): ImprovisationSessionManager {
    const session = this.getSession(ws, tabId);
    if (!session) throw new Error(`No session found for tab ${tabId}`);
    return session;
  }

  /**
   * Set up event listeners for a session
   */
  private setupSessionListeners(session: ImprovisationSessionManager, ws: WSContext, tabId: string): void {
    // Remove any existing listeners to prevent duplicates on reattach/reconnect
    session.removeAllListeners();

    session.on('onOutput', (text: string) => {
      this.send(ws, { type: 'output', tabId, data: { text, timestamp: Date.now() } });
    });

    session.on('onThinking', (text: string) => {
      this.send(ws, { type: 'thinking', tabId, data: { text } });
    });

    session.on('onMovementStart', (sequenceNumber: number, prompt: string) => {
      this.send(ws, { type: 'movementStart', tabId, data: { sequenceNumber, prompt, timestamp: Date.now() } });
      // Broadcast execution state to ALL clients so tab indicators update
      // even if per-tab event subscriptions aren't ready yet (e.g., newly discovered tabs)
      this.broadcastToAll({ type: 'tabStateChanged', data: { tabId, isExecuting: true } });
    });

    session.on('onMovementComplete', (movement: any) => {
      this.send(ws, { type: 'movementComplete', tabId, data: movement });

      // Mark tab as having unviewed completion (persisted across CLI restarts)
      this.sessionRegistry?.markTabUnviewed(tabId);

      // Broadcast execution state + completion dot to ALL clients
      this.broadcastToAll({ type: 'tabStateChanged', data: { tabId, isExecuting: false, hasUnviewedCompletion: true } });

      // Report usage to platform if reporter is configured
      if (this.usageReporter && movement.tokensUsed) {
        this.usageReporter({
          tokensUsed: movement.tokensUsed,
          sessionId: session.getSessionInfo().sessionId,
          movementId: `${movement.sequenceNumber}`
        });
      }
    });

    session.on('onMovementError', (error: Error) => {
      this.send(ws, { type: 'movementError', tabId, data: { message: error.message } });
      // Broadcast execution stopped to ALL clients
      this.broadcastToAll({ type: 'tabStateChanged', data: { tabId, isExecuting: false } });
    });

    session.on('onSessionUpdate', (history: any) => {
      this.send(ws, { type: 'sessionUpdate', tabId, data: history });
    });

    session.on('onPlanNeedsConfirmation', (plan: any) => {
      this.send(ws, { type: 'approvalRequired', tabId, data: plan });
    });

    session.on('onToolUse', (event: any) => {
      this.send(ws, { type: 'toolUse', tabId, data: { ...event, timestamp: Date.now() } });
    });
  }

  /**
   * Resume a historical session for conversation continuity
   * Falls back to creating a new session if the historical session cannot be found
   * (e.g., server restarted before the session was saved to disk)
   */
  private async resumeHistoricalSession(
    ws: WSContext,
    tabId: string,
    workingDir: string,
    historicalSessionId: string
  ): Promise<void> {
    const tabMap = this.connections.get(ws);
    const registry = this.getRegistry(workingDir);

    // Check per-connection map first (same WS reconnect)
    const existingSessionId = tabMap?.get(tabId);
    if (existingSessionId) {
      const existingSession = this.sessions.get(existingSessionId);
      if (existingSession) {
        this.reattachSession(existingSession, ws, tabId, registry);
        return;
      }
    }

    // Check session registry (cross-connection reattach)
    const registrySessionId = registry.getTabSession(tabId);
    if (registrySessionId) {
      const inMemorySession = this.sessions.get(registrySessionId);
      if (inMemorySession) {
        this.reattachSession(inMemorySession, ws, tabId, registry);
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

    this.setupSessionListeners(session, ws, tabId);

    const sessionId = session.getSessionInfo().sessionId;
    this.sessions.set(sessionId, session);

    if (tabMap) {
      tabMap.set(tabId, sessionId);
    }

    registry.registerTab(tabId, sessionId);

    this.send(ws, {
      type: 'tabInitialized',
      tabId,
      data: {
        ...session.getSessionInfo(),
        outputHistory: this.buildOutputHistory(session),
        resumeFailed: isNewSession,
        originalSessionId: isNewSession ? historicalSessionId : undefined
      }
    });
  }

  /**
   * Initialize a tab with its own session.
   * Checks (in order): per-connection map → session registry → disk history → new session.
   */
  private async initializeTab(ws: WSContext, tabId: string, workingDir: string, tabName?: string): Promise<void> {
    const tabMap = this.connections.get(ws);
    const registry = this.getRegistry(workingDir);

    // 1. Check per-connection map (same WS reconnect)
    const existingSessionId = tabMap?.get(tabId);
    if (existingSessionId) {
      const existingSession = this.sessions.get(existingSessionId);
      if (existingSession) {
        this.reattachSession(existingSession, ws, tabId, registry);
        return;
      }
    }

    // 2. Check session registry (cross-connection reattach, e.g. browser refresh)
    const registrySessionId = registry.getTabSession(tabId);
    if (registrySessionId) {
      // Try in-memory first
      const inMemorySession = this.sessions.get(registrySessionId);
      if (inMemorySession) {
        this.reattachSession(inMemorySession, ws, tabId, registry);
        return;
      }

      // Try resuming from disk
      try {
        const diskSession = ImprovisationSessionManager.resumeFromHistory(workingDir, registrySessionId);
        this.setupSessionListeners(diskSession, ws, tabId);
        const diskSessionId = diskSession.getSessionInfo().sessionId;
        this.sessions.set(diskSessionId, diskSession);
        if (tabMap) tabMap.set(tabId, diskSessionId);
        registry.touchTab(tabId);

        this.send(ws, {
          type: 'tabInitialized',
          tabId,
          data: {
            ...diskSession.getSessionInfo(),
            outputHistory: this.buildOutputHistory(diskSession),
          }
        });
        return;
      } catch {
        // Disk session not found — fall through to create new
      }
    }

    // 3. Create new session
    const session = new ImprovisationSessionManager({ workingDir, model: getModel() });
    this.setupSessionListeners(session, ws, tabId);

    const sessionId = session.getSessionInfo().sessionId;
    this.sessions.set(sessionId, session);

    if (tabMap) {
      tabMap.set(tabId, sessionId);
    }

    registry.registerTab(tabId, sessionId, tabName);
    const registeredTab = registry.getTab(tabId);
    this.broadcastToAll({
      type: 'tabCreated',
      data: { tabId, tabName: registeredTab?.tabName || 'Chat', createdAt: registeredTab?.createdAt, order: registeredTab?.order, sessionInfo: session.getSessionInfo() }
    });

    this.send(ws, {
      type: 'tabInitialized',
      tabId,
      data: session.getSessionInfo()
    });
  }

  /**
   * Reattach to an existing in-memory session.
   * Sends output history (completed movements + in-progress events) for state restoration.
   */
  private reattachSession(
    session: ImprovisationSessionManager,
    ws: WSContext,
    tabId: string,
    registry: SessionRegistry
  ): void {
    this.setupSessionListeners(session, ws, tabId);

    const tabMap = this.connections.get(ws);
    const sessionId = session.getSessionInfo().sessionId;
    if (tabMap) tabMap.set(tabId, sessionId);
    registry.touchTab(tabId);

    // Build output history from completed movements
    const outputHistory = this.buildOutputHistory(session);

    // If currently executing, append in-progress events
    const executionEvents = session.isExecuting
      ? session.getExecutionEventLog()
      : undefined;

    this.send(ws, {
      type: 'tabInitialized',
      tabId,
      data: {
        ...session.getSessionInfo(),
        outputHistory,
        isExecuting: session.isExecuting,
        executionEvents,
      }
    });
  }

  /**
   * Build OutputLine-compatible history from a session's completed movements.
   * Converts MovementRecords into the same format the web client uses for display.
   */
  private buildOutputHistory(session: ImprovisationSessionManager): any[] {
    const history = session.getHistory();
    return history.movements.flatMap(convertMovementToLines);
  }

  /**
   * Send a message to all connected clients EXCEPT the sender.
   * Used for multi-client sync (e.g., tab created by one client, others should know).
   */
  private broadcastToOthers(sender: WSContext, response: WebSocketResponse): void {
    for (const ws of this.allConnections) {
      if (ws !== sender) {
        this.send(ws, response);
      }
    }
  }

  /**
   * Send a message to ALL connected clients (including sender).
   */
  private broadcastToAll(response: WebSocketResponse): void {
    for (const ws of this.allConnections) {
      this.send(ws, response);
    }
  }

  // ========== Settings Handlers ==========

  /**
   * Return current machine-wide settings to the requesting client.
   */
  private handleGetSettings(ws: WSContext): void {
    this.send(ws, { type: 'settings', data: getSettings() });
  }

  /**
   * Update settings and broadcast to all connected clients.
   */
  private handleUpdateSettings(_ws: WSContext, msg: WebSocketMessage): void {
    if (msg.data?.model !== undefined) {
      setModel(msg.data.model);
    }
    this.broadcastToAll({ type: 'settingsUpdated', data: getSettings() });
  }

  /**
   * Get session for a specific tab
   */
  private getSession(ws: WSContext, tabId: string): ImprovisationSessionManager | null {
    const tabMap = this.connections.get(ws);
    if (!tabMap) return null;

    const sessionId = tabMap.get(tabId);
    if (!sessionId) return null;

    return this.sessions.get(sessionId) || null;
  }

  /**
   * Handle connection close
   * Note: Sessions are NOT destroyed — they persist for reconnection.
   * Only the per-connection tab mapping is removed.
   */
  handleClose(ws: WSContext): void {
    this.connections.delete(ws);
    this.allConnections.delete(ws);

    // Remove ws from all terminal subscriber sets
    for (const subs of this.terminalSubscribers.values()) {
      subs.delete(ws);
    }
  }

  /**
   * Send message to WebSocket client
   */
  private send(ws: WSContext, response: WebSocketResponse): void {
    try {
      ws.send(JSON.stringify(response));
    } catch (error) {
      console.error('[WebSocketImproviseHandler] Error sending message:', error);
    }
  }

  /**
   * Get count of all historical sessions without reading file contents
   */
  private getSessionsCount(workingDir: string): number {
    const sessionsDir = join(workingDir, '.mstro', 'history');

    if (!existsSync(sessionsDir)) {
      return 0;
    }

    return readdirSync(sessionsDir)
      .filter((name: string) => name.endsWith('.json'))
      .length;
  }

  /**
   * Get paginated list of historical sessions from disk
   * Returns minimal metadata - movements are stripped to just userPrompt preview
   */
  private getSessionsList(workingDir: string, limit: number = 20, offset: number = 0): { sessions: any[]; total: number; hasMore: boolean } {
    const sessionsDir = join(workingDir, '.mstro', 'history');

    if (!existsSync(sessionsDir)) {
      return { sessions: [], total: 0, hasMore: false };
    }

    // Get sorted file list (newest first) without reading contents
    const historyFiles = readdirSync(sessionsDir)
      .filter((name: string) => name.endsWith('.json'))
      .sort((a: string, b: string) => {
        const timestampA = parseInt(a.replace('.json', ''), 10);
        const timestampB = parseInt(b.replace('.json', ''), 10);
        return timestampB - timestampA;
      });

    const total = historyFiles.length;

    // Only read the files we need for this page
    const pageFiles = historyFiles.slice(offset, offset + limit);

    const sessions = pageFiles.map((filename: string) => {
      const historyPath = join(sessionsDir, filename);
      try {
        const historyData = JSON.parse(readFileSync(historyPath, 'utf-8'));
        const firstPrompt = historyData.movements?.[0]?.userPrompt || '';

        // Return minimal metadata - only prompt previews, not full movement data
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

    return {
      sessions,
      total,
      hasMore: offset + limit < total
    };
  }

  /**
   * Get a full session by ID (includes all movement data)
   */
  private getSessionById(workingDir: string, sessionId: string): any {
    const sessionsDir = join(workingDir, '.mstro', 'history');

    if (!existsSync(sessionsDir)) {
      return null;
    }

    const historyFiles = readdirSync(sessionsDir)
      .filter((name: string) => name.endsWith('.json'));

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

  /**
   * Delete a single session from disk
   */
  private deleteSession(workingDir: string, sessionId: string): { sessionId: string; success: boolean } {
    const sessionsDir = join(workingDir, '.mstro', 'history');

    if (!existsSync(sessionsDir)) {
      return { sessionId, success: false };
    }

    try {
      const historyFiles = readdirSync(sessionsDir)
        .filter((name: string) => name.endsWith('.json'));

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

  /**
   * Clear all sessions from disk
   */
  private clearAllSessions(workingDir: string): { success: boolean; deletedCount: number } {
    const sessionsDir = join(workingDir, '.mstro', 'history');

    if (!existsSync(sessionsDir)) {
      return { success: true, deletedCount: 0 };
    }

    try {
      const historyFiles = readdirSync(sessionsDir)
        .filter((name: string) => name.endsWith('.json'));

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

  /**
   * Search sessions using grep on the history directory
   * Searches through session file contents for matching text
   * Returns paginated results with minimal metadata
   */
  private movementMatchesQuery(movements: any[] | undefined, lowerQuery: string): boolean {
    if (!movements) return false;
    return movements.some((m: any) =>
      m.userPrompt?.toLowerCase().includes(lowerQuery) ||
      m.summary?.toLowerCase().includes(lowerQuery) ||
      m.assistantResponse?.toLowerCase().includes(lowerQuery)
    );
  }

  private buildSessionSummary(historyData: any): any {
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

  private searchSessions(workingDir: string, query: string, limit: number = 20, offset: number = 0): { sessions: any[]; total: number; hasMore: boolean } {
    const sessionsDir = join(workingDir, '.mstro', 'history');

    if (!existsSync(sessionsDir)) {
      return { sessions: [], total: 0, hasMore: false };
    }

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
          if (this.movementMatchesQuery(historyData.movements, lowerQuery)) {
            allMatches.push(this.buildSessionSummary(historyData));
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

  /**
   * Cleanup session
   */
  cleanupSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Clean up stale sessions
   */
  cleanupStaleSessions(): void {
  }

  // ============================================
  // Session sync methods
  // ============================================

  /**
   * Handle getActiveTabs — returns all registered tabs and their state.
   * Used by new clients (multi-device, multi-browser) to discover existing tabs.
   */
  private handleGetActiveTabs(ws: WSContext, workingDir: string): void {
    const registry = this.getRegistry(workingDir);
    const allTabs = registry.getAllTabs();

    const tabs: Record<string, any> = {};
    for (const [tabId, regTab] of Object.entries(allTabs)) {
      const session = this.sessions.get(regTab.sessionId);
      if (session) {
        tabs[tabId] = {
          tabName: regTab.tabName,
          createdAt: regTab.createdAt,
          order: regTab.order,
          hasUnviewedCompletion: regTab.hasUnviewedCompletion,
          sessionInfo: session.getSessionInfo(),
          isExecuting: session.isExecuting,
          outputHistory: this.buildOutputHistory(session),
          executionEvents: session.isExecuting ? session.getExecutionEventLog() : undefined,
        };
      } else {
        // Session not in memory — try to provide basic info from registry
        tabs[tabId] = {
          tabName: regTab.tabName,
          createdAt: regTab.createdAt,
          order: regTab.order,
          hasUnviewedCompletion: regTab.hasUnviewedCompletion,
          sessionId: regTab.sessionId,
          isExecuting: false,
          outputHistory: [],
        };
      }
    }

    this.send(ws, { type: 'activeTabs', data: { tabs } });
  }

  /**
   * Handle syncTabMeta — update tab metadata (name) from a client.
   */
  private handleSyncTabMeta(_ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
    const registry = this.getRegistry(workingDir);
    if (msg.data?.tabName) {
      registry.updateTabName(tabId, msg.data.tabName);
      // Broadcast rename to all clients (relay handles fan-out)
      this.broadcastToAll({
        type: 'tabRenamed',
        data: { tabId, tabName: msg.data.tabName }
      });
    }
  }

  /**
   * Handle syncPromptText — relay prompt text changes to all clients.
   * Ephemeral: not persisted, just broadcast for live collaboration.
   */
  private handleSyncPromptText(_ws: WSContext, msg: WebSocketMessage, tabId: string): void {
    if (typeof msg.data?.text !== 'string') return;
    this.broadcastToAll({
      type: 'promptTextSync',
      tabId,
      data: { tabId, text: msg.data.text }
    });
  }

  /**
   * Handle removeTab — client is removing a tab.
   */
  private handleRemoveTab(_ws: WSContext, tabId: string, workingDir: string): void {
    const registry = this.getRegistry(workingDir);
    registry.unregisterTab(tabId);

    // Broadcast to all clients (broadcastToAll ensures relay-connected clients receive it)
    this.broadcastToAll({
      type: 'tabRemoved',
      data: { tabId }
    });
  }

  /**
   * Handle markTabViewed — a client has viewed a tab's completed output.
   * Persists viewed state and broadcasts to all clients so the green dot
   * disappears on every device.
   */
  private handleMarkTabViewed(_ws: WSContext, tabId: string, workingDir: string): void {
    const registry = this.getRegistry(workingDir);
    registry.markTabViewed(tabId);

    this.broadcastToAll({
      type: 'tabViewed',
      data: { tabId }
    });
  }

  /**
   * Handle createTab — CLI registers the tab and broadcasts to all clients.
   *
   * When optimisticTabId is provided, CLI reuses that ID as the authoritative tab ID.
   * The requesting client already created a local tab with this ID (optimistic UI),
   * so there's no reconciliation needed — the tab ID is the same everywhere.
   * The initTab flow (useTabInit) will handle session creation for the requesting client.
   *
   * Other clients that don't have this tab will add it via the tabCreated broadcast.
   */
  private async handleCreateTab(ws: WSContext, workingDir: string, tabName?: string, optimisticTabId?: string): Promise<void> {
    const registry = this.getRegistry(workingDir);

    // Use the client's optimistic ID when available — avoids reconciliation.
    // Fall back to server-generated ID if no optimistic ID provided.
    const tabId = optimisticTabId || `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Check if this tab was already registered by initTab (race: useTabInit fires first)
    const existingSession = registry.getTabSession(tabId);
    if (existingSession) {
      // Tab already initialized — broadcast to all clients.
      // Must use broadcastToAll because all web clients share a single
      // platformRelayContext — broadcastToOthers would skip the relay entirely,
      // preventing other browser instances from discovering the new tab.
      const regTab = registry.getTab(tabId);
      this.broadcastToAll({
        type: 'tabCreated',
        data: {
          tabId,
          tabName: regTab?.tabName || 'Chat',
          createdAt: regTab?.createdAt,
          order: regTab?.order,
          sessionInfo: this.sessions.get(existingSession)?.getSessionInfo(),
        }
      });
      return;
    }

    // Create new session and register
    const session = new ImprovisationSessionManager({ workingDir, model: getModel() });
    this.setupSessionListeners(session, ws, tabId);

    const sessionId = session.getSessionInfo().sessionId;
    this.sessions.set(sessionId, session);

    const tabMap = this.connections.get(ws);
    if (tabMap) tabMap.set(tabId, sessionId);

    registry.registerTab(tabId, sessionId, tabName);
    const registeredTab = registry.getTab(tabId);

    // Broadcast to ALL clients — the requesting client already has the tab
    // (optimistic UI) and will ignore the duplicate via !currentTabs.has(tabId).
    // Must use broadcastToAll so other browser instances via the shared
    // platformRelayContext receive the tabCreated event.
    this.broadcastToAll({
      type: 'tabCreated',
      data: {
        tabId,
        tabName: registeredTab?.tabName || 'Chat',
        createdAt: registeredTab?.createdAt,
        order: registeredTab?.order,
        sessionInfo: session.getSessionInfo(),
      }
    });

    // Send tabInitialized to the requesting client so useTabInit resolves
    this.send(ws, {
      type: 'tabInitialized',
      tabId,
      data: session.getSessionInfo()
    });
  }

  /**
   * Handle reorderTabs — client is reordering tabs.
   */
  private handleReorderTabs(_ws: WSContext, workingDir: string, tabOrder?: string[]): void {
    if (!Array.isArray(tabOrder)) return;
    const registry = this.getRegistry(workingDir);
    registry.reorderTabs(tabOrder);

    // Build order mapping for broadcast
    const allTabs = registry.getAllTabs();
    const orderMap = tabOrder
      .filter((id) => allTabs[id])
      .map((id) => ({ tabId: id, order: allTabs[id].order }));

    this.broadcastToAll({
      type: 'tabsReordered',
      data: { tabOrder: orderMap }
    });
  }

  /**
   * Generate a notification summary using Claude Haiku
   * Sends the result as a notificationSummary message
   */
  private async generateNotificationSummary(
    ws: WSContext,
    tabId: string,
    userPrompt: string,
    output: string,
    workingDir: string
  ): Promise<void> {
    try {
      // Create temp directory if it doesn't exist
      const tempDir = join(workingDir, '.mstro', 'tmp');
      if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true });
      }

      // Truncate output if too long (keep first and last parts for context)
      let truncatedOutput = output;
      if (output.length > 4000) {
        const firstPart = output.slice(0, 2000);
        const lastPart = output.slice(-1500);
        truncatedOutput = `${firstPart}\n\n... [output truncated] ...\n\n${lastPart}`;
      }

      // Build the prompt for summary generation
      const summaryPrompt = `You are generating a SHORT browser notification summary for a completed task.
The user ran a task and wants a brief notification to remind them what happened.

USER'S ORIGINAL PROMPT:
"${userPrompt}"

TASK OUTPUT (may be truncated):
${truncatedOutput}

Generate a notification summary following these rules:
1. Maximum 100 characters (this is a browser notification)
2. Focus on the OUTCOME, not the process
3. Be specific about what was accomplished
4. Use past tense (e.g., "Fixed bug in auth.ts", "Added 3 new tests")
5. If there was an error, mention it briefly
6. No emojis, no markdown, just plain text

Respond with ONLY the summary text, nothing else.`;

      // Write prompt to temp file
      const promptFile = join(tempDir, `notif-summary-${Date.now()}.txt`);
      writeFileSync(promptFile, summaryPrompt);

      const systemPrompt = 'You are a notification summary assistant. Respond with only the summary text, no preamble or explanation.';

      const args = [
        '--print',
        '--model', 'haiku',
        '--system-prompt', systemPrompt,
        promptFile
      ];

      const claude = spawn('claude', args, {
        cwd: workingDir,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      claude.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      claude.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      claude.on('close', (code: number | null) => {
        // Clean up temp file
        try {
          unlinkSync(promptFile);
        } catch {
          // Ignore cleanup errors
        }

        let summary: string;
        if (code === 0 && stdout.trim()) {
          // Truncate if somehow still too long
          summary = stdout.trim().slice(0, 150);
        } else {
          console.error('[WebSocketImproviseHandler] Claude error:', stderr || 'Unknown error');
          // Fallback to basic summary
          summary = this.createFallbackSummary(userPrompt);
        }

        this.send(ws, {
          type: 'notificationSummary',
          tabId,
          data: { summary }
        });
      });

      claude.on('error', (err: Error) => {
        console.error('[WebSocketImproviseHandler] Failed to spawn Claude:', err);
        const summary = this.createFallbackSummary(userPrompt);
        this.send(ws, {
          type: 'notificationSummary',
          tabId,
          data: { summary }
        });
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        claude.kill();
        const summary = this.createFallbackSummary(userPrompt);
        this.send(ws, {
          type: 'notificationSummary',
          tabId,
          data: { summary }
        });
      }, 10000);

    } catch (error) {
      console.error('[WebSocketImproviseHandler] Error generating summary:', error);
      const summary = this.createFallbackSummary(userPrompt);
      this.send(ws, {
        type: 'notificationSummary',
        tabId,
        data: { summary }
      });
    }
  }

  /**
   * Create a fallback summary when AI summarization fails
   */
  private createFallbackSummary(userPrompt: string): string {
    const truncated = userPrompt.slice(0, 60);
    if (userPrompt.length > 60) {
      return `Completed: "${truncated}..."`;
    }
    return `Completed: "${truncated}"`;
  }

  // ============================================
  // Git handling methods
  // ============================================

  /**
   * Handle git-related messages
   */
  private handleGitMessage(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
    // Get the effective git directory (selected or working dir)
    const gitDir = this.gitDirectories.get(tabId) || workingDir;

    const handlers: Record<string, () => void> = {
      gitStatus: () => this.handleGitStatus(ws, tabId, gitDir),
      gitStage: () => this.handleGitStage(ws, msg, tabId, gitDir),
      gitUnstage: () => this.handleGitUnstage(ws, msg, tabId, gitDir),
      gitCommit: () => this.handleGitCommit(ws, msg, tabId, gitDir),
      gitCommitWithAI: () => this.handleGitCommitWithAI(ws, msg, tabId, gitDir),
      gitPush: () => this.handleGitPush(ws, tabId, gitDir),
      gitLog: () => this.handleGitLog(ws, msg, tabId, gitDir),
      gitDiscoverRepos: () => this.handleGitDiscoverRepos(ws, tabId, workingDir),
      gitSetDirectory: () => this.handleGitSetDirectory(ws, msg, tabId, workingDir),
      gitGetRemoteInfo: () => this.handleGitGetRemoteInfo(ws, tabId, gitDir),
      gitCreatePR: () => this.handleGitCreatePR(ws, msg, tabId, gitDir),
      gitGeneratePRDescription: () => this.handleGitGeneratePRDescription(ws, msg, tabId, gitDir),
    };
    handlers[msg.type]?.();
  }

  /**
   * Execute a git command and return stdout
   */
  private executeGitCommand(args: string[], workingDir: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const git = spawn('git', args, {
        cwd: workingDir,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      git.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      git.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      git.on('close', (code: number | null) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      git.on('error', (err: Error) => {
        resolve({ stdout: '', stderr: err.message, exitCode: 1 });
      });
    });
  }

  /** Map of simple escape sequences to their character values */
  private static readonly ESCAPE_CHARS: Record<string, string> = {
    '\\': '\\',
    '"': '"',
    'n': '\n',
    't': '\t',
    'r': '\r',
  };

  /**
   * Unquote a git-quoted path (C-style quoting)
   * Git quotes paths containing spaces, special chars, or non-ASCII with double quotes
   * and uses backslash escapes inside (e.g., \", \\, \n, \t, \nnn for octal)
   */
  private unquoteGitPath(path: string): string {
    // If not quoted, return as-is
    if (!path.startsWith('"') || !path.endsWith('"')) {
      return path;
    }

    // Remove surrounding quotes and process escape sequences
    const inner = path.slice(1, -1);
    let result = '';
    let i = 0;

    while (i < inner.length) {
      if (inner[i] !== '\\' || i + 1 >= inner.length) {
        result += inner[i];
        i++;
        continue;
      }

      const next = inner[i + 1];
      const escaped = WebSocketImproviseHandler.ESCAPE_CHARS[next];

      if (escaped !== undefined) {
        result += escaped;
        i += 2;
      } else if (this.isOctalEscape(inner, i)) {
        result += String.fromCharCode(parseInt(inner.slice(i + 1, i + 4), 8));
        i += 4;
      } else {
        result += inner[i];
        i++;
      }
    }

    return result;
  }

  /** Check if position i starts an octal escape sequence (\nnn) */
  private isOctalEscape(str: string, i: number): boolean {
    return i + 3 < str.length &&
      /[0-7]/.test(str[i + 1]) &&
      /[0-7]{2}/.test(str.slice(i + 2, i + 4));
  }

  /**
   * Parse git status --porcelain output into structured format
   */
  private parseGitStatus(porcelainOutput: string): { staged: GitFileStatus[]; unstaged: GitFileStatus[]; untracked: GitFileStatus[] } {
    const staged: GitFileStatus[] = [];
    const unstaged: GitFileStatus[] = [];
    const untracked: GitFileStatus[] = [];

    const lines = porcelainOutput.split('\n').filter(line => line.length >= 4);

    for (const line of lines) {

      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const rawPath = line.slice(3);

      // Unquote the path (git quotes paths with spaces/special chars)
      const path = this.unquoteGitPath(rawPath);

      // Handle renamed files (format: "R  old -> new" or R  "old" -> "new")
      let filePath = path;
      let originalPath: string | undefined;
      if (rawPath.includes(' -> ')) {
        const parts = rawPath.split(' -> ');
        originalPath = this.unquoteGitPath(parts[0]);
        filePath = this.unquoteGitPath(parts[1]);
      }

      // Untracked files
      if (indexStatus === '?' && workTreeStatus === '?') {
        untracked.push({
          path: filePath,
          status: '?',
          staged: false,
        });
        continue;
      }

      // Staged changes (index has changes)
      if (indexStatus !== ' ' && indexStatus !== '?') {
        staged.push({
          path: filePath,
          status: indexStatus as GitFileStatus['status'],
          staged: true,
          originalPath,
        });
      }

      // Unstaged changes (worktree has changes)
      if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
        unstaged.push({
          path: filePath,
          status: workTreeStatus as GitFileStatus['status'],
          staged: false,
          originalPath,
        });
      }
    }

    return { staged, unstaged, untracked };
  }

  /**
   * Handle git status request
   */
  private async handleGitStatus(ws: WSContext, tabId: string, workingDir: string): Promise<void> {
    try {
      // Get porcelain status
      const statusResult = await this.executeGitCommand(['status', '--porcelain=v1'], workingDir);
      if (statusResult.exitCode !== 0) {
        this.send(ws, { type: 'gitError', tabId, data: { error: statusResult.stderr || statusResult.stdout || 'Failed to get git status' } });
        return;
      }

      // Get current branch
      const branchResult = await this.executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
      const branch = branchResult.stdout.trim() || 'HEAD';

      // Get ahead/behind counts and upstream tracking info
      let ahead = 0;
      let behind = 0;
      let hasUpstream = false;
      const trackingResult = await this.executeGitCommand(['rev-list', '--left-right', '--count', `${branch}...@{u}`], workingDir);
      if (trackingResult.exitCode === 0) {
        hasUpstream = true;
        const parts = trackingResult.stdout.trim().split(/\s+/);
        ahead = parseInt(parts[0], 10) || 0;
        behind = parseInt(parts[1], 10) || 0;
      } else {
        // No upstream - count local commits as ahead
        const localResult = await this.executeGitCommand(['rev-list', '--count', 'HEAD'], workingDir);
        if (localResult.exitCode === 0) {
          ahead = parseInt(localResult.stdout.trim(), 10) || 0;
        }
      }

      const { staged, unstaged, untracked } = this.parseGitStatus(statusResult.stdout);

      const response: GitStatusResponse = {
        branch,
        isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
        staged,
        unstaged,
        untracked,
        ahead,
        behind,
        hasUpstream,
      };

      this.send(ws, { type: 'gitStatus', tabId, data: response });
    } catch (error: any) {
      this.send(ws, { type: 'gitError', tabId, data: { error: error.message } });
    }
  }

  /**
   * Handle git stage request
   */
  private async handleGitStage(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
    const stageAll = !!msg.data?.stageAll;
    const paths = msg.data?.paths as string[] | undefined;

    if (!stageAll && (!paths || paths.length === 0)) {
      this.send(ws, { type: 'gitError', tabId, data: { error: 'No paths specified for staging' } });
      return;
    }

    try {
      // Use `git add -A` for staging all (handles new, modified, and deleted files reliably)
      // Use `git add -- ...paths` for staging specific files
      const args = stageAll ? ['add', '-A'] : ['add', '--', ...paths!];
      const result = await this.executeGitCommand(args, workingDir);
      if (result.exitCode !== 0) {
        this.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || result.stdout || 'Failed to stage files' } });
        return;
      }

      this.send(ws, { type: 'gitStaged', tabId, data: { paths: paths || [] } });
    } catch (error: any) {
      this.send(ws, { type: 'gitError', tabId, data: { error: error.message } });
    }
  }

  /**
   * Handle git unstage request
   */
  private async handleGitUnstage(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
    const paths = msg.data?.paths as string[] | undefined;
    if (!paths || paths.length === 0) {
      this.send(ws, { type: 'gitError', tabId, data: { error: 'No paths specified for unstaging' } });
      return;
    }

    try {
      const result = await this.executeGitCommand(['reset', 'HEAD', '--', ...paths], workingDir);
      if (result.exitCode !== 0) {
        this.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || result.stdout || 'Failed to unstage files' } });
        return;
      }

      this.send(ws, { type: 'gitUnstaged', tabId, data: { paths } });
    } catch (error: any) {
      this.send(ws, { type: 'gitError', tabId, data: { error: error.message } });
    }
  }

  /**
   * Handle git commit request (with user-provided message)
   */
  private async handleGitCommit(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
    const message = msg.data?.message as string | undefined;
    if (!message) {
      this.send(ws, { type: 'gitError', tabId, data: { error: 'Commit message is required' } });
      return;
    }

    try {
      // Commit all staged changes directly - no pre-check to avoid race conditions
      const result = await this.executeGitCommand(['commit', '-m', message], workingDir);
      if (result.exitCode !== 0) {
        let errorMsg = result.stderr || result.stdout || 'Failed to commit';
        if (errorMsg.includes('nothing to commit') || errorMsg.includes('no changes added')) {
          errorMsg = 'No changes staged for commit. Use "Stage" to add files before committing.';
          // Refresh status to sync UI
          this.handleGitStatus(ws, tabId, workingDir);
        }
        this.send(ws, { type: 'gitError', tabId, data: { error: errorMsg } });
        return;
      }

      // Get the new commit hash
      const hashResult = await this.executeGitCommand(['rev-parse', '--short', 'HEAD'], workingDir);
      const hash = hashResult.stdout.trim();

      this.send(ws, { type: 'gitCommitted', tabId, data: { hash, message } });
      // Proactively send updated status so the UI reflects new ahead/behind counts
      this.handleGitStatus(ws, tabId, workingDir);
    } catch (error: any) {
      this.send(ws, { type: 'gitError', tabId, data: { error: error.message } });
    }
  }

  /**
   * Handle git commit with AI-generated message
   * Uses Claude Code to analyze staged changes and generate a commit message
   */
  private async handleGitCommitWithAI(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
    try {
      // First check if there are staged changes
      const statusResult = await this.executeGitCommand(['status', '--porcelain=v1'], workingDir);
      const { staged } = this.parseGitStatus(statusResult.stdout);

      if (staged.length === 0) {
        this.send(ws, { type: 'gitError', tabId, data: { error: 'No staged changes to commit' } });
        return;
      }

      // Get the diff of staged changes
      const diffResult = await this.executeGitCommand(['diff', '--cached'], workingDir);
      const diff = diffResult.stdout;

      // Get recent commit messages for style reference
      const logResult = await this.executeGitCommand(['log', '--oneline', '-5'], workingDir);
      const recentCommits = logResult.stdout.trim();

      // Create temp directory if it doesn't exist
      const tempDir = join(workingDir, '.mstro', 'tmp');
      if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true });
      }

      // Truncate diff if too long
      let truncatedDiff = diff;
      if (diff.length > 8000) {
        truncatedDiff = `${diff.slice(0, 4000)}\n\n... [diff truncated] ...\n\n${diff.slice(-3500)}`;
      }

      // Build prompt for commit message generation
      const prompt = `You are generating a git commit message for the following staged changes.

RECENT COMMIT MESSAGES (for style reference):
${recentCommits || 'No recent commits'}

STAGED FILES:
${staged.map(f => `${f.status} ${f.path}`).join('\n')}

DIFF OF STAGED CHANGES:
${truncatedDiff}

Generate a commit message following these rules:
1. First line: imperative mood, max 72 characters (e.g., "Add user authentication", "Fix memory leak in parser")
2. If the changes are complex, add a blank line then bullet points explaining the key changes
3. Focus on the "why" not just the "what"
4. Match the style of recent commits if possible
5. No emojis unless the repo already uses them

Respond with ONLY the commit message, nothing else.`;

      // Write prompt to temp file
      const promptFile = join(tempDir, `commit-msg-${Date.now()}.txt`);
      writeFileSync(promptFile, prompt);

      const systemPrompt = 'You are a commit message assistant. Respond with only the commit message, no preamble or explanation.';

      const args = [
        '--print',
        '--model', 'haiku',
        '--system-prompt', systemPrompt,
        promptFile
      ];

      const claude = spawn('claude', args, {
        cwd: workingDir,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      claude.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      claude.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      claude.on('close', async (code: number | null) => {
        // Clean up temp file
        try {
          unlinkSync(promptFile);
        } catch {
          // Ignore cleanup errors
        }

        if (code !== 0 || !stdout.trim()) {
          console.error('[WebSocketImproviseHandler] Claude commit message error:', stderr || 'No output');
          this.send(ws, { type: 'gitError', tabId, data: { error: 'Failed to generate commit message' } });
          return;
        }

        // Post-process to extract just the commit message
        // Claude sometimes outputs reasoning before the actual message
        const commitMessage = this.extractCommitMessage(stdout.trim());
        const autoCommit = !!msg.data?.autoCommit;

        // Send the generated message for preview (include autoCommit flag so frontend knows if commit is pending)
        this.send(ws, { type: 'gitCommitMessage', tabId, data: { message: commitMessage, autoCommit } });

        // If autoCommit is true, proceed with the commit
        if (msg.data?.autoCommit) {
          const commitResult = await this.executeGitCommand(['commit', '-m', commitMessage], workingDir);
          if (commitResult.exitCode !== 0) {
            this.send(ws, { type: 'gitError', tabId, data: { error: commitResult.stderr || commitResult.stdout || 'Failed to commit' } });
            return;
          }

          // Get the new commit hash
          const hashResult = await this.executeGitCommand(['rev-parse', '--short', 'HEAD'], workingDir);
          const hash = hashResult.stdout.trim();

          this.send(ws, { type: 'gitCommitted', tabId, data: { hash, message: commitMessage } });
          // Proactively send updated status so the UI reflects new ahead/behind counts
          this.handleGitStatus(ws, tabId, workingDir);
        }
      });

      claude.on('error', (err: Error) => {
        console.error('[WebSocketImproviseHandler] Failed to spawn Claude for commit:', err);
        this.send(ws, { type: 'gitError', tabId, data: { error: 'Failed to generate commit message' } });
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        claude.kill();
      }, 30000);

    } catch (error: any) {
      this.send(ws, { type: 'gitError', tabId, data: { error: error.message } });
    }
  }

  /**
   * Extract the actual commit message from Claude's output.
   * Sometimes Claude outputs reasoning before the actual message, so we need to parse it.
   */
  private extractCommitMessage(output: string): string {
    // Look for common patterns where Claude introduces the commit message
    const patterns = [
      /(?:here'?s?\s+(?:the\s+)?commit\s+message:?\s*\n+)([\s\S]+)/i,
      /(?:commit\s+message:?\s*\n+)([\s\S]+)/i,
      /(?:suggested\s+commit\s+message:?\s*\n+)([\s\S]+)/i,
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match?.[1]) {
        return this.stripCoauthorLines(match[1].trim());
      }
    }

    // Split into paragraphs for analysis
    const paragraphs = output.split(/\n\n+/).filter(p => p.trim());

    // If only one paragraph, return it as-is
    if (paragraphs.length <= 1) {
      return this.stripCoauthorLines(output.trim());
    }

    const firstParagraph = paragraphs[0].trim();
    const firstLine = firstParagraph.split('\n')[0].trim();

    // Check if first paragraph looks like reasoning/self-talk
    // Reasoning typically: starts with certain words, is conversational, explains what will happen
    const reasoningPatterns = [
      /^(Now|Based|Looking|After|Here|Let me|I\s+(can|will|see|notice|'ll|would))/i,
      /^The\s+\w+\s+(file|changes?|commit|diff)/i,
      /\b(I can|I will|I'll|let me|analyzing|looking at)\b/i,
    ];

    const looksLikeReasoning = reasoningPatterns.some(p => p.test(firstParagraph));

    // Also check if first line is too long or conversational for a commit title
    const firstLineTooLong = firstLine.length > 80;
    const endsWithPeriod = firstLine.endsWith('.');

    if (looksLikeReasoning || (firstLineTooLong && endsWithPeriod)) {
      // Skip the first paragraph (reasoning) and return the rest
      const commitMessage = paragraphs.slice(1).join('\n\n').trim();

      // Validate the extracted message has a reasonable first line
      const extractedFirstLine = commitMessage.split('\n')[0].trim();
      if (extractedFirstLine.length > 0 && extractedFirstLine.length <= 100) {
        return this.stripCoauthorLines(commitMessage);
      }
    }

    // Check if the second paragraph looks like a proper commit title
    // (short, starts with capital, imperative mood)
    if (paragraphs.length >= 2) {
      const secondParagraph = paragraphs[1].trim();
      const secondFirstLine = secondParagraph.split('\n')[0].trim();

      // Commit titles are typically short and start with imperative verb
      if (secondFirstLine.length <= 72 &&
          /^[A-Z][a-z]/.test(secondFirstLine) &&
          !secondFirstLine.endsWith('.')) {
        // Return from second paragraph onwards
        return this.stripCoauthorLines(paragraphs.slice(1).join('\n\n').trim());
      }
    }

    // Fall back to original output if we can't identify a better message
    return this.stripCoauthorLines(output.trim());
  }

  /**
   * Strip injected coauthor/attribution lines from a commit message.
   * The Claude Code CLI appends "Co-Authored-By" lines to LLM output.
   * We detect and remove them by matching known marker strings.
   */
  private stripCoauthorLines(message: string): string {
    const lines = message.split('\n');
    const markers = ['co-authored', 'authored-by', 'haiku', 'noreply@anthropic.com'];
    const result: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      if (markers.some(m => lower.includes(m))) {
        // Also remove a blank line immediately before this one
        if (result.length > 0 && result[result.length - 1].trim() === '') {
          result.pop();
        }
        continue;
      }
      result.push(lines[i]);
    }
    // Don't return empty - keep at least the first line of the original
    if (result.length === 0) return lines[0]?.trim() || message;
    return result.join('\n').trimEnd();
  }

  /**
   * Handle git push request
   */
  private async handleGitPush(ws: WSContext, tabId: string, workingDir: string): Promise<void> {
    try {
      // Check if branch has an upstream, if not use --set-upstream
      const branchResult = await this.executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
      const branch = branchResult.stdout.trim();

      const upstreamCheck = await this.executeGitCommand(['rev-parse', '--abbrev-ref', `${branch}@{u}`], workingDir);
      const hasUpstream = upstreamCheck.exitCode === 0;

      const pushArgs = hasUpstream ? ['push'] : ['push', '-u', 'origin', branch];
      const result = await this.executeGitCommand(pushArgs, workingDir);
      if (result.exitCode !== 0) {
        this.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || result.stdout || 'Failed to push' } });
        return;
      }

      this.send(ws, { type: 'gitPushed', tabId, data: { output: result.stdout || result.stderr } });
    } catch (error: any) {
      this.send(ws, { type: 'gitError', tabId, data: { error: error.message } });
    }
  }

  /**
   * Handle git log request
   */
  private async handleGitLog(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
    const limit = msg.data?.limit ?? 10;

    try {
      const result = await this.executeGitCommand([
        'log',
        `-${limit}`,
        '--format=%H|%h|%s|%an|%aI'
      ], workingDir);

      if (result.exitCode !== 0) {
        this.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || result.stdout || 'Failed to get log' } });
        return;
      }

      const entries: GitLogEntry[] = result.stdout.trim().split('\n').filter(Boolean).map(line => {
        const [hash, shortHash, subject, author, date] = line.split('|');
        return { hash, shortHash, subject, author, date };
      });

      this.send(ws, { type: 'gitLog', tabId, data: { entries } });
    } catch (error: any) {
      this.send(ws, { type: 'gitError', tabId, data: { error: error.message } });
    }
  }

  /** Directories to skip when scanning for git repos */
  private static readonly SKIP_DIRS = ['node_modules', 'vendor', '.git'];

  /** Get the current branch name for a git repository */
  private async getRepoBranch(repoPath: string): Promise<string | undefined> {
    const result = await this.executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  /** Check if a directory name should be skipped when scanning */
  private shouldSkipDir(name: string): boolean {
    return name.startsWith('.') || WebSocketImproviseHandler.SKIP_DIRS.includes(name);
  }

  /** Recursively scan directories for git repositories */
  private async scanForGitRepos(dir: string, depth: number, maxDepth: number, repos: GitRepoInfo[]): Promise<void> {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (this.shouldSkipDir(name)) continue;

      const fullPath = join(dir, name);
      const gitPath = join(fullPath, '.git');

      if (existsSync(gitPath)) {
        repos.push({ path: fullPath, name, branch: await this.getRepoBranch(fullPath) });
      } else {
        await this.scanForGitRepos(fullPath, depth + 1, maxDepth, repos);
      }
    }
  }

  /**
   * Discover git repositories in the working directory and subdirectories
   */
  private async handleGitDiscoverRepos(ws: WSContext, tabId: string, workingDir: string): Promise<void> {
    try {
      const repos: GitRepoInfo[] = [];
      const rootIsGitRepo = existsSync(join(workingDir, '.git'));

      if (rootIsGitRepo) {
        repos.push({
          path: workingDir,
          name: workingDir.split('/').pop() || workingDir,
          branch: await this.getRepoBranch(workingDir),
        });
      } else {
        await this.scanForGitRepos(workingDir, 1, 3, repos);
      }

      const response: GitReposDiscoveredResponse = {
        repos,
        rootIsGitRepo,
        selectedDirectory: this.gitDirectories.get(tabId) || null,
      };

      this.send(ws, { type: 'gitReposDiscovered', tabId, data: response });
    } catch (error: any) {
      this.send(ws, { type: 'gitError', tabId, data: { error: error.message } });
    }
  }

  /**
   * Set the git directory for operations
   */
  private async handleGitSetDirectory(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
    const directory = msg.data?.directory as string | undefined;

    if (!directory) {
      // Clear the selected directory, use working dir
      this.gitDirectories.delete(tabId);
      const response: GitDirectorySetResponse = {
        directory: workingDir,
        isValid: existsSync(join(workingDir, '.git')),
      };
      this.send(ws, { type: 'gitDirectorySet', tabId, data: response });
      // Refresh status with new directory
      this.handleGitStatus(ws, tabId, workingDir);
      return;
    }

    // Validate the directory exists and has a .git folder
    const gitPath = join(directory, '.git');
    const isValid = existsSync(gitPath);

    if (isValid) {
      this.gitDirectories.set(tabId, directory);
    }

    const response: GitDirectorySetResponse = {
      directory,
      isValid,
    };

    this.send(ws, { type: 'gitDirectorySet', tabId, data: response });

    // Refresh status with new directory
    if (isValid) {
      this.handleGitStatus(ws, tabId, directory);
      this.handleGitLog(ws, { type: 'gitLog', data: { limit: 5 } }, tabId, directory);
    }
  }

  /**
   * Get remote info for PR creation (remote URL, provider, default branch)
   */
  private async handleGitGetRemoteInfo(ws: WSContext, tabId: string, workingDir: string): Promise<void> {
    try {
      const remoteResult = await this.executeGitCommand(['remote', 'get-url', 'origin'], workingDir);
      if (remoteResult.exitCode !== 0) {
        this.send(ws, { type: 'gitRemoteInfo', tabId, data: { hasRemote: false } });
        return;
      }

      const remoteUrl = remoteResult.stdout.trim();

      // Detect provider from remote URL
      let provider: 'github' | 'gitlab' | 'unknown' = 'unknown';
      if (remoteUrl.includes('github.com')) provider = 'github';
      else if (remoteUrl.includes('gitlab.com') || remoteUrl.includes('gitlab')) provider = 'gitlab';

      // Get default branch (usually main or master)
      const defaultBranchResult = await this.executeGitCommand(
        ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
        workingDir
      );
      let defaultBranch = 'main';
      if (defaultBranchResult.exitCode === 0) {
        defaultBranch = defaultBranchResult.stdout.trim().replace('origin/', '');
      }

      // Get current branch
      const branchResult = await this.executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
      const currentBranch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : '';

      // Check for CLI tools and auth status
      let hasGhCli = false;
      let ghCliAuthenticated = false;
      let ghCliBinary: 'gh' | 'glab' | undefined;

      const cliBin = provider === 'github' ? 'gh' : provider === 'gitlab' ? 'glab' : null;

      if (cliBin) {
        // Check if CLI is installed
        const installed = await this.spawnCheck(cliBin, ['--version']);
        if (installed) {
          hasGhCli = true;
          ghCliBinary = cliBin;
          // Check if CLI is authenticated
          ghCliAuthenticated = await this.spawnCheck(cliBin, ['auth', 'status']);
        }
      }

      // List remote branches
      const remoteBranchResult = await this.executeGitCommand(['branch', '-r', '--list', 'origin/*'], workingDir);
      const remoteBranches: string[] = [];
      if (remoteBranchResult.exitCode === 0) {
        for (const line of remoteBranchResult.stdout.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.includes('->')) continue; // skip HEAD pointer
          const branch = trimmed.replace('origin/', '');
          if (branch) remoteBranches.push(branch);
        }
        remoteBranches.sort();
      }

      // Load preferred base branch from settings
      const preferredBaseBranch = getPrBaseBranch(remoteUrl) ?? undefined;

      this.send(ws, {
        type: 'gitRemoteInfo',
        tabId,
        data: {
          hasRemote: true,
          remoteUrl,
          provider,
          defaultBranch,
          currentBranch,
          hasGhCli,
          ghCliAuthenticated,
          ghCliBinary,
          remoteBranches,
          preferredBaseBranch,
        },
      });
    } catch (error: any) {
      this.send(ws, { type: 'gitError', tabId, data: { error: error.message } });
    }
  }

  /** Check if a binary runs successfully (exit code 0) */
  private spawnCheck(bin: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  /**
   * Create a pull/merge request using gh CLI (GitHub) or open browser URL (fallback)
   */
  private async handleGitCreatePR(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
    const { title, body, baseBranch, draft } = msg.data ?? {};

    if (!title) {
      this.send(ws, { type: 'gitError', tabId, data: { error: 'PR title is required' } });
      return;
    }

    try {
      const branchResult = await this.executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
      if (branchResult.exitCode !== 0) {
        this.send(ws, { type: 'gitError', tabId, data: { error: 'Failed to detect current branch' } });
        return;
      }
      const headBranch = branchResult.stdout.trim();

      const remoteResult = await this.executeGitCommand(['remote', 'get-url', 'origin'], workingDir);
      if (remoteResult.exitCode !== 0) {
        this.send(ws, { type: 'gitError', tabId, data: { error: 'No remote origin configured' } });
        return;
      }
      const remoteUrl = remoteResult.stdout.trim();
      const isGitHub = remoteUrl.includes('github.com');
      const isGitLab = remoteUrl.includes('gitlab.com') || remoteUrl.includes('gitlab');

      // Try CLI creation (gh for GitHub, glab for GitLab)
      const cliResult = await this.tryCliPRCreate(
        isGitHub ? 'gh' : isGitLab ? 'glab' : null,
        { title, body, baseBranch, draft, headBranch },
        workingDir,
      );

      if (cliResult.created) {
        if (baseBranch) setPrBaseBranch(remoteUrl, baseBranch);
        this.send(ws, { type: 'gitPRCreated', tabId, data: { url: cliResult.url!, method: isGitHub ? 'gh' : 'glab' } });
        return;
      }

      // Surface CLI errors instead of silently falling through
      if (cliResult.error) {
        this.send(ws, { type: 'gitError', tabId, data: { error: cliResult.error } });
        return;
      }

      // Fallback: construct browser URL (CLI not installed or unknown provider)
      const prUrl = this.buildBrowserPRUrl(remoteUrl, headBranch, baseBranch, title, body, isGitHub, isGitLab);

      if (prUrl) {
        if (baseBranch) setPrBaseBranch(remoteUrl, baseBranch);
        this.send(ws, { type: 'gitPRCreated', tabId, data: { url: prUrl, method: 'browser' } });
      } else {
        this.send(ws, { type: 'gitError', tabId, data: { error: 'Could not determine remote URL format for PR creation' } });
      }
    } catch (error: any) {
      this.send(ws, { type: 'gitError', tabId, data: { error: error.message } });
    }
  }

  /** Attempt to create a PR/MR via CLI. Returns { created, url, error } */
  private async tryCliPRCreate(
    cliBin: 'gh' | 'glab' | null,
    opts: { title: string; body?: string; baseBranch?: string; draft?: boolean; headBranch: string },
    workingDir: string,
  ): Promise<{ created: boolean; url?: string; error?: string }> {
    if (!cliBin) return { created: false }; // No CLI for this provider

    // Check if CLI is installed
    const installed = await this.spawnCheck(cliBin, ['--version']);
    if (!installed) return { created: false }; // Not installed, fall through to browser

    // Build CLI args
    const args = cliBin === 'gh'
      ? ['pr', 'create', '--title', opts.title]
      : ['mr', 'create', '--title', opts.title, '--yes']; // glab mr create

    if (opts.body) args.push('--body', opts.body);
    if (opts.baseBranch) {
      args.push(cliBin === 'gh' ? '--base' : '--target-branch', opts.baseBranch);
    }
    if (opts.draft) args.push('--draft');

    const result = await this.spawnWithOutput(cliBin, args, workingDir);

    if (result.exitCode === 0) {
      const urlMatch = result.stdout.match(/https?:\/\/\S+/);
      return { created: true, url: urlMatch ? urlMatch[0] : result.stdout.trim() };
    }

    return { created: false, error: this.classifyCliPRError(cliBin, result, opts.headBranch) };
  }

  /** Classify a CLI PR creation error into a user-facing message */
  private classifyCliPRError(
    cliBin: string,
    result: { stdout: string; stderr: string },
    headBranch: string,
  ): string {
    const combined = result.stderr + result.stdout;
    const lower = combined.toLowerCase();

    if (lower.includes('already exists')) {
      const existingUrl = combined.match(/https?:\/\/\S+/);
      return existingUrl
        ? `A pull request already exists for ${headBranch}: ${existingUrl[0]}`
        : `A pull request already exists for ${headBranch}`;
    }

    if (lower.includes('auth') || lower.includes('401') || lower.includes('token') || lower.includes('log in')) {
      return `${cliBin} is not authenticated. Run: ${cliBin} auth login`;
    }

    if (lower.includes('must first push') || lower.includes('failed to push') || lower.includes('no upstream')) {
      return `Branch "${headBranch}" has not been pushed to remote. Push first, then create the PR.`;
    }

    return `${cliBin} failed: ${(result.stderr || result.stdout).trim()}`;
  }

  /** Spawn a process and capture stdout/stderr */
  private spawnWithOutput(bin: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
      proc.on('error', (err: Error) => resolve({ stdout: '', stderr: err.message, exitCode: 1 }));
    });
  }

  /** Build a browser URL for PR creation (fallback when no CLI) */
  private buildBrowserPRUrl(
    remoteUrl: string, headBranch: string, baseBranch: string | undefined,
    title: string, body: string | undefined, isGitHub: boolean, isGitLab: boolean,
  ): string {
    const sshMatch = remoteUrl.match(/[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (!sshMatch) return '';

    const [, owner, repo] = sshMatch;
    const base = baseBranch || 'main';

    if (isGitHub) {
      return `https://github.com/${owner}/${repo}/compare/${base}...${headBranch}?expand=1&title=${encodeURIComponent(title)}${body ? `&body=${encodeURIComponent(body)}` : ''}`;
    }
    if (isGitLab) {
      return `https://gitlab.com/${owner}/${repo}/-/merge_requests/new?merge_request[source_branch]=${headBranch}&merge_request[target_branch]=${base}&merge_request[title]=${encodeURIComponent(title)}`;
    }
    return '';
  }

  /**
   * Generate a PR title and description using Haiku, based on the diff against the base branch.
   */
  private async handleGitGeneratePRDescription(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
    const baseBranch = msg.data?.baseBranch || 'main';

    try {
      // Get commit list for context
      const logResult = await this.executeGitCommand(['log', `${baseBranch}..HEAD`, '--oneline'], workingDir);
      const commits = logResult.exitCode === 0 ? logResult.stdout.trim() : '';

      if (!commits) {
        this.send(ws, { type: 'gitError', tabId, data: { error: `No commits found between ${baseBranch} and HEAD` } });
        return;
      }

      // Get diff against base
      const diffResult = await this.executeGitCommand(['diff', `${baseBranch}...HEAD`], workingDir);
      const diff = diffResult.exitCode === 0 ? diffResult.stdout : '';

      // Get changed files summary
      const statResult = await this.executeGitCommand(['diff', `${baseBranch}...HEAD`, '--stat'], workingDir);
      const stat = statResult.exitCode === 0 ? statResult.stdout.trim() : '';

      // Truncate diff if too long (same pattern as commit message generation)
      let truncatedDiff = diff;
      if (diff.length > 8000) {
        truncatedDiff = `${diff.slice(0, 4000)}\n\n... [diff truncated] ...\n\n${diff.slice(-3500)}`;
      }

      // Build prompt
      const tempDir = join(workingDir, '.mstro', 'tmp');
      if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true });
      }

      const prompt = `You are generating a pull request title and description for the following changes.

COMMITS (${baseBranch}..HEAD):
${commits}

FILES CHANGED:
${stat}

DIFF:
${truncatedDiff}

Generate a pull request title and description following these rules:
1. TITLE: First line must be the PR title — imperative mood, under 70 characters
2. Leave a blank line after the title
3. BODY: Write a concise description in markdown with:
   - A "## Summary" section with 1-3 bullet points explaining what changed and why
   - Optionally a "## Details" section if the changes are complex
4. Focus on the "why" not just the "what"
5. No emojis

Respond with ONLY the title and description, nothing else.`;

      const promptFile = join(tempDir, `pr-desc-${Date.now()}.txt`);
      writeFileSync(promptFile, prompt);

      const systemPrompt = 'You are a pull request description assistant. Respond with only the PR title and description, no preamble or explanation.';

      const args = [
        '--print',
        '--model', 'haiku',
        '--system-prompt', systemPrompt,
        promptFile
      ];

      const claude = spawn('claude', args, {
        cwd: workingDir,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      claude.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      claude.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      claude.on('close', (code: number | null) => {
        try { unlinkSync(promptFile); } catch { /* ignore */ }

        if (code !== 0 || !stdout.trim()) {
          console.error('[WebSocketImproviseHandler] Claude PR description error:', stderr || 'No output');
          this.send(ws, { type: 'gitError', tabId, data: { error: 'Failed to generate PR description' } });
          return;
        }

        // Parse: first line = title, rest = body
        const output = this.stripCoauthorLines(stdout.trim());
        const lines = output.split('\n');
        const title = lines[0].trim();
        const body = lines.slice(1).join('\n').trim();

        this.send(ws, { type: 'gitPRDescription', tabId, data: { title, body } });
      });

      claude.on('error', (err: Error) => {
        console.error('[WebSocketImproviseHandler] Failed to spawn Claude for PR description:', err);
        this.send(ws, { type: 'gitError', tabId, data: { error: 'Failed to generate PR description' } });
      });

      setTimeout(() => { claude.kill(); }, 30000);

    } catch (error: any) {
      this.send(ws, { type: 'gitError', tabId, data: { error: error.message } });
    }
  }

  // ============================================
  // Terminal handling methods
  // ============================================

  /**
   * Initialize a new terminal session or reconnect to existing one
   */
  private handleTerminalInit(
    ws: WSContext,
    terminalId: string,
    workingDir: string,
    requestedShell?: string,
    cols?: number,
    rows?: number,
    permission?: 'control' | 'view'
  ): void {

    const ptyManager = getPTYManager();

    // Check if PTY is available (node-pty requires native compilation)
    if (!ptyManager.isPtyAvailable()) {
      this.send(ws, {
        type: 'terminalError',
        terminalId,
        data: {
          error: 'PTY_NOT_AVAILABLE',
          instructions: ptyManager.getPtyInstallInstructions()
        }
      });
      return;
    }

    // Add this WS as a subscriber for this terminal's output
    this.addTerminalSubscriber(terminalId, ws);

    // Set up broadcast listeners (idempotent — only creates once per terminal)
    this.setupTerminalBroadcastListeners(terminalId);

    try {
      // Create or reconnect to the PTY process
      // Both 'control' and 'view' users get sandboxed terminals
      const { shell, cwd, isReconnect } = ptyManager.create(
        terminalId,
        workingDir,
        cols || 80,
        rows || 24,
        requestedShell,
        { sandboxed: permission === 'control' || permission === 'view' }
      );

      if (!isReconnect) {
        // New terminal — broadcast to other clients so they can create matching tabs
        this.broadcastToOthers(ws, {
          type: 'terminalCreated',
          data: { terminalId, shell, cwd }
        });
      }

      // Send ready message to THIS client
      this.send(ws, {
        type: 'terminalReady',
        terminalId,
        data: { shell, cwd, isReconnect }
      });
      trackEvent(AnalyticsEvents.TERMINAL_SESSION_CREATED, {
        shell,
        is_reconnect: isReconnect,
      });
    } catch (error: any) {
      console.error(`[WebSocketImproviseHandler] Failed to create terminal:`, error);
      this.send(ws, {
        type: 'terminalError',
        terminalId,
        data: { error: error.message || 'Failed to create terminal' }
      });
      this.removeTerminalSubscriber(terminalId, ws);
    }
  }

  /**
   * Reconnect to an existing terminal session
   */
  private handleTerminalReconnect(ws: WSContext, terminalId: string): void {

    const ptyManager = getPTYManager();

    // Check if session exists
    const sessionInfo = ptyManager.getSessionInfo(terminalId);
    if (!sessionInfo) {
      this.send(ws, {
        type: 'terminalError',
        terminalId,
        data: { error: 'Terminal session not found', sessionNotFound: true }
      });
      return;
    }

    // Add this WS as a subscriber for this terminal's output
    this.addTerminalSubscriber(terminalId, ws);

    // Set up broadcast listeners (idempotent — only creates once per terminal)
    this.setupTerminalBroadcastListeners(terminalId);

    // Send ready message indicating reconnection
    this.send(ws, {
      type: 'terminalReady',
      terminalId,
      data: {
        shell: sessionInfo.shell,
        cwd: sessionInfo.cwd,
        isReconnect: true
      }
    });

    // Force a resize to trigger SIGWINCH, causing the shell to redraw its prompt
    ptyManager.resize(terminalId, sessionInfo.cols, sessionInfo.rows);
  }

  /**
   * List all active terminal sessions
   */
  private handleTerminalList(ws: WSContext): void {
    const ptyManager = getPTYManager();
    const terminalIds = ptyManager.getActiveTerminals();

    const terminals = terminalIds.map(id => {
      const info = ptyManager.getSessionInfo(id);
      return info ? { id, ...info } : null;
    }).filter(Boolean);

    this.send(ws, {
      type: 'terminalList',
      data: { terminals }
    });
  }

  /**
   * Handle terminal input
   */
  private handleTerminalInput(
    ws: WSContext,
    terminalId: string,
    input?: string
  ): void {
    if (!input) {
      return;
    }

    const ptyManager = getPTYManager();
    const success = ptyManager.write(terminalId, input);

    if (!success) {
      this.send(ws, {
        type: 'terminalError',
        terminalId,
        data: { error: 'Terminal not found or write failed' }
      });
    }
  }

  /**
   * Handle terminal resize
   */
  private handleTerminalResize(
    _ws: WSContext,
    terminalId: string,
    cols?: number,
    rows?: number
  ): void {
    if (!cols || !rows) {
      return;
    }

    const ptyManager = getPTYManager();
    ptyManager.resize(terminalId, cols, rows);
  }

  /**
   * Handle terminal close
   */
  private handleTerminalClose(ws: WSContext, terminalId: string): void {
    trackEvent(AnalyticsEvents.TERMINAL_SESSION_CLOSED);

    // Clean up event listeners
    const listenerCleanup = this.terminalListenerCleanups.get(terminalId);
    if (listenerCleanup) {
      listenerCleanup();
      this.terminalListenerCleanups.delete(terminalId);
    }

    // Close PTY
    const ptyManager = getPTYManager();
    ptyManager.close(terminalId);

    // Clean up subscribers
    this.terminalSubscribers.delete(terminalId);

    // Broadcast to other clients
    this.broadcastToOthers(ws, {
      type: 'terminalClosed',
      data: { terminalId }
    });
  }

  // Track PTY event listener cleanup functions per terminal to prevent duplicate listeners
  private terminalListenerCleanups: Map<string, () => void> = new Map();

  // Track which WS connections are subscribed to each terminal's output
  private terminalSubscribers: Map<string, Set<WSContext>> = new Map();

  /**
   * Add a WS connection as a subscriber for terminal output.
   */
  private addTerminalSubscriber(terminalId: string, ws: WSContext): void {
    let subs = this.terminalSubscribers.get(terminalId);
    if (!subs) {
      subs = new Set();
      this.terminalSubscribers.set(terminalId, subs);
    }
    subs.add(ws);
  }

  /**
   * Remove a WS subscriber from a terminal and clean up if no subscribers remain.
   */
  private removeTerminalSubscriber(terminalId: string, ws: WSContext): void {
    const subs = this.terminalSubscribers.get(terminalId);
    if (!subs) return;
    subs.delete(ws);
    if (subs.size > 0) return;
    this.terminalSubscribers.delete(terminalId);
    const cleanup = this.terminalListenerCleanups.get(terminalId);
    if (cleanup) {
      cleanup();
      this.terminalListenerCleanups.delete(terminalId);
    }
  }

  /**
   * Set up PTY event listeners that broadcast to all subscribers.
   * Only creates listeners once per terminal (idempotent).
   */
  private setupTerminalBroadcastListeners(terminalId: string): void {
    // Already set up - don't duplicate
    if (this.terminalListenerCleanups.has(terminalId)) return;

    const ptyManager = getPTYManager();

    const onOutput = (tid: string, data: string) => {
      if (tid === terminalId) {
        const subs = this.terminalSubscribers.get(terminalId);
        if (subs) {
          for (const ws of subs) {
            this.send(ws, { type: 'terminalOutput', terminalId, data: { output: data } });
          }
        }
      }
    };

    const onExit = (tid: string, exitCode: number) => {
      if (tid === terminalId) {
        const subs = this.terminalSubscribers.get(terminalId);
        if (subs) {
          for (const ws of subs) {
            this.send(ws, { type: 'terminalExit', terminalId, data: { exitCode } });
          }
        }
        // Clean up
        ptyManager.off('output', onOutput);
        ptyManager.off('exit', onExit);
        ptyManager.off('error', onError);
        this.terminalListenerCleanups.delete(terminalId);
        this.terminalSubscribers.delete(terminalId);
      }
    };

    const onError = (tid: string, error: string) => {
      if (tid === terminalId) {
        const subs = this.terminalSubscribers.get(terminalId);
        if (subs) {
          for (const ws of subs) {
            this.send(ws, { type: 'terminalError', terminalId, data: { error } });
          }
        }
      }
    };

    ptyManager.on('output', onOutput);
    ptyManager.on('exit', onExit);
    ptyManager.on('error', onError);

    this.terminalListenerCleanups.set(terminalId, () => {
      ptyManager.off('output', onOutput);
      ptyManager.off('exit', onExit);
      ptyManager.off('error', onError);
    });
  }

}
