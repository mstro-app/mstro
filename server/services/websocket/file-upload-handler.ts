// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Chunked File Upload Handler
 *
 * Receives files in chunks over WebSocket from remote web clients.
 * The destination working directory is passed per-call (effective dir for the tab,
 * which resolves to the worktree path when the tab is on a worktree).
 * - When `targetPath` is provided: streams to <workingDir>/<targetPath> (drag-drop into file tree).
 * - Otherwise: streams to <workingDir>/.mstro/tmp/attachments/{tabId}/ (prompt attachments).
 */

import type { WriteStream } from 'node:fs';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { containsDangerousPatterns, validatePathWithinWorkingDir } from '../pathUtils.js';
import type { HandlerContext } from './handler-context.js';
import type { WebSocketResponse, WSContext } from './types.js';

interface UploadState {
  uploadId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  isImage: boolean;
  totalChunks: number;
  receivedChunks: number;
  filePath: string;
  /** Path relative to workingDir (only set when destination is the file tree, not the attachments dir) */
  targetRelPath?: string;
  stream: WriteStream;
  lastActivity: number;
}

/** Completed upload that's ready to be referenced in an execute message */
export interface CompletedUpload {
  uploadId: string;
  fileName: string;
  filePath: string;
  isImage: boolean;
  mimeType: string;
  fileSize: number;
}

