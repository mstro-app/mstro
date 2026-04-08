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
    | 'searchFileContents'
    | 'cancelSearch'
    | 'findDefinition'
    // Git message types
    | 'gitStatus'
    | 'gitStage'
    | 'gitUnstage'
    | 'gitCommit'
    | 'gitCommitWithAI'
    | 'gitPush'
    | 'gitPull'
    | 'gitLog'
    | 'gitDiscoverRepos'
    | 'gitSetDirectory'
    | 'gitGetRemoteInfo'
    | 'gitCreatePR'
    | 'gitGeneratePRDescription'
    // Branch operations
    | 'gitListBranches'
    | 'gitCheckout'
    | 'gitCreateBranch'
    | 'gitDeleteBranch'
    // Diff operations
    | 'gitDiff'
    // Commit detail operations
    | 'gitShowCommit'
    | 'gitCommitDiff'
    // Tag operations
    | 'gitListTags'
    | 'gitCreateTag'
    | 'gitPushTag'
    // Worktree operations
    | 'gitWorktreeList'
    | 'gitWorktreeCreate'
    | 'gitWorktreeCreateAndAssign'
    | 'gitWorktreeRemove'
    | 'tabWorktreeSwitch'
    | 'gitWorktreePush'
    | 'gitWorktreeCreatePR'
    // Merge operations
    | 'gitMergePreview'
    | 'gitWorktreeMerge'
    | 'gitMergeAbort'
    | 'gitMergeComplete'
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
    | 'updateSettings'
    // Quality message types
    | 'qualityDetectTools'
    | 'qualityScan'
    | 'qualityInstallTools'
    | 'qualityCodeReview'
    | 'qualityFixIssues'
    | 'qualityLoadState'
    | 'qualitySaveDirectories'
    // File upload message types (chunked remote uploads)
    | 'fileUploadStart'
    | 'fileUploadChunk'
    | 'fileUploadComplete'
    | 'fileUploadCancel'
    // Plan message types
    | 'planInit'
    | 'planGetState'
    | 'planListIssues'
    | 'planGetIssue'
    | 'planGetSprint'
    | 'planGetMilestone'
    | 'planCreateIssue'
    | 'planUpdateIssue'
    | 'planDeleteIssue'
    | 'planScaffold'
    | 'planPrompt'
    | 'planExecute'
    | 'planExecuteEpic'
    | 'planPause'
    | 'planStop'
    | 'planResume'
    // Board lifecycle message types
    | 'planCreateBoard'
    | 'planUpdateBoard'
    | 'planArchiveBoard'
    | 'planGetBoard'
    | 'planGetBoardState'
    | 'planReorderBoards'
    | 'planSetActiveBoard'
    | 'planGetBoardArtifacts'
    // Sprint lifecycle message types (legacy)
    | 'planCreateSprint'
    | 'planActivateSprint'
    | 'planCompleteSprint'
    | 'planGetSprintArtifacts'
    // Deploy message types
    | 'deployCreate'
    | 'deployStop'
    | 'deployResume'
    | 'deployDelete'
    | 'deployList'
    | 'deployGetStatus'
    | 'deployUpdateConfig'
    | 'deploySetApiKey'
    | 'deployValidateApiKey'
    // Deploy HTTP relay message types (server→cli)
    | 'deployHttpRequest'
    // Deploy usage/health message types (cli→server)
    | 'deployUsageReport'
    | 'deployAiHealthUpdate';
  tabId?: string;
  terminalId?: string;
  // biome-ignore lint/suspicious/noExplicitAny: message envelope carries heterogeneous payloads
  data?: any;
  /** Injected by server relay for view-only shared users */
  _permission?: 'view';
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
    | 'streamingTokens'
    | 'notificationSummary'
    | 'terminalOutput'
    | 'terminalReady'
    | 'terminalExit'
    | 'terminalError'
    | 'terminalList'
    // File explorer response types
    | 'directoryListing'
    | 'fileWritten'
    | 'fileCreated'
    | 'directoryCreated'
    | 'fileDeleted'
    | 'fileRenamed'
    | 'fileOpened'
    | 'fileContentChanged'
    | 'contentSearchResults'
    | 'contentSearchComplete'
    | 'contentSearchError'
    | 'definitionResult'
    | 'fileError'
    | 'terminalScrollback'
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
    | 'gitPulled'
    | 'gitLog'
    | 'gitError'
    | 'gitReposDiscovered'
    | 'gitDirectorySet'
    | 'gitRemoteInfo'
    | 'gitPRCreated'
    | 'gitPRDescription'
    // Branch response types
    | 'gitBranchList'
    | 'gitCheckedOut'
    | 'gitBranchCreated'
    | 'gitBranchDeleted'
    // Diff response types
    | 'gitDiffResult'
    // Commit detail response types
    | 'gitCommitDetail'
    | 'gitCommitDiffResult'
    // Tag response types
    | 'gitTagList'
    | 'gitTagCreated'
    | 'gitTagPushed'
    // Worktree response types
    | 'gitWorktreeListResult'
    | 'gitWorktreeCreated'
    | 'gitWorktreeCreatedAndAssigned'
    | 'gitWorktreeRemoved'
    | 'tabWorktreeSwitched'
    | 'gitWorktreePushed'
    | 'gitWorktreePRCreated'
    // Merge response types
    | 'gitMergePreviewResult'
    | 'gitWorktreeMergeResult'
    | 'gitMergeAborted'
    | 'gitMergeCompleted'
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
    | 'settingsUpdated'
    // Quality response types
    | 'qualityToolsDetected'
    | 'qualityScanProgress'
    | 'qualityScanResults'
    | 'qualityInstallProgress'
    | 'qualityInstallComplete'
    | 'qualityCodeReview'
    | 'qualityCodeReviewProgress'
    | 'qualityPostSession'
    | 'qualityFixProgress'
    | 'qualityFixComplete'
    | 'qualityError'
    | 'qualityStateLoaded'
    // File upload response types
    | 'fileUploadAck'
    | 'fileUploadReady'
    | 'fileUploadError'
    // Plan response types
    | 'planState'
    | 'planIssueList'
    | 'planIssue'
    | 'planSprint'
    | 'planMilestone'
    | 'planNotFound'
    | 'planStateUpdated'
    | 'planIssueUpdated'
    | 'planIssueCreated'
    | 'planIssueDeleted'
    | 'planScaffolded'
    | 'planPromptStreaming'
    | 'planPromptProgress'
    | 'planPromptResponse'
    | 'planExecutionStarted'
    | 'planExecutionProgress'
    | 'planExecutionOutput'
    | 'planExecutionMetrics'
    | 'planExecutionComplete'
    | 'planExecutionError'
    | 'planError'
    // Board lifecycle response types
    | 'planBoardCreated'
    | 'planBoardUpdated'
    | 'planBoardArchived'
    | 'planBoardState'
    | 'planBoardArtifacts'
    | 'planWorkspaceUpdated'
    // Sprint lifecycle response types (legacy)
    | 'planSprintCreated'
    | 'planSprintUpdated'
    | 'planSprintCompleted'
    | 'planSprintArtifacts'
    | 'planReviewProgress'
    // Deploy response types
    | 'deployCreated'
    | 'deployStopped'
    | 'deployResumed'
    | 'deployDeleted'
    | 'deployListResult'
    | 'deployStatusResult'
    | 'deployConfigUpdated'
    | 'deployApiKeyStatus'
    | 'deployError'
    // Deploy HTTP relay response types (cli→server)
    | 'deployHttpResponse'
    | 'deployHttpResponseChunk'
    | 'deployStatus'
    | 'deployUsageReportAck'
    | 'deployAiHealthAck';
  tabId?: string;
  terminalId?: string;
  // biome-ignore lint/suspicious/noExplicitAny: message envelope carries heterogeneous payloads
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
  /** Whether the branch has an upstream tracking branch */
  hasUpstream: boolean;
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
 * File changed in a commit
 */
