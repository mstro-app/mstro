// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import {
  createDirectory,
  createFile,
  deleteFile,
  listDirectory,
  renameFile,
  writeFile
} from '../files.js';
import { validatePathWithinWorkingDir } from '../pathUtils.js';
import { handleFindDefinition } from './file-definition-handlers.js';
import { handleCancelSearch, handleSearchFileContents } from './file-search-handlers.js';
import { readFileContent } from './file-utils.js';
import type { HandlerContext } from './handler-context.js';
import type { WebSocketMessage, WebSocketResponse, WSContext } from './types.js';

export function handleFileMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'view'): void {
  const isSandboxed = !!permission;
  switch (msg.type) {
    case 'autocomplete':
      if (!msg.data?.partialPath) throw new Error('Partial path is required');
      ctx.send(ws, { type: 'autocomplete', tabId, data: { completions: ctx.autocompleteService.getFileCompletions(msg.data.partialPath, workingDir, isSandboxed || undefined) } });
      break;
    case 'readFile':
      handleReadFile(ctx, ws, msg, tabId, workingDir, permission);
      break;
    case 'recordSelection':
      if (msg.data?.filePath) {
        if (isSandboxed) {
          const validation = validatePathWithinWorkingDir(msg.data.filePath, workingDir);
          if (!validation.valid) break; // Silently ignore out-of-bounds selections
        }
        ctx.recordFileSelection(msg.data.filePath);
      }
      break;
  }
}

function handleReadFile(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'view'): void {
  if (!msg.data?.filePath) throw new Error('File path is required');
  const isSandboxed = !!permission;
  if (isSandboxed) {
    const validation = validatePathWithinWorkingDir(msg.data.filePath, workingDir);
    if (!validation.valid) {
      ctx.send(ws, { type: 'fileContent', tabId, data: { path: msg.data.filePath, fileName: msg.data.filePath.split('/').pop() || '', content: '', error: 'Sandboxed: path outside project directory' } });
      return;
    }
  }
  ctx.send(ws, { type: 'fileContent', tabId, data: readFileContent(msg.data.filePath, workingDir) });
}

function sendFileResult(ctx: HandlerContext, ws: WSContext, type: WebSocketResponse['type'], tabId: string, result: { success: boolean; path?: string; error?: string }, successData?: Record<string, unknown>): void {
  const data = result.success
    ? { success: true, path: result.path, ...successData }
    : { success: false, path: result.path, error: result.error };
  ctx.send(ws, { type, tabId, data });
}

export function handleFileExplorerMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string, permission?: 'view'): void {
  const isSandboxed = !!permission;
  const handlers: Record<string, () => void> = {
    listDirectory: () => {
      if (isSandboxed && msg.data?.dirPath) {
        const validation = validatePathWithinWorkingDir(msg.data.dirPath, workingDir);
        if (!validation.valid) {
          ctx.send(ws, { type: 'directoryListing', tabId, data: { success: false, path: msg.data.dirPath, error: 'Sandboxed: path outside project directory' } });
          return;
        }
      }
      handleListDirectory(ctx, ws, msg, tabId, workingDir);
    },
    writeFile: () => {
      if (isSandboxed && msg.data?.filePath) {
        const validation = validatePathWithinWorkingDir(msg.data.filePath, workingDir);
        if (!validation.valid) { ctx.send(ws, { type: 'fileError', tabId, data: { operation: 'writeFile', path: msg.data.filePath, error: 'Sandboxed: path outside project directory' } }); return; }
      }
      handleWriteFile(ctx, ws, msg, tabId, workingDir);
    },
    createFile: () => {
      if (isSandboxed && msg.data?.filePath) {
        const validation = validatePathWithinWorkingDir(msg.data.filePath, workingDir);
        if (!validation.valid) { ctx.send(ws, { type: 'fileError', tabId, data: { operation: 'createFile', path: msg.data.filePath, error: 'Sandboxed: path outside project directory' } }); return; }
      }
      handleCreateFile(ctx, ws, msg, tabId, workingDir);
    },
    createDirectory: () => {
      if (isSandboxed && msg.data?.dirPath) {
        const validation = validatePathWithinWorkingDir(msg.data.dirPath, workingDir);
        if (!validation.valid) { ctx.send(ws, { type: 'fileError', tabId, data: { operation: 'createDirectory', path: msg.data.dirPath, error: 'Sandboxed: path outside project directory' } }); return; }
      }
      handleCreateDirectory(ctx, ws, msg, tabId, workingDir);
    },
    deleteFile: () => {
      if (isSandboxed && msg.data?.filePath) {
        const validation = validatePathWithinWorkingDir(msg.data.filePath, workingDir);
        if (!validation.valid) { ctx.send(ws, { type: 'fileError', tabId, data: { operation: 'deleteFile', path: msg.data.filePath, error: 'Sandboxed: path outside project directory' } }); return; }
      }
      handleDeleteFile(ctx, ws, msg, tabId, workingDir);
    },
    renameFile: () => {
      if (isSandboxed) {
        const oldValidation = msg.data?.oldPath ? validatePathWithinWorkingDir(msg.data.oldPath, workingDir) : { valid: false };
        const newValidation = msg.data?.newPath ? validatePathWithinWorkingDir(msg.data.newPath, workingDir) : { valid: false };
        if (!oldValidation.valid || !newValidation.valid) {
          ctx.send(ws, { type: 'fileError', tabId, data: { operation: 'renameFile', path: msg.data?.oldPath || '', error: 'Sandboxed: path outside project directory' } });
          return;
        }
      }
      handleRenameFile(ctx, ws, msg, tabId, workingDir);
    },
    notifyFileOpened: () => handleNotifyFileOpened(ctx, ws, msg, workingDir),
    searchFileContents: () => {
      if (isSandboxed && msg.data?.query) {
        const searchPath = msg.data.path || msg.data.dirPath;
        if (searchPath) {
          const validation = validatePathWithinWorkingDir(searchPath, workingDir);
          if (!validation.valid) {
            ctx.send(ws, { type: 'contentSearchError', tabId, data: { error: 'Sandboxed: search path outside project directory' } });
            return;
          }
        }
      }
      handleSearchFileContents(ctx, ws, msg, tabId, workingDir);
    },
    cancelSearch: () => handleCancelSearch(ctx, tabId),
    findDefinition: () => {
      if (isSandboxed && msg.data?.filePath) {
        const validation = validatePathWithinWorkingDir(msg.data.filePath, workingDir);
        if (!validation.valid) {
          ctx.send(ws, { type: 'definitionResult', tabId, data: { definitions: [], symbol: msg.data.symbol || '' } });
          return;
        }
      }
      handleFindDefinition(ctx, ws, msg, tabId, workingDir);
    },
  };
  const handler = handlers[msg.type];
  if (!handler) return;

  try {
    handler();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    ctx.send(ws, {
      type: 'fileError',
      tabId,
      data: { operation: msg.type, path: msg.data?.dirPath || msg.data?.filePath || '', error: errorMessage },
    });
  }
}

