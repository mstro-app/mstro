// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Chunked File Download Handler
 *
 * Streams files to the web client as a sequence of WebSocket chunk messages.
 * Mirrors the chunked upload path in reverse. Used for large binary files
 * (images, PDFs) where a single base64-in-JSON `fileContent` message would
 * exceed the relay's per-message cap or block the event loop during encoding.
 *
 * Chunk sizing: we emit 192 KB of raw bytes per chunk, which base64-encodes
 * to ~256 KB — comfortably under the relay's 16 MB per-message limit even
 * with JSON envelope overhead.
 */

import { createReadStream, existsSync, type ReadStream, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { isBinaryFile, isPathInSafeLocation } from './file-utils.js';
import type { WebSocketResponse, WSContext } from './types.js';

const CHUNK_RAW_BYTES = 192 * 1024; // ~256 KB once base64-encoded
const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 120_000;

interface DownloadState {
  downloadId: string;
  stream: ReadStream;
  cancelled: boolean;
  lastActivity: number;
}

function getMimeType(fullPath: string): string {
  const ext = fullPath.toLowerCase().split('.').pop() || '';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'pdf') return 'application/pdf';
  if (['png', 'gif', 'webp', 'bmp', 'tiff', 'ico'].includes(ext)) return `image/${ext}`;
  return 'application/octet-stream';
}

export class FileDownloadHandler {
  private active = new Map<string, DownloadState>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(private workingDir: string) {
    this.cleanupInterval = setInterval(() => this.cleanupStale(), 30_000);
  }

  handleDownloadStart(
    ws: WSContext,
    send: (ws: WSContext, response: WebSocketResponse) => void,
    tabId: string,
    data: { downloadId: string; filePath: string },
  ): void {
    const { downloadId, filePath } = data;
    const sendError = (error: string) => send(ws, {
      type: 'fileDownloadError' as WebSocketResponse['type'],
      tabId,
      data: { downloadId, error },
    });

    try {
      const fullPath = filePath.startsWith('/') ? filePath : resolve(this.workingDir, filePath);
      const normalized = resolve(fullPath);
      const normalizedWorkingDir = resolve(this.workingDir);

      // Sandbox: must be under workingDir OR a known safe location (matches readFileContent)
      const withinDir = normalized === normalizedWorkingDir
        || normalized.startsWith(normalizedWorkingDir + sep);
      if (!withinDir && !isPathInSafeLocation(normalized)) {
        sendError('Access denied: path outside allowed locations');
        return;
      }
      if (!existsSync(normalized)) {
        sendError('File not found');
        return;
      }

      const stats = statSync(normalized);
      if (stats.isDirectory()) {
        sendError('Path is a directory');
        return;
      }
      if (stats.size > MAX_DOWNLOAD_SIZE) {
        sendError(`File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_DOWNLOAD_SIZE / 1024 / 1024}MB limit`);
        return;
      }

      const totalChunks = Math.max(1, Math.ceil(stats.size / CHUNK_RAW_BYTES));
      const fileName = basename(normalized);
      const isImg = isBinaryFile(normalized);

      send(ws, {
        type: 'fileDownloadReady' as WebSocketResponse['type'],
        tabId,
        data: {
          downloadId,
          filePath,
          fileName,
          size: stats.size,
          mimeType: getMimeType(normalized),
          isImage: isImg,
          totalChunks,
          modifiedAt: stats.mtime.toISOString(),
        },
      });

      const stream = createReadStream(normalized, { highWaterMark: CHUNK_RAW_BYTES });
      const state: DownloadState = {
        downloadId,
        stream,
        cancelled: false,
        lastActivity: Date.now(),
      };
      this.active.set(downloadId, state);

      let chunkIndex = 0;
      stream.on('data', (buf: Buffer | string) => {
        if (state.cancelled) return;
        // Node may deliver buffers larger than highWaterMark on stream edges;
        // slice back down so each WS frame stays predictable.
        const chunk = typeof buf === 'string' ? Buffer.from(buf) : buf;
        for (let off = 0; off < chunk.length; off += CHUNK_RAW_BYTES) {
          const slice = chunk.subarray(off, Math.min(off + CHUNK_RAW_BYTES, chunk.length));
          send(ws, {
            type: 'fileDownloadChunk' as WebSocketResponse['type'],
            tabId,
            data: {
              downloadId,
              chunkIndex: chunkIndex++,
              content: slice.toString('base64'),
            },
          });
        }
        state.lastActivity = Date.now();
      });

      stream.on('end', () => {
        if (state.cancelled) return;
        send(ws, {
          type: 'fileDownloadComplete' as WebSocketResponse['type'],
          tabId,
          data: { downloadId },
        });
        this.active.delete(downloadId);
      });

      stream.on('error', (err) => {
        sendError(`Read failed: ${err.message}`);
        this.active.delete(downloadId);
      });
    } catch (err) {
      sendError(err instanceof Error ? err.message : String(err));
    }
  }

  handleDownloadCancel(
    _ws: WSContext,
    _send: (ws: WSContext, response: WebSocketResponse) => void,
    _tabId: string,
    data: { downloadId: string },
  ): void {
    const state = this.active.get(data.downloadId);
    if (!state) return;
    state.cancelled = true;
    state.stream.destroy();
    this.active.delete(data.downloadId);
  }

  private cleanupStale(): void {
    const now = Date.now();
    for (const [id, state] of this.active) {
      if (now - state.lastActivity > IDLE_TIMEOUT_MS) {
        console.warn(`[FileDownloadHandler] Download ${id} idle, cleaning up`);
        state.cancelled = true;
        state.stream.destroy();
        this.active.delete(id);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    for (const state of this.active.values()) {
      state.cancelled = true;
      state.stream.destroy();
    }
    this.active.clear();
  }
}
