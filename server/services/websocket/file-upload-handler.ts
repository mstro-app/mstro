// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Chunked File Upload Handler
 *
 * Receives files in chunks over WebSocket from remote web clients,
 * writes them to .mstro/tmp/attachments/{tabId}/, and sends progress acks back.
 */

import type { WriteStream } from 'node:fs';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

  constructor(private workingDir: string) {
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
    data: { uploadId: string; fileName: string; fileSize: number; mimeType: string; isImage: boolean; totalChunks: number }
  ): void {
    const { uploadId, fileName, fileSize, mimeType, isImage, totalChunks } = data;

    // Validate file size
    if (fileSize > MAX_FILE_SIZE) {
      send(ws, {
        type: 'fileUploadError' as WebSocketResponse['type'],
        tabId,
        data: { uploadId, error: `File too large: ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` }
      });
      return;
    }

    // Create attachment directory
    const attachDir = join(this.workingDir, '.mstro', 'tmp', 'attachments', tabId);
    if (!existsSync(attachDir)) {
      mkdirSync(attachDir, { recursive: true });
    }

    // Handle duplicate file names
    let targetFileName = fileName;
    let counter = 1;
    while (existsSync(join(attachDir, targetFileName))) {
      const ext = fileName.lastIndexOf('.') !== -1 ? fileName.slice(fileName.lastIndexOf('.')) : '';
      const base = fileName.lastIndexOf('.') !== -1 ? fileName.slice(0, fileName.lastIndexOf('.')) : fileName;
      targetFileName = `${base}-${counter}${ext}`;
      counter++;
    }

    const filePath = join(attachDir, targetFileName);
    const stream = createWriteStream(filePath);

    const uploadState: UploadState = {
      uploadId,
      fileName: targetFileName,
      fileSize,
      mimeType,
      isImage,
      totalChunks,
      receivedChunks: 0,
      filePath,
      stream,
      lastActivity: Date.now(),
    };

    this.activeUploads.set(uploadId, uploadState);

    // Send ack for start
    send(ws, {
      type: 'fileUploadAck' as WebSocketResponse['type'],
      tabId,
      data: { uploadId, chunkIndex: -1, status: 'ok' }
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
        const completed: CompletedUpload = {
          uploadId,
          fileName: upload.fileName,
          filePath: upload.filePath,
          isImage: upload.isImage,
          mimeType: upload.mimeType,
          fileSize: stat.size,
        };

        // Store completed upload for this tab
        const tabUploads = this.completedUploads.get(tabId) || [];
        tabUploads.push(completed);
        this.completedUploads.set(tabId, tabUploads);

        this.activeUploads.delete(uploadId);

        send(ws, {
          type: 'fileUploadReady' as WebSocketResponse['type'],
          tabId,
          data: { uploadId, filePath: upload.filePath, fileName: upload.fileName }
        });
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