function handleListDirectory(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  if (msg.data?.dirPath === undefined) throw new Error('Directory path is required');
  const result = listDirectory(msg.data.dirPath, workingDir, msg.data.showHidden ?? false);
  ctx.send(ws, { type: 'directoryListing', tabId, data: result.success ? { success: true, path: msg.data.dirPath, entries: result.entries } : { success: false, path: msg.data.dirPath, error: result.error } });
}

function handleWriteFile(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  if (!msg.data?.filePath) throw new Error('File path is required');
  if (msg.data.content === undefined) throw new Error('Content is required');
  const encoding = msg.data.encoding === 'base64' ? 'base64' as const : undefined;
  const result = writeFile(msg.data.filePath, msg.data.content, workingDir, encoding);
  sendFileResult(ctx, ws, 'fileWritten', tabId, result);
  if (result.success) {
    ctx.broadcastToOthers(ws, {
      type: 'fileContentChanged',
      data: { path: result.path, content: msg.data.content }
    });
  }
}

function handleCreateFile(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  if (!msg.data?.filePath) throw new Error('File path is required');
  const result = createFile(msg.data.filePath, workingDir);
  sendFileResult(ctx, ws, 'fileCreated', tabId, result);
  if (result.success && result.path) {
    const name = result.path.split('/').pop() || 'unknown';
    ctx.broadcastToOthers(ws, {
      type: 'fileCreated',
      data: { path: result.path, name, size: 0, modifiedAt: new Date().toISOString() }
    });
  }
}

function handleCreateDirectory(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  if (!msg.data?.dirPath) throw new Error('Directory path is required');
  const result = createDirectory(msg.data.dirPath, workingDir);
  sendFileResult(ctx, ws, 'directoryCreated', tabId, result);
  if (result.success && result.path) {
    const name = result.path.split('/').pop() || 'unknown';
    ctx.broadcastToOthers(ws, {
      type: 'directoryCreated',
      data: { path: result.path, name }
    });
  }
}

function handleDeleteFile(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  if (!msg.data?.filePath) throw new Error('File path is required');
  const result = deleteFile(msg.data.filePath, workingDir);
  sendFileResult(ctx, ws, 'fileDeleted', tabId, result);
  if (result.success && result.path) {
    ctx.broadcastToOthers(ws, {
      type: 'fileDeleted',
      data: { path: result.path }
    });
  }
}

function handleRenameFile(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): void {
  if (!msg.data?.oldPath) throw new Error('Old path is required');
  if (!msg.data?.newPath) throw new Error('New path is required');
  const result = renameFile(msg.data.oldPath, msg.data.newPath, workingDir);
  const renamedName = result.path?.split('/').pop() || 'unknown';
  sendFileResult(ctx, ws, 'fileRenamed', tabId, result, { oldPath: msg.data.oldPath, newPath: result.path, name: renamedName });
  if (result.success && result.path) {
    const name = result.path.split('/').pop() || 'unknown';
    ctx.broadcastToOthers(ws, {
      type: 'fileRenamed',
      data: { oldPath: msg.data.oldPath, newPath: result.path, name }
    });
  }
}

function handleNotifyFileOpened(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, workingDir: string): void {
  if (!msg.data?.filePath) return;
  const fileData = readFileContent(msg.data.filePath, workingDir);
  if (!fileData.error) {
    ctx.broadcastToOthers(ws, {
      type: 'fileOpened',
      data: {
        path: msg.data.filePath,
        fileName: fileData.fileName,
        content: fileData.content
      }
    });
  }
}
