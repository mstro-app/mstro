// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * WebSocket Handler for Improvisation Sessions
 *
 * Thin orchestrator that routes WebSocket messages to domain-specific handlers.
 * Owns shared state (sessions, connections, etc.) and satisfies the HandlerContext interface.
 */

import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ImprovisationSessionManager } from '../../cli/improvisation-session-manager.js';
import { captureException } from '../sentry.js';
import { AutocompleteService } from './autocomplete.js';
import { handleFileExplorerMessage, handleFileMessage } from './file-explorer-handlers.js';
import { handleGitMessage } from './git-handlers.js';
import type { HandlerContext, UsageReporter } from './handler-context.js';
import { handleHistoryMessage, handleSessionMessage, initializeTab, resumeHistoricalSession } from './session-handlers.js';
import { SessionRegistry } from './session-registry.js';
import { generateNotificationSummary, handleGetSettings, handleUpdateSettings } from './settings-handlers.js';
import { handleCreateTab, handleGetActiveTabs, handleMarkTabViewed, handleRemoveTab, handleReorderTabs, handleSyncPromptText, handleSyncTabMeta } from './tab-handlers.js';
import { cleanupTerminalSubscribers, handleTerminalMessage } from './terminal-handlers.js';
import type { FrecencyData, WebSocketMessage, WebSocketResponse, WSContext } from './types.js';

export type { UsageReport, UsageReporter } from './handler-context.js';

export class WebSocketImproviseHandler implements HandlerContext {
  sessions: Map<string, ImprovisationSessionManager> = new Map();
  connections: Map<WSContext, Map<string, string>> = new Map();
  autocompleteService: AutocompleteService;
  private frecencyPath: string;
  usageReporter: UsageReporter | null = null;
  gitDirectories: Map<string, string> = new Map();
  private sessionRegistry: SessionRegistry | null = null;
  allConnections: Set<WSContext> = new Set();
  activeSearches: Map<string, ChildProcess> = new Map();
  terminalListenerCleanups: Map<string, () => void> = new Map();
  terminalSubscribers: Map<string, Set<WSContext>> = new Map();

  constructor() {
    this.frecencyPath = join(homedir(), '.mstro', 'autocomplete-frecency.json');
    const frecencyData = this.loadFrecencyData();
    this.autocompleteService = new AutocompleteService(frecencyData);
  }

  getRegistry(workingDir: string): SessionRegistry {
    if (!this.sessionRegistry) {
      this.sessionRegistry = new SessionRegistry(workingDir);
    }
    return this.sessionRegistry;
  }

  setUsageReporter(reporter: UsageReporter): void {
    this.usageReporter = reporter;
  }

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

  recordFileSelection(filePath: string): void {
    this.autocompleteService.recordFileSelection(filePath);
    this.saveFrecencyData();
  }

  handleConnection(ws: WSContext, _workingDir: string): void {
    this.connections.set(ws, new Map());
    this.allConnections.add(ws);
  }

