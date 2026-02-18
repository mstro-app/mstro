// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * WebSocket Improvise Types
 *
 * Type definitions for WebSocket improvisation sessions.
 */

/**
 * Runtime-agnostic WebSocket context interface
 * Works with both Bun's ServerWebSocket and Node.js ws library
 */
export interface WSContext {
  send(data: string | Buffer): void
  close(): void
  readyState: number
  // Internal properties for tracking
  _workingDir?: string
  _ws?: unknown
}

export interface WebSocketMessage {
  type:
    | 'execute'
    | 'cancel'
    | 'getHistory'
    | 'getSessions'
    | 'getSessionsCount'
    | 'deleteSession'
    | 'getSessionById'
    | 'clearHistory'
    | 'searchHistory'
    | 'new'
    | 'autocomplete'
    | 'readFile'
    | 'ping'
    | 'initTab'
    | 'resumeSession'
    | 'approve'
    | 'reject'
    | 'recordSelection'
    | 'requestNotificationSummary'
    | 'terminalInit'
    | 'terminalReconnect'
    | 'terminalList'
    | 'terminalInitPersistent'
    | 'terminalListPersistent'
    | 'terminalInput'
    | 'terminalResize'
    | 'terminalClose'
    // File explorer message types
    | 'listDirectory'
    | 'writeFile'
    | 'createFile'
    | 'createDirectory'
    | 'deleteFile'
    | 'renameFile'
    | 'notifyFileOpened'
    // Git message types
    | 'gitStatus'
    | 'gitStage'
    | 'gitUnstage'
    | 'gitCommit'
    | 'gitCommitWithAI'
    | 'gitPush'
    | 'gitLog'
    | 'gitDiscoverRepos'
    | 'gitSetDirectory'
    // Session sync message types
    | 'getActiveTabs'
    | 'createTab'
    | 'reorderTabs'
    | 'syncTabMeta'
    | 'syncPromptText'
    | 'removeTab'
    | 'markTabViewed'
    // Settings message types
    | 'getSettings'
    | 'updateSettings';
  tabId?: string;
  terminalId?: string;
  data?: any;
}

export interface WebSocketResponse {
  type:
    | 'output'
    | 'thinking'
    | 'movementStart'
    | 'movementComplete'
    | 'movementError'
    | 'sessionUpdate'
    | 'history'
    | 'sessions'
    | 'sessionsCount'
    | 'sessionDeleted'
    | 'sessionData'
    | 'historyCleared'
    | 'searchResults'
    | 'newSession'
    | 'autocomplete'
    | 'fileContent'
    | 'error'
    | 'pong'
    | 'tabInitialized'
    | 'approvalRequired'
    | 'toolUse'
    | 'notificationSummary'
    | 'terminalOutput'
    | 'terminalReady'
    | 'terminalExit'
    | 'terminalError'
    | 'terminalScrollback'
    | 'terminalList'
    | 'terminalListPersistent'
    // File explorer response types
    | 'directoryListing'
    | 'fileWritten'
    | 'fileCreated'
    | 'directoryCreated'
    | 'fileDeleted'
    | 'fileRenamed'
    | 'fileOpened'
    | 'fileContentChanged'
    // Terminal sync response types
    | 'terminalCreated'
    | 'terminalClosed'
    // Git response types
    | 'gitStatus'
    | 'gitStaged'
    | 'gitUnstaged'
    | 'gitCommitted'
    | 'gitCommitMessage'
    | 'gitPushed'
    | 'gitLog'
    | 'gitError'
    | 'gitReposDiscovered'
    | 'gitDirectorySet'
    // Session sync response types
    | 'activeTabs'
    | 'tabCreated'
    | 'tabRemoved'
    | 'tabRenamed'
    | 'tabsReordered'
    | 'promptTextSync'
    | 'tabViewed'
    | 'tabStateChanged'
    // Settings response types
    | 'settings'
    | 'settingsUpdated';
  tabId?: string;
  terminalId?: string;
  data?: any;
}

export interface ConnectionData {
  tabId: string;
  workingDir: string;
}

