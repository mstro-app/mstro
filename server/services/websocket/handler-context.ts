// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import type { ChildProcess } from 'node:child_process';
import type { ImprovisationSessionManager } from '../../cli/improvisation-session-manager.js';
import type { AutocompleteService } from './autocomplete.js';
import type { FileUploadHandler } from './file-upload-handler.js';
import type { GitHeadWatcher } from './git-head-watcher.js';
import type { MsgIdTracker } from './msg-id-tracker.js';
import type { SessionRegistry } from './session-registry.js';
import type { SkillsWatcher } from './skill-watcher.js';
import type { TabEventBufferRegistry } from './tab-event-buffer.js';
import type { WebSocketResponse, WSContext } from './types.js';

export interface UsageReport {
  tokensUsed: number;
  sessionId?: string;
  movementId?: string;
}

export type UsageReporter = (report: UsageReport) => void;

/**
 * Shared context passed to all domain handler functions.
 * The WebSocketImproviseHandler class satisfies this interface directly.
 */
export interface HandlerContext {
  // Shared state
  sessions: Map<string, ImprovisationSessionManager>;
  connections: Map<WSContext, Map<string, string>>;
  allConnections: Set<WSContext>;
  gitDirectories: Map<string, string>;
  gitBranches: Map<string, string>;
  activeSearches: Map<string, ChildProcess>;
  terminalSubscribers: Map<string, Set<WSContext>>;
  terminalListenerCleanups: Map<string, () => void>;
  autocompleteService: AutocompleteService;
  usageReporter: UsageReporter | null;
  fileUploadHandler: FileUploadHandler | null;
  gitHeadWatcher: GitHeadWatcher | null;
  skillsWatcher: SkillsWatcher | null;
  /**
   * Per-tab replay buffer for tab-scoped broadcasts. Populated by
   * `broadcastTabEvent` (see `tab-broadcast.ts`) so a web client rejoining a
   * tab after a reconnect can request replay of anything it missed during
   * the transport gap. See `tab-event-buffer.ts`.
   */
  tabEventBuffers: TabEventBufferRegistry;
  /**
   * Idempotency tracker for `execute` `msgId`s. Lets the web replay the
   * same prompt across reconnects without causing double execution — the
   * CLI still acks, but skips running the prompt a second time.
   */
  msgIdTracker: MsgIdTracker;

  // Registry access
  getRegistry(workingDir: string): SessionRegistry;

  // Communication utilities
  send(ws: WSContext, response: WebSocketResponse): void;
  broadcastToOthers(sender: WSContext, response: WebSocketResponse): void;
  broadcastToAll(response: WebSocketResponse): void;

  // Frecency
  recordFileSelection(filePath: string): void;
}