  async handleMessage(
    ws: WSContext,
    message: string,
    workingDir: string
  ): Promise<void> {
    try {
      const msg: WebSocketMessage = JSON.parse(message);
      const tabId = msg.tabId || 'default';
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

  private async dispatchMessage(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'control' | 'view'): Promise<void> {
    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong', tabId });
        return;
      case 'initTab':
        return void await initializeTab(this, ws, tabId, workingDir, msg.data?.tabName);
      case 'resumeSession':
        if (!msg.data?.historicalSessionId) throw new Error('Historical session ID is required');
        return void await resumeHistoricalSession(this, ws, tabId, workingDir, msg.data.historicalSessionId);
      // Session messages
      case 'execute':
      case 'cancel':
      case 'getHistory':
      case 'new':
      case 'approve':
      case 'reject':
        return handleSessionMessage(this, ws, msg, tabId, permission);
      // History messages
      case 'getSessions':
      case 'getSessionsCount':
      case 'getSessionById':
      case 'deleteSession':
      case 'clearHistory':
      case 'searchHistory':
        return handleHistoryMessage(this, ws, msg, tabId, workingDir);
      // File autocomplete/read
      case 'autocomplete':
      case 'readFile':
      case 'recordSelection':
        return handleFileMessage(this, ws, msg, tabId, workingDir, permission);
      // Notification summary
      case 'requestNotificationSummary':
        if (!msg.data?.prompt || !msg.data?.output) throw new Error('Prompt and output are required for notification summary');
        return void await generateNotificationSummary(this, ws, tabId, msg.data.prompt, msg.data.output, workingDir);
      // Terminal messages
      case 'terminalInit':
      case 'terminalReconnect':
      case 'terminalList':
      case 'terminalInput':
      case 'terminalResize':
      case 'terminalClose':
        return handleTerminalMessage(this, ws, msg, tabId, workingDir, permission);
      // File explorer messages
      case 'listDirectory':
      case 'writeFile':
      case 'createFile':
      case 'createDirectory':
      case 'deleteFile':
      case 'renameFile':
      case 'notifyFileOpened':
      case 'searchFileContents':
      case 'cancelSearch':
      case 'findDefinition':
        return handleFileExplorerMessage(this, ws, msg, tabId, workingDir, permission);
      // Git messages
      case 'gitStatus':
      case 'gitStage':
      case 'gitUnstage':
      case 'gitCommit':
      case 'gitCommitWithAI':
      case 'gitPush':
      case 'gitPull':
      case 'gitLog':
      case 'gitDiscoverRepos':
      case 'gitSetDirectory':
      case 'gitGetRemoteInfo':
      case 'gitCreatePR':
      case 'gitGeneratePRDescription':
      case 'gitListBranches':
      case 'gitCheckout':
      case 'gitCreateBranch':
      case 'gitDeleteBranch':
      case 'gitDiff':
      case 'gitListTags':
      case 'gitCreateTag':
      case 'gitPushTag':
      case 'gitWorktreeList':
      case 'gitWorktreeCreate':
      case 'gitWorktreeRemove':
      case 'tabWorktreeSwitch':
      case 'gitWorktreePush':
      case 'gitWorktreeCreatePR':
      case 'gitMergePreview':
      case 'gitWorktreeMerge':
      case 'gitMergeAbort':
      case 'gitMergeComplete':
        return handleGitMessage(this, ws, msg, tabId, workingDir);
      // Tab sync messages
      case 'getActiveTabs':
        return handleGetActiveTabs(this, ws, workingDir);
      case 'createTab':
        return void await handleCreateTab(this, ws, workingDir, msg.data?.tabName, msg.data?.optimisticTabId);
      case 'reorderTabs':
        return handleReorderTabs(this, ws, workingDir, msg.data?.tabOrder);
      case 'syncTabMeta':
        return handleSyncTabMeta(this, ws, msg, tabId, workingDir);
      case 'syncPromptText':
        return handleSyncPromptText(this, ws, msg, tabId);
      case 'removeTab':
        return handleRemoveTab(this, ws, tabId, workingDir);
      case 'markTabViewed':
        return handleMarkTabViewed(this, ws, tabId, workingDir);
      // Settings messages
      case 'getSettings':
        return handleGetSettings(this, ws);
      case 'updateSettings':
        return handleUpdateSettings(this, ws, msg);
      default:
        throw new Error(`Unknown message type: ${msg.type}`);
    }
  }

  handleClose(ws: WSContext): void {
    this.connections.delete(ws);
    this.allConnections.delete(ws);
    cleanupTerminalSubscribers(this, ws);
  }

  send(ws: WSContext, response: WebSocketResponse): void {
    try {
      ws.send(JSON.stringify(response));
    } catch (error) {
      console.error('[WebSocketImproviseHandler] Error sending message:', error);
    }
  }

  broadcastToOthers(sender: WSContext, response: WebSocketResponse): void {
    for (const ws of this.allConnections) {
      if (ws !== sender) {
        this.send(ws, response);
      }
    }
  }

  broadcastToAll(response: WebSocketResponse): void {
    for (const ws of this.allConnections) {
      this.send(ws, response);
    }
  }

  cleanupSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  cleanupStaleSessions(): void {
  }
}
