// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import type { ChildProcess } from 'node:child_process';
import type { ImprovisationSessionManager } from '../../cli/improvisation-session-manager.js';
import type { AutocompleteService } from './autocomplete.js';
import type { FileUploadHandler } from './file-upload-handler.js';
import type { SessionRegistry } from './session-registry.js';
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

  // Registry access
  getRegistry(workingDir: string): SessionRegistry;

  // Communication utilities
  send(ws: WSContext, response: WebSocketResponse): void;
  broadcastToOthers(sender: WSContext, response: WebSocketResponse): void;
  broadcastToAll(response: WebSocketResponse): void;

  // Frecency
  recordFileSelection(filePath: string): void;
}
