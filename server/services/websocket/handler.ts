// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

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
import { getPTYManager } from '../terminal/pty-manager.js';
import { AutocompleteService } from './autocomplete.js';
import { FileDownloadHandler } from './file-download-handler.js';
import { handleFileExplorerMessage, handleFileMessage } from './file-explorer-handlers.js';
import { FileUploadHandler } from './file-upload-handler.js';
import { handleGitMessage } from './git-handlers.js';
import { GitHeadWatcher } from './git-head-watcher.js';
import type { HandlerContext, UsageReporter } from './handler-context.js';
import { MsgIdTracker } from './msg-id-tracker.js';
import { handlePlanMessage } from './plan-handlers.js';
import { handleQualityMessage } from './quality-handlers.js';
import { handleHistoryMessage, handleSessionMessage, initializeTab, restoreWorktreeFromRegistry, resumeHistoricalSession } from './session-handlers.js';
import { SessionRegistry } from './session-registry.js';
import { generateNotificationSummary, handleGetSettings, handleUpdateSettings } from './settings-handlers.js';
import { handleListSkills } from './skill-handlers.js';
import { SkillsWatcher } from './skill-watcher.js';
import { TabEventBufferRegistry } from './tab-event-buffer.js';
import { handleCreateTab, handleGetActiveTabs, handleMarkTabViewed, handleRemoveTab, handleReorderTabs, handleSyncTabMeta } from './tab-handlers.js';
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
  fileDownloadHandler: FileDownloadHandler | null = null;
  gitHeadWatcher: GitHeadWatcher | null = null;
  skillsWatcher: SkillsWatcher | null = null;
  tabEventBuffers: TabEventBufferRegistry = new TabEventBufferRegistry();
  msgIdTracker: MsgIdTracker = new MsgIdTracker();

  constructor() {
    this.frecencyPath = join(homedir(), '.mstro', 'autocomplete-frecency.json');
    const frecencyData = this.loadFrecencyData();
    this.autocompleteService = new AutocompleteService(frecencyData);
    process.on('exit', () => {
      if (this.frecencySaveTimer) {
        clearTimeout(this.frecencySaveTimer);
        this.saveFrecencyData();
      }
    });
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

  private frecencySaveTimer: ReturnType<typeof setTimeout> | null = null;

  recordFileSelection(filePath: string): void {
    this.autocompleteService.recordFileSelection(filePath);
    if (!this.frecencySaveTimer) {
      this.frecencySaveTimer = setTimeout(() => {
        this.frecencySaveTimer = null;
        this.saveFrecencyData();
      }, 2000);
    }
  }

  handleConnection(ws: WSContext, workingDir: string): void {
    this.connections.set(ws, new Map());
    this.allConnections.add(ws);

    if (!this.gitHeadWatcher && workingDir) {
      this.gitHeadWatcher = new GitHeadWatcher(workingDir, this);
      this.gitHeadWatcher.start();
    }
    if (!this.skillsWatcher && workingDir) {
      this.skillsWatcher = new SkillsWatcher(workingDir, this);
      this.skillsWatcher.start();
    }
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
  private static readonly DISPATCH: Record<string, 'session' | 'history' | 'file' | 'terminal' | 'fileExplorer' | 'git' | 'quality' | 'plan' | 'fileUpload' | 'fileDownload'> = {
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
    qualityDetectTools: 'quality', qualityScan: 'quality', qualityInstallTools: 'quality', qualityCodeReview: 'quality', qualityLoadState: 'quality', qualitySaveDirectories: 'quality',
    // Plan + boards + sprints
    planInit: 'plan', planGetState: 'plan', planListIssues: 'plan', planGetIssue: 'plan', planGetSprint: 'plan', planGetMilestone: 'plan', planCreateIssue: 'plan', planUpdateIssue: 'plan', planDeleteIssue: 'plan', planScaffold: 'plan', planPrompt: 'plan', planExecute: 'plan', planExecuteEpic: 'plan', planPause: 'plan', planStop: 'plan', planResume: 'plan', planCreateBoard: 'plan', planUpdateBoard: 'plan', planArchiveBoard: 'plan', planGetBoard: 'plan', planGetBoardState: 'plan', planReorderBoards: 'plan', planSetActiveBoard: 'plan', planGetBoardArtifacts: 'plan', planCreateSprint: 'plan', planActivateSprint: 'plan', planCompleteSprint: 'plan', planGetSprintArtifacts: 'plan', chatToBoard: 'plan',
    // File upload
    fileUploadStart: 'fileUpload', fileUploadChunk: 'fileUpload', fileUploadComplete: 'fileUpload', fileUploadCancel: 'fileUpload',
    // File download (chunked streaming for large binaries)
    fileDownloadStart: 'fileDownload', fileDownloadCancel: 'fileDownload',
  };

  private async dispatchMessage(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'view'): Promise<void> {
    // Handle messages with custom inline logic first
    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong', tabId });
        return;
      case 'initTab':
        return void await initializeTab(this, ws, tabId, workingDir, msg.data?.tabName, msg.data);
      case 'resumeSession':
        if (!msg.data?.historicalSessionId) throw new Error('Historical session ID is required');
        return void await resumeHistoricalSession(this, ws, tabId, workingDir, msg.data.historicalSessionId, msg.data);
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
      case 'removeTab':
        return handleRemoveTab(this, ws, tabId, workingDir);
      case 'markTabViewed':
        return handleMarkTabViewed(this, ws, tabId, workingDir);
      case 'getSettings':
        return handleGetSettings(this, ws);
      case 'updateSettings':
        if (permission === 'view') return;
        return handleUpdateSettings(this, ws, msg);
      case 'listSkills':
        return handleListSkills(this, ws, workingDir);
    }

    // Dispatch table lookup for domain handlers
    const domain = WebSocketImproviseHandler.DISPATCH[msg.type];
    if (!domain) throw new Error(`Unknown message type: ${msg.type}`);

    // Hydrate worktree state from the registry before any domain handler
    // reads it, so git/file/autocomplete ops route to the tab's worktree
    // even when they arrive before the initTab handshake completes. The
    // registry is authoritative; the in-memory Map is just a cache.
    if (msg.tabId && !this.gitDirectories.has(tabId)) {
      restoreWorktreeFromRegistry(this, this.getRegistry(workingDir), tabId);
    }

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
      case 'fileUpload': return this.handleFileUploadMessage(ws, msg, tabId, effectiveDir, permission);
      case 'fileDownload': return this.handleFileDownloadMessage(ws, msg, tabId, effectiveDir);
    }
  }

  private handleFileDownloadMessage(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
    if (!this.fileDownloadHandler) {
      this.fileDownloadHandler = new FileDownloadHandler(workingDir);
    }
    const handler = this.fileDownloadHandler;
    const send = this.send.bind(this);

    switch (msg.type) {
      case 'fileDownloadStart':
        handler.handleDownloadStart(ws, send, tabId, msg.data);
        break;
      case 'fileDownloadCancel':
        handler.handleDownloadCancel(ws, send, tabId, msg.data);
        break;
    }
  }

  private handleFileUploadMessage(ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'view'): void {
    if (!this.fileUploadHandler) {
      this.fileUploadHandler = new FileUploadHandler(this);
    }
    const handler = this.fileUploadHandler;
    const send = this.send.bind(this);

    switch (msg.type) {
      case 'fileUploadStart':
        handler.handleUploadStart(ws, send, tabId, msg.data, workingDir, permission);
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
    const tabMap = this.connections.get(ws);
    if (tabMap) {
      this.cleanupConnectionResources(tabMap);
    }
    this.connections.delete(ws);
    this.allConnections.delete(ws);
    cleanupTerminalSubscribers(this, ws);

    // Clean up resources when no connections remain
    if (this.allConnections.size === 0) {
      if (this.fileUploadHandler) {
        this.fileUploadHandler.destroy();
        this.fileUploadHandler = null;
      }
      if (this.fileDownloadHandler) {
        this.fileDownloadHandler.destroy();
        this.fileDownloadHandler = null;
      }
      if (this.gitHeadWatcher) {
        this.gitHeadWatcher.stop();
        this.gitHeadWatcher = null;
      }
      if (this.skillsWatcher) {
        this.skillsWatcher.stop();
        this.skillsWatcher = null;
      }

      // Close orphan PTYs when no web client is watching any more.
      //
      // Prior behavior: PTYs survived until the user typed `exit` or the
      // CLI process died. A page refresh / browser tab close / view-switch
      // would leak the pty, and after a few of these the user would have
      // tens of zombie shells competing for I/O bandwidth, which manifests
      // as the app feeling "unresponsive" — interactive operations starve
      // because the relay socket is saturated streaming output for ptys
      // that no UI is rendering.
      //
      // The active-session preservation in `cleanupConnectionResources`
      // above is intentionally separate: improvise sessions can produce
      // useful work while the browser is closed (Claude Code keeps running
      // in the background); a shell process can't, by construction. So we
      // preserve the former and reap the latter.
      const ptyManager = getPTYManager();
      const activeTerminals = ptyManager.getActiveTerminals();
      if (activeTerminals.length > 0) {
        console.log(`[handler] No web subscribers — closing ${activeTerminals.length} orphan PTY${activeTerminals.length === 1 ? '' : 's'}`);
        ptyManager.closeAll();
      }
    }
  }

  private cleanupConnectionResources(tabMap: Map<string, string>): void {
    // Preserve actively-executing sessions across web reconnects. The runner
    // is still producing output, and the new web connection will re-attach
    // via session-handlers.ts::getSession (or initializeTab → reattachSession)
    // which rebinds listeners and replays executionEventLog. Destroying the
    // session here would orphan the runner and silently drop all streamed
    // output for the rest of the prompt.
    const sessionIds = new Set(tabMap.values());
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      if (session.isExecuting) continue;
      session.destroy();
      this.sessions.delete(sessionId);
    }
    // Kill search processes owned by this connection's tabs
    for (const tabId of tabMap.keys()) {
      const searchProcess = this.activeSearches.get(tabId);
      if (searchProcess) {
        try { searchProcess.kill(); } catch { /* ignore */ }
        this.activeSearches.delete(tabId);
      }
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