const UPLOAD_TIMEOUT_MS = 120_000; // 2 minutes idle timeout
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export class FileUploadHandler {
  private activeUploads = new Map<string, UploadState>();
  private completedUploads = new Map<string, CompletedUpload[]>(); // tabId -> completed uploads
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(
    private ctx?: HandlerContext,
  ) {
    // Periodically clean up stale uploads
    this.cleanupInterval = setInterval(() => this.cleanupStaleUploads(), 30_000);
  }

  /** Get completed uploads for a tab and clear them */
  getAndClearCompletedUploads(tabId: string): CompletedUpload[] {
    const uploads = this.completedUploads.get(tabId) || [];
    this.completedUploads.delete(tabId);
    return uploads;
  }

  /** Get completed uploads for a tab without clearing */
  getCompletedUploads(tabId: string): CompletedUpload[] {
    return this.completedUploads.get(tabId) || [];
  }

  handleUploadStart(
    ws: WSContext,
    send: (ws: WSContext, response: WebSocketResponse) => void,
    tabId: string,
    data: { uploadId: string; fileName: string; fileSize: number; mimeType: string; isImage: boolean; totalChunks: number; targetPath?: string; overwrite?: boolean },
    workingDir: string,
    permission?: 'view',
  ): void {
    const { uploadId, fileName, fileSize, mimeType, isImage, totalChunks, targetPath, overwrite } = data;
    const sendError = (error: string) => send(ws, {
      type: 'fileUploadError' as WebSocketResponse['type'],
      tabId,
      data: { uploadId, error },
    });

    if (fileSize > MAX_FILE_SIZE) {
      sendError(`File too large: ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`);
      return;
    }

    const resolved = targetPath !== undefined
      ? resolveFileTreeTarget({ targetPath, fileName, workingDir, permission, overwrite })
      : resolveAttachmentTarget({ workingDir, tabId, fileName });

    if (!resolved.ok) {
      sendError(resolved.error);
      return;
    }

    this.activeUploads.set(uploadId, {
      uploadId,
      fileName: resolved.fileName,
      fileSize,
      mimeType,
      isImage,
      totalChunks,
      receivedChunks: 0,
      filePath: resolved.filePath,
      targetRelPath: resolved.targetRelPath,
      stream: createWriteStream(resolved.filePath),
      lastActivity: Date.now(),
    });

    send(ws, {
      type: 'fileUploadAck' as WebSocketResponse['type'],
      tabId,
      data: { uploadId, chunkIndex: -1, status: 'ok' },
    });
  }

  handleUploadChunk(
    ws: WSContext,
    send: (ws: WSContext, response: WebSocketResponse) => void,
    tabId: string,
    data: { uploadId: string; chunkIndex: number; content: string }
  ): void {
    const { uploadId, chunkIndex, content } = data;
    const upload = this.activeUploads.get(uploadId);

    if (!upload) {
      send(ws, {
        type: 'fileUploadError' as WebSocketResponse['type'],
        tabId,
        data: { uploadId, error: 'Upload not found or expired' }
      });
      return;
    }

    try {
      const buffer = Buffer.from(content, 'base64');
      upload.stream.write(buffer);
      upload.receivedChunks++;
      upload.lastActivity = Date.now();

      send(ws, {
        type: 'fileUploadAck' as WebSocketResponse['type'],
        tabId,
        data: { uploadId, chunkIndex, status: 'ok' }
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      send(ws, {
        type: 'fileUploadError' as WebSocketResponse['type'],
        tabId,
        data: { uploadId, error: `Chunk write failed: ${errorMsg}` }
      });
      this.cancelUpload(uploadId);
    }
  }

  handleUploadComplete(
    ws: WSContext,
    send: (ws: WSContext, response: WebSocketResponse) => void,
    tabId: string,
    data: { uploadId: string }
  ): void {
    const { uploadId } = data;
    const upload = this.activeUploads.get(uploadId);

    if (!upload) {
      send(ws, {
        type: 'fileUploadError' as WebSocketResponse['type'],
        tabId,
        data: { uploadId, error: 'Upload not found or expired' }
      });
      return;
    }

    upload.stream.end(() => {
      // Verify file was written
      try {
        const stat = statSync(upload.filePath);

        // Only stash as a pending prompt attachment for the attachment-path case.
        // File-tree drops land at the final destination directly.
        if (upload.targetRelPath === undefined) {
          const completed: CompletedUpload = {
            uploadId,
            fileName: upload.fileName,
            filePath: upload.filePath,
            isImage: upload.isImage,
            mimeType: upload.mimeType,
            fileSize: stat.size,
          };
          const tabUploads = this.completedUploads.get(tabId) || [];
          tabUploads.push(completed);
          this.completedUploads.set(tabId, tabUploads);
        }

        this.activeUploads.delete(uploadId);

        send(ws, {
          type: 'fileUploadReady' as WebSocketResponse['type'],
          tabId,
          data: {
            uploadId,
            filePath: upload.filePath,
            fileName: upload.fileName,
            ...(upload.targetRelPath !== undefined ? { targetPath: upload.targetRelPath } : {}),
          },
        });

        // Broadcast fileCreated so all connected clients (including the uploader)
        // refresh their file tree. The final path may differ from the requested
        // targetPath due to counter-based disambiguation, so we broadcast the resolved path.
        if (upload.targetRelPath !== undefined && this.ctx) {
          this.ctx.broadcastToAll({
            type: 'fileCreated' as WebSocketResponse['type'],
            data: {
              path: upload.targetRelPath,
              name: upload.fileName,
              size: stat.size,
              modifiedAt: new Date().toISOString(),
            },
          });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        send(ws, {
          type: 'fileUploadError' as WebSocketResponse['type'],
          tabId,
          data: { uploadId, error: `File verification failed: ${errorMsg}` }
        });
        this.activeUploads.delete(uploadId);
      }
    });
  }

  handleUploadCancel(
    _ws: WSContext,
    _send: (ws: WSContext, response: WebSocketResponse) => void,
    _tabId: string,
    data: { uploadId: string }
  ): void {
    this.cancelUpload(data.uploadId);
  }

  private cancelUpload(uploadId: string): void {
    const upload = this.activeUploads.get(uploadId);
    if (!upload) return;

    try {
      upload.stream.destroy();
      if (existsSync(upload.filePath)) {
        rmSync(upload.filePath, { force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
    this.activeUploads.delete(uploadId);
  }

  private cleanupStaleUploads(): void {
    const now = Date.now();
    for (const [uploadId, upload] of this.activeUploads) {
      if (now - upload.lastActivity > UPLOAD_TIMEOUT_MS) {
        console.warn(`[FileUploadHandler] Upload ${uploadId} timed out, cleaning up`);
        this.cancelUpload(uploadId);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    for (const uploadId of this.activeUploads.keys()) {
      this.cancelUpload(uploadId);
    }
  }
}

type ResolveResult =
  | { ok: true; filePath: string; fileName: string; targetRelPath?: string }
  | { ok: false; error: string };

function splitExt(fileName: string): { base: string; ext: string } {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return { base: fileName, ext: '' };
  return { base: fileName.slice(0, dot), ext: fileName.slice(dot) };
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function resolveFileTreeTarget(opts: {
  targetPath: string;
  fileName: string;
  workingDir: string;
  permission?: 'view';
  overwrite?: boolean;
}): ResolveResult {
  const { targetPath, fileName, workingDir, permission, overwrite } = opts;

  if (permission === 'view') {
    return { ok: false, error: 'View-only sessions cannot upload files' };
  }
  if (containsDangerousPatterns(targetPath) || containsDangerousPatterns(fileName)) {
    return { ok: false, error: 'Invalid characters in target path' };
  }

  const validation = validatePathWithinWorkingDir(targetPath, workingDir);
  if (!validation.valid) {
    return { ok: false, error: validation.error ?? 'Invalid target path' };
  }

  const resolvedPath = validation.resolvedPath;
  const parent = dirname(resolvedPath);
  try {
    ensureDir(parent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to create parent directory: ${msg}` };
  }

  const lastSlash = targetPath.lastIndexOf('/');
  const relDir = lastSlash >= 0 ? targetPath.slice(0, lastSlash) : '';

  let finalName = fileName;
  let finalAbs = resolvedPath;
  if (existsSync(finalAbs) && !overwrite) {
    const { base, ext } = splitExt(fileName);
    let counter = 1;
    do {
      finalName = `${base} (${counter})${ext}`;
      finalAbs = join(parent, finalName);
      counter++;
    } while (existsSync(finalAbs));
  }

  const finalRel = relDir ? `${relDir}/${finalName}` : finalName;
  return { ok: true, filePath: finalAbs, fileName: finalName, targetRelPath: finalRel };
}

function resolveAttachmentTarget(opts: {
  workingDir: string;
  tabId: string;
  fileName: string;
}): ResolveResult {
  const { workingDir, tabId, fileName } = opts;
  const attachDir = join(workingDir, '.mstro', 'tmp', 'attachments', tabId);
  try {
    ensureDir(attachDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to create attachment directory: ${msg}` };
  }

  let finalName = fileName;
  let counter = 1;
  while (existsSync(join(attachDir, finalName))) {
    const { base, ext } = splitExt(fileName);
    finalName = `${base}-${counter}${ext}`;
    counter++;
  }

  return { ok: true, filePath: join(attachDir, finalName), fileName: finalName };
}