// Extended autocomplete option with metadata
export interface AutocompleteResult {
  value: string;
  label: string;
  isDirectory: boolean;
  isRecent: boolean;
  fileType: string;
  matchedIndices: Array<[number, number]>;
}

// Frecency data structure - tracks completion usage
export interface FrecencyEntry {
  count: number;        // Total number of times selected
  lastUsed: number;     // Timestamp of last use
}

export interface FrecencyData {
  [filePath: string]: FrecencyEntry;
}

// Directory cache for performance
export interface CacheEntry {
  files: Array<{ relativePath: string; isDirectory: boolean; fileName: string; depth: number }>;
  timestamp: number;
}

export interface FileMetadata {
  relativePath: string;
  isDirectory: boolean;
  fileName: string;
  depth: number;
}

export interface FileReadResult {
  filePath: string;
  fileName: string;
  content: string;
  isImage?: boolean;
  mimeType?: string;
  error?: string;
}

// ============================================================================
// File Explorer Types
// ============================================================================

/**
 * Directory entry for file explorer listing
 */
export interface DirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
}

/**
 * Message data for listDirectory request
 */
export interface ListDirectoryData {
  dirPath: string;
  showHidden?: boolean;
}

/**
 * Message data for writeFile request
 */
export interface WriteFileData {
  filePath: string;
  content: string;
}

/**
 * Message data for createFile request
 */
export interface CreateFileData {
  filePath: string;
}

/**
 * Message data for createDirectory request
 */
export interface CreateDirectoryData {
  dirPath: string;
}

/**
 * Message data for deleteFile request
 */
export interface DeleteFileData {
  filePath: string;
}

/**
 * Message data for renameFile request
 */
export interface RenameFileData {
  oldPath: string;
  newPath: string;
}

/**
 * Response data for directoryListing
 */
export interface DirectoryListingResponse {
  success: boolean;
  entries?: DirectoryEntry[];
  error?: string;
}

/**
 * Response data for file operations (write, create, delete, rename)
 */
export interface FileOperationResponse {
  success: boolean;
  path?: string;
  error?: string;
}

// ============================================================================
// Git Types
// ============================================================================

/**
 * Git file status entry
 */
export interface GitFileStatus {
  /** File path relative to working directory */
  path: string;
  /** Status code (M=modified, A=added, D=deleted, ?=untracked, R=renamed) */
  status: 'M' | 'A' | 'D' | '?' | 'R' | 'C' | 'U';
  /** Whether the file is staged */
  staged: boolean;
  /** Original path (for renamed files) */
  originalPath?: string;
}

/**
 * Git status response
 */
export interface GitStatusResponse {
  /** Current branch name */
  branch: string;
  /** Whether the repository has uncommitted changes */
  isDirty: boolean;
  /** Staged files */
  staged: GitFileStatus[];
  /** Unstaged/modified files */
  unstaged: GitFileStatus[];
  /** Untracked files */
  untracked: GitFileStatus[];
  /** Number of commits ahead of remote */
  ahead: number;
  /** Number of commits behind remote */
  behind: number;
}

/**
 * Git commit log entry
 */
export interface GitLogEntry {
  /** Commit hash */
  hash: string;
  /** Short hash */
  shortHash: string;
  /** Commit message subject */
  subject: string;
  /** Author name */
  author: string;
  /** Commit date (ISO string) */
  date: string;
}

/**
 * Discovered git repository info
 */
export interface GitRepoInfo {
  /** Path to the git repository (directory containing .git) */
  path: string;
  /** Repository name (directory name) */
  name: string;
  /** Current branch if available */
  branch?: string;
}

/**
 * Git repos discovered response
 */
export interface GitReposDiscoveredResponse {
  /** List of discovered git repositories */
  repos: GitRepoInfo[];
  /** Whether the root working directory is a git repo */
  rootIsGitRepo: boolean;
  /** Currently selected git directory (if any) */
  selectedDirectory: string | null;
}

/**
 * Git directory set response
 */
export interface GitDirectorySetResponse {
  /** The directory that was set */
  directory: string;
  /** Whether the directory is valid (contains .git) */
  isValid: boolean;
}