export interface GitCommitFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  oldPath?: string;
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

// ============================================================================
// Branch Types
// ============================================================================

export interface GitBranchEntry {
  /** Branch name, e.g. "feat/auth" or "origin/main" */
  name: string;
  /** Short commit hash */
  shortHash: string;
  /** Whether this is a remote branch */
  isRemote: boolean;
  /** Whether this is the currently checked out branch */
  isCurrent: boolean;
  /** Tracking branch, e.g. "origin/feat/auth" */
  upstream?: string;
}

// ============================================================================
// Tag Types
// ============================================================================

export interface GitTagEntry {
  /** Tag name */
  name: string;
  /** Short commit hash */
  shortHash: string;
  /** Creation date (ISO string) */
  date: string;
  /** Tag message (empty for lightweight tags) */
  message: string;
}

// ============================================================================
// Worktree Types
// ============================================================================

export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  path: string;
  /** Branch checked out in this worktree */
  branch: string;
  /** HEAD commit hash */
  head: string;
  /** Whether this is the main working tree */
  isMain: boolean;
  /** Whether this is a bare repository */
  isBare: boolean;
  /** Whether this worktree can be pruned */
  prunable?: boolean;
}

// ============================================================================
// Merge Types
// ============================================================================

export interface MergePreviewResult {
  /** Whether the merge can be done cleanly */
  clean: boolean;
  /** List of conflicting file paths */
  conflicts: string[];
  /** Diff stat summary */
  stat: string;
  /** List of commits to be merged */
  commits: { hash: string; message: string }[];
  /** Number of commits ahead */
  ahead: number;
}

