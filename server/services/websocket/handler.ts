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
import { FileUploadHandler } from './file-upload-handler.js';
import { handleGitMessage } from './git-handlers.js';
import type { HandlerContext, UsageReporter } from './handler-context.js';
import { handlePlanMessage } from './plan-handlers.js';
import { handleQualityMessage } from './quality-handlers.js';
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
  gitBranches: Map<string, string> = new Map();
  private sessionRegistry: SessionRegistry | null = null;
  allConnections: Set<WSContext> = new Set();
  activeSearches: Map<string, ChildProcess> = new Map();
  terminalListenerCleanups: Map<string, () => void> = new Map();
  terminalSubscribers: Map<string, Set<WSContext>> = new Map();
  fileUploadHandler: FileUploadHandler | null = null;

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
    } catch (error: unknown) {
      console.error('[WebSocketImproviseHandler] Error handling message:', error);
      captureException(error, { context: 'websocket.handleMessage' });
      this.send(ws, {
        type: 'error',
        data: { message: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  /** Dispatch table mapping message types to domain handlers. Built once, looked up per message. */
  private static readonly DISPATCH: Record<string, 'session' | 'history' | 'file' | 'terminal' | 'fileExplorer' | 'git' | 'quality' | 'plan' | 'fileUpload'> = {
    // Session
    execute: 'session', cancel: 'session', getHistory: 'session', new: 'session', approve: 'session', reject: 'session',
    // History
    getSessions: 'history', getSessionsCount: 'history', getSessionById: 'history', deleteSession: 'history', clearHistory: 'history', searchHistory: 'history',
    // File autocomplete/read
    autocomplete: 'file', readFile: 'file', recordSelection: 'file',
    // Terminal
    terminalInit: 'terminal', terminalReconnect: 'terminal', terminalList: 'terminal', terminalInput: 'terminal', terminalResize: 'terminal', terminalClose: 'terminal',
    // File explorer
    listDirectory: 'fileExplorer', writeFile: 'fileExplorer', createFile: 'fileExplorer', createDirectory: 'fileExplorer', deleteFile: 'fileExplorer', renameFile: 'fileExplorer', notifyFileOpened: 'fileExplorer', searchFileContents: 'fileExplorer', cancelSearch: 'fileExplorer', findDefinition: 'fileExplorer',
    // Git
    gitStatus: 'git', gitStage: 'git', gitUnstage: 'git', gitCommit: 'git', gitCommitWithAI: 'git', gitPush: 'git', gitPull: 'git', gitLog: 'git', gitDiscoverRepos: 'git', gitSetDirectory: 'git', gitGetRemoteInfo: 'git', gitCreatePR: 'git', gitGeneratePRDescription: 'git', gitListBranches: 'git', gitCheckout: 'git', gitCreateBranch: 'git', gitDeleteBranch: 'git', gitDiff: 'git', gitShowCommit: 'git', gitCommitDiff: 'git', gitListTags: 'git', gitCreateTag: 'git', gitPushTag: 'git', gitWorktreeList: 'git', gitWorktreeCreate: 'git', gitWorktreeCreateAndAssign: 'git', gitWorktreeRemove: 'git', tabWorktreeSwitch: 'git', gitWorktreePush: 'git', gitWorktreeCreatePR: 'git', gitMergePreview: 'git', gitWorktreeMerge: 'git', gitMergeAbort: 'git', gitMergeComplete: 'git',
    // Quality
    qualityDetectTools: 'quality', qualityScan: 'quality', qualityInstallTools: 'quality', qualityCodeReview: 'quality', qualityFixIssues: 'quality', qualityLoadState: 'quality', qualitySaveDirectories: 'quality',
    // Plan + boards + sprints
    planInit: 'plan', planGetState: 'plan', planListIssues: 'plan', planGetIssue: 'plan', planGetSprint: 'plan', planGetMilestone: 'plan', planCreateIssue: 'plan', planUpdateIssue: 'plan', planDeleteIssue: 'plan', planScaffold: 'plan', planPrompt: 'plan', planExecute: 'plan', planExecuteEpic: 'plan', planPause: 'plan', planStop: 'plan', planResume: 'plan', planCreateBoard: 'plan', planUpdateBoard: 'plan', planArchiveBoard: 'plan', planGetBoard: 'plan', planGetBoardState: 'plan', planReorderBoards: 'plan', planSetActiveBoard: 'plan', planGetBoardArtifacts: 'plan', planCreateSprint: 'plan', planActivateSprint: 'plan', planCompleteSprint: 'plan', planGetSprintArtifacts: 'plan',
    // File upload
    fileUploadStart: 'fileUpload', fileUploadChunk: 'fileUpload', fileUploadComplete: 'fileUpload', fileUploadCancel: 'fileUpload',
  };

  private async dispatchMessage(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'view'): Promise<void> {
    // Handle messages with custom inline logic first
    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong', tabId });
        return;
      case 'initTab':
        return void await initializeTab(this, ws, tabId, workingDir, msg.data?.tabName);
      case 'resumeSession':
        if (!msg.data?.historicalSessionId) throw new Error('Historical session ID is required');
        return void await resumeHistoricalSession(this, ws, tabId, workingDir, msg.data.historicalSessionId);
      case 'requestNotificationSummary':
        if (!msg.data?.prompt || !msg.data?.output) throw new Error('Prompt and output are required for notification summary');
        return void await generateNotificationSummary(this, ws, tabId, msg.data.prompt, msg.data.output, workingDir);
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
      case 'getSettings':
        return handleGetSettings(this, ws);
      case 'updateSettings':
        return handleUpdateSettings(this, ws, msg);
    }

    // Dispatch table lookup for domain handlers
    const domain = WebSocketImproviseHandler.DISPATCH[msg.type];
    if (!domain) throw new Error(`Unknown message type: ${msg.type}`);

    // Resolve effective working directory: use worktree path if tab is on a worktree
    const effectiveDir = this.gitDirectories.get(tabId) || workingDir;

    switch (domain) {
      case 'session':    return handleSessionMessage(this, ws, msg, tabId, permission);
      case 'history':    return handleHistoryMessage(this, ws, msg, tabId, workingDir);
      case 'file':       return handleFileMessage(this, ws, msg, tabId, effectiveDir, permission);
      case 'terminal':   return handleTerminalMessage(this, ws, msg, tabId, workingDir);
      case 'fileExplorer': return handleFileExplorerMessage(this, ws, msg, tabId, effectiveDir, permission);
      case 'git':        return handleGitMessage(this, ws, msg, tabId, workingDir);
      case 'quality':    return handleQualityMessage(this, ws, msg, tabId, workingDir, permission);
      case 'plan':       return handlePlanMessage(this, ws, msg, tabId, workingDir, permission);
      case 'fileUpload': return this.handleFileUploadMessage(ws, msg, tabId, workingDir);
    }
  }

  private handleFileUploadMessage(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
    if (!this.fileUploadHandler) {
      this.fileUploadHandler = new FileUploadHandler(workingDir);
    }
    const handler = this.fileUploadHandler;
    const send = this.send.bind(this);

    switch (msg.type) {
      case 'fileUploadStart':
        handler.handleUploadStart(ws, send, tabId, msg.data);
        break;
      case 'fileUploadChunk':
        handler.handleUploadChunk(ws, send, tabId, msg.data);
        break;
      case 'fileUploadComplete':
        handler.handleUploadComplete(ws, send, tabId, msg.data);
        break;
      case 'fileUploadCancel':
        handler.handleUploadCancel(ws, send, tabId, msg.data);
        break;
    }
  }

  handleClose(ws: WSContext): void {
    // Destroy sessions owned by this connection to free interval timers
    const tabMap = this.connections.get(ws);
    if (tabMap) {
      const sessionIds = new Set(tabMap.values());
      for (const sessionId of sessionIds) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.destroy();
          this.sessions.delete(sessionId);
        }
      }
    }
    this.connections.delete(ws);
    this.allConnections.delete(ws);
    cleanupTerminalSubscribers(this, ws);

    // Clean up file upload handler when no connections remain
    if (this.allConnections.size === 0 && this.fileUploadHandler) {
      this.fileUploadHandler.destroy();
      this.fileUploadHandler = null;
    }
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

}
