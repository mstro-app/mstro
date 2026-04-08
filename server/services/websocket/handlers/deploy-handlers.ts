// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Deploy HTTP Handler
 *
 * Handles deployHttpRequest messages from the platform server relay.
 * Proxies HTTP requests to the developer's local server and returns
 * the response back through the WebSocket relay.
 */

import type { HandlerContext } from '../handler-context.js';
import type { DeployHttpRequestData, DeployHttpResponseChunkData, DeployHttpResponseData, WebSocketMessage, WSContext } from '../types.js';

/** Hop-by-hop headers that must not be forwarded through a proxy (RFC 2616 §13.5.1) */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailers',
  'upgrade',
]);

/** Request timeout in milliseconds (30 seconds) */
const REQUEST_TIMEOUT_MS = 30_000;

/** Maximum total header size in bytes (16 KB) */
const MAX_HEADER_SIZE_BYTES = 16_384;

/** Chunking threshold: responses larger than 1 MB are streamed in chunks */
const CHUNK_THRESHOLD_BYTES = 1_048_576;

/** Size of each chunk (~256 KB of raw data → ~341 KB base64) */
const CHUNK_SIZE_BYTES = 262_144;

function isHopByHopHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith('proxy-');
}

function stripHopByHopHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!isHopByHopHeader(key)) {
      result[key] = value;
    }
  }
  return result;
}

/** Check headers for null bytes or CRLF injection attempts */
function containsHeaderInjection(headers: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(headers)) {
    if (key.includes('\0') || value.includes('\0')) return true;
    if (/\r|\n/.test(key) || /\r|\n/.test(value)) return true;
  }
  return false;
}

/** Calculate total size of request headers in bytes */
function calculateHeaderSize(headers: Record<string, string>): number {
  let size = 0;
  for (const [key, value] of Object.entries(headers)) {
    // key: value\r\n
    size += key.length + 2 + value.length + 2;
  }
  return size;
}

function sendDeployHttpResponse(
  ctx: HandlerContext,
  ws: WSContext,
  data: DeployHttpResponseData,
): void {
  ctx.send(ws, { type: 'deployHttpResponse', data });
}

/** Send a large response body in chunks via deployHttpResponseChunk messages */
function sendChunkedResponse(
  ctx: HandlerContext,
  ws: WSContext,
  requestId: string,
  status: number,
  headers: Record<string, string>,
  bodyBuffer: Buffer,
): void {
  const totalChunks = Math.ceil(bodyBuffer.length / CHUNK_SIZE_BYTES);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE_BYTES;
    const end = Math.min(start + CHUNK_SIZE_BYTES, bodyBuffer.length);
    const chunk = bodyBuffer.subarray(start, end);
    const isLast = i === totalChunks - 1;

    const chunkData: DeployHttpResponseChunkData = {
      requestId,
      chunkIndex: i,
      totalChunks,
      data: chunk.toString('base64'),
      isLast,
    };

    // Include status and headers only in the first chunk
    if (i === 0) {
      chunkData.status = status;
      chunkData.headers = headers;
    }

    ctx.send(ws, { type: 'deployHttpResponseChunk', data: chunkData });
  }
}

export async function handleDeployHttpRequest(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
): Promise<void> {
  const data = msg.data as DeployHttpRequestData;

  if (!data?.requestId || !data?.method || !data?.url || !data?.port) {
    sendDeployHttpResponse(ctx, ws, {
      requestId: data?.requestId || 'unknown',
      status: 400,
      headers: {},
      body: 'Bad Request: missing required fields (requestId, method, url, port)',
    });
    return;
  }

  // Reject headers with null bytes or CRLF injection
  if (data.headers && containsHeaderInjection(data.headers)) {
    sendDeployHttpResponse(ctx, ws, {
      requestId: data.requestId,
      status: 400,
      headers: {},
      body: 'Bad Request: headers contain null bytes or CRLF injection',
    });
    return;
  }

  // Enforce header size limit
  if (data.headers && calculateHeaderSize(data.headers) > MAX_HEADER_SIZE_BYTES) {
    sendDeployHttpResponse(ctx, ws, {
      requestId: data.requestId,
      status: 431,
      headers: {},
      body: 'Request Header Fields Too Large: total headers exceed 16KB',
    });
    return;
  }

  // Build local URL: localhost:{port}{path with query string}
  const localUrl = `http://localhost:${data.port}${data.url}`;

  try {
    const requestHeaders = stripHopByHopHeaders(data.headers);

    // Only include body for methods that support it
    const hasBody = data.body !== undefined && data.method !== 'GET' && data.method !== 'HEAD';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(localUrl, {
        method: data.method,
        headers: requestHeaders,
        body: hasBody ? data.body : undefined,
        signal: controller.signal,
        redirect: 'manual',
      });
    } finally {
      clearTimeout(timeout);
    }

    // Serialize response headers, stripping hop-by-hop
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (!isHopByHopHeader(key)) {
        responseHeaders[key] = value;
      }
    });

    // Read response as binary to handle both text and binary payloads
    const bodyBuffer = Buffer.from(await response.arrayBuffer());

    // Stream large responses in chunks
    if (bodyBuffer.length > CHUNK_THRESHOLD_BYTES) {
      sendChunkedResponse(ctx, ws, data.requestId, response.status, responseHeaders, bodyBuffer);
      return;
    }

    // Small response — send as a single message
    sendDeployHttpResponse(ctx, ws, {
      requestId: data.requestId,
      status: response.status,
      headers: responseHeaders,
      body: bodyBuffer.toString('utf-8'),
    });
  } catch (error: unknown) {
    let status = 502;
    let body = 'Bad Gateway';

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        status = 504;
        body = 'Gateway Timeout';
      } else if (isConnectionRefused(error)) {
        status = 502;
        body = 'Bad Gateway: target server is not running';
      }
    }

    sendDeployHttpResponse(ctx, ws, {
      requestId: data.requestId,
      status,
      headers: {},
      body,
    });
  }
}

/** Detect ECONNREFUSED across Node.js error shapes */
function isConnectionRefused(error: Error): boolean {
  if (error.message.includes('ECONNREFUSED')) return true;
  const cause = (error as Error & { cause?: { code?: string } }).cause;
  return cause?.code === 'ECONNREFUSED';
}