export interface WorktreeMergeResult {
  /** Whether the merge succeeded */
  success: boolean;
  /** Merge commit hash (if successful) */
  mergeCommit?: string;
  /** Error message (if failed) */
  error?: string;
  /** List of conflicting files (if conflicts) */
  conflictFiles?: string[];
}

// ============================================================================
// Deploy Types
// ============================================================================

/**
 * Deployment status
 */
export type DeploymentStatus = 'running' | 'stopped' | 'error' | 'starting' | 'stopping';

/**
 * Deployment configuration
 */
export interface DeployConfig {
  /** Subdomain for the deployment (e.g. "my-app" -> my-app.mstro.app) */
  subdomain: string;
  /** Local port to expose */
  port: number;
  /** Whether AI features are enabled for this deployment */
  aiEnabled: boolean;
  /** Custom domain if configured */
  customDomain?: string;
}

/**
 * Deployment info returned in responses
 */
export interface DeploymentInfo {
  /** Unique deployment identifier */
  deploymentId: string;
  /** Deployment configuration */
  config: DeployConfig;
  /** Current deployment status */
  status: DeploymentStatus;
  /** Public URL of the deployment */
  url: string;
  /** When the deployment was created (ISO string) */
  createdAt: string;
  /** When the deployment was last updated (ISO string) */
  updatedAt: string;
}

/**
 * Message data for deployCreate request
 */
export interface DeployCreateData {
  /** Subdomain for the deployment */
  subdomain: string;
  /** Local port to expose */
  port: number;
  /** Whether AI features are enabled */
  aiEnabled: boolean;
}

/**
 * Message data for deployStop request
 */
export interface DeployStopData {
  /** ID of the deployment to stop */
  deploymentId: string;
}

/**
 * Message data for deployResume request
 */
export interface DeployResumeData {
  /** ID of the deployment to resume */
  deploymentId: string;
}

/**
 * Message data for deployDelete request
 */
export interface DeployDeleteData {
  /** ID of the deployment to delete */
  deploymentId: string;
}

/**
 * Message data for deployGetStatus request
 */
export interface DeployGetStatusData {
  /** ID of the deployment to get status for */
  deploymentId: string;
}

/**
 * Message data for deployUpdateConfig request
 */
export interface DeployUpdateConfigData {
  /** ID of the deployment to update */
  deploymentId: string;
  /** Partial config to update */
  config: Partial<DeployConfig>;
}

/**
 * Message data for deploySetApiKey request
 * Note: API key transits via WSS but is never stored or logged by the server relay
 */
export interface DeploySetApiKeyData {
  /** The API key to set */
  apiKey: string;
}

/**
 * Response data for deployCreated
 */
export interface DeployCreatedResponse {
  /** The created deployment */
  deployment: DeploymentInfo;
}

/**
 * Response data for deployStopped
 */
export interface DeployStoppedResponse {
  /** ID of the stopped deployment */
  deploymentId: string;
}

/**
 * Response data for deployResumed
 */
export interface DeployResumedResponse {
  /** ID of the resumed deployment */
  deploymentId: string;
}

/**
 * Response data for deployDeleted
 */
export interface DeployDeletedResponse {
  /** ID of the deleted deployment */
  deploymentId: string;
}

/**
 * Response data for deployListResult
 */
