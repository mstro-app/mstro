// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * WebSocket Improvise Module
 *
 * Re-exports all WebSocket handler components for backward compatibility.
 */


// Services
export { AutocompleteService } from './autocomplete.js';
// Utilities
export {
  CACHE_TTL_MS, 
  directoryCache,
  FILE_TYPE_MAP,
  getFileType,
  isIgnored,
  isImageFile,
  isPathInSafeLocation,
  parseGitignore,
  readFileContent,
  scanDirectoryRecursiveWithDepth
} from './file-utils.js';
// Main handler class
export { WebSocketImproviseHandler } from './handler.js';
export type { HandlerContext, UsageReport, UsageReporter } from './handler-context.js';
// Types
export type {
  AutocompleteResult,
  CacheEntry,
  ConnectionData,
  FileMetadata,
  FileReadResult, 
  FrecencyData,
  FrecencyEntry,
  WebSocketMessage,
  WebSocketResponse
} from './types.js';