export interface DeployListResultResponse {
  /** All deployments for this orchestra */
  deployments: DeploymentInfo[];
}

/**
 * Response data for deployStatusResult
 */
export interface DeployStatusResultResponse {
  /** The requested deployment */
  deployment: DeploymentInfo;
}

/**
 * Response data for deployConfigUpdated
 */
export interface DeployConfigUpdatedResponse {
  /** The updated deployment */
  deployment: DeploymentInfo;
}

/**
 * Response data for deployApiKeyStatus
 * Note: Never includes the full API key — only the last four characters
 */
export interface DeployApiKeyStatusResponse {
  /** Validation status of the API key */
  status: 'valid' | 'invalid' | 'missing' | 'rate_limited';
  /** Last four characters of the API key (for display) */
  lastFour?: string;
  /** Where the key was detected from */
  source?: 'env' | 'stored';
}

/**
 * Response data for deployError
 */
export interface DeployErrorResponse {
  /** Error message */
  error: string;
  /** The deployment ID that caused the error, if applicable */
  deploymentId?: string;
}

// ============================================================================
// Deploy HTTP Relay Types
// ============================================================================

/**
 * Message data for deployHttpRequest (server→cli)
 * Represents an inbound HTTP request to be handled by the CLI
 */
export interface DeployHttpRequestData {
  /** UUID for correlating this request with its response */
  requestId: string;
  /** HTTP method (GET, POST, PUT, DELETE, etc.) */
  method: string;
  /** Request URL path with query string (e.g. "/api/hello?name=world") */
  url: string;
  /** HTTP request headers */
  headers: Record<string, string>;
  /** HTTP request body (may be undefined for GET/HEAD) */
  body?: string;
  /** ID of the deployment this request is for */
  deploymentId: string;
  /** Local port of the developer's server to proxy to */
  port: number;
}

/**
 * Response data for deployHttpResponse (cli→server)
 * The CLI's response to a proxied HTTP request
 */
export interface DeployHttpResponseData {
  /** UUID matching the original deployHttpRequest */
  requestId: string;
  /** HTTP status code */
  status: number;
  /** HTTP response headers */
  headers: Record<string, string>;
  /** HTTP response body */
  body?: string;
}

/**
 * Response data for deployHttpResponseChunk (cli→server)
 * A chunk of a large HTTP response streamed over multiple WebSocket messages
 */
export interface DeployHttpResponseChunkData {
  /** UUID matching the original deployHttpRequest */
  requestId: string;
  /** Zero-based index of this chunk */
  chunkIndex: number;
  /** Total number of chunks (known after reading the full response) */
  totalChunks: number;
  /** Base64-encoded chunk data */
  data: string;
  /** Whether this is the last chunk */
  isLast: boolean;
  /** HTTP status code (sent with first chunk) */
  status?: number;
  /** HTTP response headers (sent with first chunk) */
  headers?: Record<string, string>;
}

/**
 * Response data for deployStatus (cli→server)
 * Status update for a deployment
 */
export interface DeployStatusData {
  /** ID of the deployment */
  deploymentId: string;
  /** Current status of the deployment */
  status: DeploymentStatus;
}

// ============================================================================
// Deploy Usage & Health Types
// ============================================================================

/**
 * Message data for deployUsageReport (cli→server)
 * Sent after each AI execution. Contains metadata only — never prompts or responses.
 */
export interface DeployUsageReportData {
  /** ID of the deployment */
  deploymentId: string;
  /** End user who triggered the execution */
  endUserId: string;
  /** AI capability used */
  capability: 'headless' | 'pm-board';
  /** Total tokens consumed (input + output) */
  tokensUsed: number;
  /** Model used for execution */
  model: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Optional board ID if capability was pm-board */
  boardId?: string;
}

/**
 * AI health status values
 */
export type DeployAiHealthStatus = 'healthy' | 'invalid_key' | 'no_credits' | 'rate_limited' | 'unknown_error';

/**
 * Message data for deployAiHealthUpdate (cli→server)
 * Sent when the CLI detects an API key or AI service issue.
 */
export interface DeployAiHealthUpdateData {
  /** ID of the deployment */
  deploymentId: string;
  /** Current AI health status */
  status: DeployAiHealthStatus;
  /** Human-readable error message */
  message: string;
  /** Whether AI features are currently disabled locally */
  aiDisabled: boolean;
}
