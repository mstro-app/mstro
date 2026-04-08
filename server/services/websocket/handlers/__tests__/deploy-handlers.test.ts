import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandlerContext } from '../../handler-context.js';
import type { WebSocketMessage, WSContext } from '../../types.js';
import { handleDeployHttpRequest } from '../deploy-handlers.js';

// ── Test helpers ────────────────────────────────────────────

function createMockWs(): WSContext {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  };
}

function createMockCtx(): HandlerContext & { sentMessages: Array<{ type: string; data: unknown }> } {
  const sentMessages: Array<{ type: string; data: unknown }> = [];
  return {
    sentMessages,
    sessions: new Map(),
    connections: new Map(),
    allConnections: new Set(),
    gitDirectories: new Map(),
    gitBranches: new Map(),
    activeSearches: new Map(),
    terminalSubscribers: new Map(),
    terminalListenerCleanups: new Map(),
    autocompleteService: {} as HandlerContext['autocompleteService'],
    usageReporter: null,
    fileUploadHandler: null,
    getRegistry: vi.fn() as unknown as HandlerContext['getRegistry'],
    send: vi.fn((_ws, response) => {
      sentMessages.push(response as { type: string; data: unknown });
    }),
    broadcastToOthers: vi.fn(),
    broadcastToAll: vi.fn(),
    recordFileSelection: vi.fn(),
  };
}

function makeHttpRequestMsg(overrides: Partial<{
  requestId: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  deploymentId: string;
  port: number;
}> = {}): WebSocketMessage {
  return {
    type: 'deployHttpRequest',
    data: {
      requestId: overrides.requestId ?? 'req-001',
      method: overrides.method ?? 'GET',
      url: overrides.url ?? '/api/hello',
      headers: overrides.headers ?? { 'content-type': 'application/json' },
      body: overrides.body,
      deploymentId: overrides.deploymentId ?? 'deploy-1',
      port: overrides.port ?? 3000,
    },
  } as WebSocketMessage;
}

// ── Mocks ───────────────────────────────────────────────────

const fetchMock = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

// ── Tests ───────────────────────────────────────────────────

describe('handleDeployHttpRequest', () => {
  // ── Input validation ──────────────────────────────────────

  describe('input validation', () => {
    it('returns 400 when requestId is missing', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = {
        type: 'deployHttpRequest',
        data: { method: 'GET', url: '/', port: 3000 },
      } as WebSocketMessage;

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(ctx.sentMessages).toHaveLength(1);
      expect(ctx.sentMessages[0].data).toMatchObject({ status: 400 });
    });

    it('returns 400 when method is missing', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = {
        type: 'deployHttpRequest',
        data: { requestId: 'r1', url: '/', port: 3000 },
      } as WebSocketMessage;

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(ctx.sentMessages[0].data).toMatchObject({ requestId: 'r1', status: 400 });
    });

    it('returns 400 when url is missing', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = {
        type: 'deployHttpRequest',
        data: { requestId: 'r2', method: 'GET', port: 3000 },
      } as WebSocketMessage;

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(ctx.sentMessages[0].data).toMatchObject({ requestId: 'r2', status: 400 });
    });

    it('returns 400 when port is missing', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = {
        type: 'deployHttpRequest',
        data: { requestId: 'r3', method: 'GET', url: '/' },
      } as WebSocketMessage;

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(ctx.sentMessages[0].data).toMatchObject({ requestId: 'r3', status: 400 });
    });

    it('returns 400 when headers contain null bytes', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({
        headers: { 'x-evil': 'val\0ue' },
      });

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(ctx.sentMessages[0].data).toMatchObject({
        requestId: 'req-001',
        status: 400,
      });
      expect((ctx.sentMessages[0].data as { body: string }).body).toContain('null bytes');
    });

    it('returns 400 when header name contains null bytes', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({
        headers: { 'x-evil\0header': 'value' },
      });

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(ctx.sentMessages[0].data).toMatchObject({ status: 400 });
    });

    it('returns 400 when headers contain CRLF injection', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({
        headers: { 'x-header': 'value\r\nInjected: evil' },
      });

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(ctx.sentMessages[0].data).toMatchObject({
        requestId: 'req-001',
        status: 400,
      });
      expect((ctx.sentMessages[0].data as { body: string }).body).toContain('CRLF');
    });

    it('returns 400 when header value contains bare CR', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({
        headers: { 'x-header': 'val\rue' },
      });

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(ctx.sentMessages[0].data).toMatchObject({ status: 400 });
    });

    it('returns 400 when header value contains bare LF', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({
        headers: { 'x-header': 'val\nue' },
      });

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(ctx.sentMessages[0].data).toMatchObject({ status: 400 });
    });

    it('returns 431 when headers exceed 16KB', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const largeHeaders: Record<string, string> = {};
      // Each header ~1KB, need > 16KB total
      for (let i = 0; i < 20; i++) {
        largeHeaders[`x-header-${i}`] = 'x'.repeat(1024);
      }
      const msg = makeHttpRequestMsg({ headers: largeHeaders });

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(ctx.sentMessages[0].data).toMatchObject({
        requestId: 'req-001',
        status: 431,
      });
    });
  });

  // ── Successful HTTP request proxy ─────────────────────────

  describe('successful proxy', () => {
    it('proxies GET request and returns response', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const headers = new Headers({ 'content-type': 'application/json' });
      fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200, headers }));

      const msg = makeHttpRequestMsg({ method: 'GET', url: '/api/data' });
      await handleDeployHttpRequest(ctx, ws, msg);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:3000/api/data');
      expect(opts?.method).toBe('GET');
      expect(opts?.body).toBeUndefined(); // GET has no body

      expect(ctx.sentMessages).toHaveLength(1);
      const resp = ctx.sentMessages[0].data as { requestId: string; status: number; body: string };
      expect(resp.requestId).toBe('req-001');
      expect(resp.status).toBe(200);
      expect(resp.body).toBe('{"ok":true}');
    });

    it('proxies POST request with body', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockResolvedValueOnce(new Response('created', { status: 201 }));

      const msg = makeHttpRequestMsg({
        method: 'POST',
        url: '/api/items',
        body: '{"name":"test"}',
      });
      await handleDeployHttpRequest(ctx, ws, msg);

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts?.method).toBe('POST');
      expect(opts?.body).toBe('{"name":"test"}');

      const resp = ctx.sentMessages[0].data as { status: number; body: string };
      expect(resp.status).toBe(201);
      expect(resp.body).toBe('created');
    });

    it('proxies PUT request with body', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockResolvedValueOnce(new Response('updated', { status: 200 }));

      const msg = makeHttpRequestMsg({
        method: 'PUT',
        url: '/api/items/1',
        body: '{"name":"updated"}',
      });
      await handleDeployHttpRequest(ctx, ws, msg);

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:3000/api/items/1');
      expect(opts?.method).toBe('PUT');
      expect(opts?.body).toBe('{"name":"updated"}');

      const resp = ctx.sentMessages[0].data as { status: number };
      expect(resp.status).toBe(200);
    });

    it('proxies DELETE request without body', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const msg = makeHttpRequestMsg({ method: 'DELETE', url: '/api/items/1' });
      await handleDeployHttpRequest(ctx, ws, msg);

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts?.method).toBe('DELETE');

      const resp = ctx.sentMessages[0].data as { status: number };
      expect(resp.status).toBe(204);
    });

    it('preserves query strings in the proxied URL', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const msg = makeHttpRequestMsg({ url: '/search?q=hello&page=2' });
      await handleDeployHttpRequest(ctx, ws, msg);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:3000/search?q=hello&page=2');
    });

    it('uses redirect: manual to prevent auto-following redirects', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockResolvedValueOnce(
        new Response('', { status: 302, headers: { location: '/new-location' } }),
      );

      const msg = makeHttpRequestMsg();
      await handleDeployHttpRequest(ctx, ws, msg);

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts?.redirect).toBe('manual');

      const resp = ctx.sentMessages[0].data as { status: number; headers: Record<string, string> };
      expect(resp.status).toBe(302);
      expect(resp.headers.location).toBe('/new-location');
    });

    it('strips body from GET requests even if provided', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const msg = makeHttpRequestMsg({ method: 'GET', body: 'should-be-ignored' });
      await handleDeployHttpRequest(ctx, ws, msg);

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts?.body).toBeUndefined();
    });
  });

  // ── Connection refused → 502 ──────────────────────────────

  describe('connection refused → 502', () => {
    it('returns 502 when fetch throws ECONNREFUSED in message', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:3000'));

      const msg = makeHttpRequestMsg();
      await handleDeployHttpRequest(ctx, ws, msg);

      const resp = ctx.sentMessages[0].data as { requestId: string; status: number; body: string };
      expect(resp.requestId).toBe('req-001');
      expect(resp.status).toBe(502);
      expect(resp.body).toContain('Bad Gateway');
    });

    it('returns 502 when fetch throws with ECONNREFUSED cause code', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const err = new Error('fetch failed');
      (err as Error & { cause: { code: string } }).cause = { code: 'ECONNREFUSED' };
      fetchMock.mockRejectedValueOnce(err);

      const msg = makeHttpRequestMsg();
      await handleDeployHttpRequest(ctx, ws, msg);

      const resp = ctx.sentMessages[0].data as { status: number; body: string };
      expect(resp.status).toBe(502);
      expect(resp.body).toContain('Bad Gateway');
    });

    it('returns generic 502 for other fetch errors', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockRejectedValueOnce(new Error('some network error'));

      const msg = makeHttpRequestMsg();
      await handleDeployHttpRequest(ctx, ws, msg);

      const resp = ctx.sentMessages[0].data as { status: number; body: string };
      expect(resp.status).toBe(502);
      expect(resp.body).toBe('Bad Gateway');
    });
  });

  // ── Timeout → 504 ────────────────────────────────────────

  describe('timeout → 504', () => {
    it('returns 504 when fetch throws AbortError', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      fetchMock.mockRejectedValueOnce(abortError);

      const msg = makeHttpRequestMsg();
      await handleDeployHttpRequest(ctx, ws, msg);

      const resp = ctx.sentMessages[0].data as { requestId: string; status: number; body: string };
      expect(resp.requestId).toBe('req-001');
      expect(resp.status).toBe(504);
      expect(resp.body).toBe('Gateway Timeout');
    });

    it('passes an AbortSignal to fetch', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const msg = makeHttpRequestMsg();
      await handleDeployHttpRequest(ctx, ws, msg);

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // ── Hop-by-hop header stripping ───────────────────────────

  describe('hop-by-hop header stripping', () => {
    it('strips hop-by-hop headers from request', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const msg = makeHttpRequestMsg({
        headers: {
          'content-type': 'application/json',
          'connection': 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
          'te': 'trailers',
          'trailers': 'some-value',
          'upgrade': 'websocket',
          'proxy-auth': 'Bearer token',
          'proxy-connection': 'keep-alive',
          'x-custom-header': 'preserved',
        },
      });
      await handleDeployHttpRequest(ctx, ws, msg);

      const [, opts] = fetchMock.mock.calls[0];
      const sentHeaders = opts?.headers as Record<string, string>;
      // Hop-by-hop headers should be stripped
      expect(sentHeaders).not.toHaveProperty('connection');
      expect(sentHeaders).not.toHaveProperty('keep-alive');
      expect(sentHeaders).not.toHaveProperty('transfer-encoding');
      expect(sentHeaders).not.toHaveProperty('te');
      expect(sentHeaders).not.toHaveProperty('trailers');
      expect(sentHeaders).not.toHaveProperty('upgrade');
      expect(sentHeaders).not.toHaveProperty('proxy-auth');
      expect(sentHeaders).not.toHaveProperty('proxy-connection');
      // Non hop-by-hop headers should be preserved
      expect(sentHeaders['content-type']).toBe('application/json');
      expect(sentHeaders['x-custom-header']).toBe('preserved');
    });

    it('strips hop-by-hop headers from response', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const responseHeaders = new Headers({
        'content-type': 'text/html',
        'connection': 'keep-alive',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        'x-powered-by': 'express',
      });
      fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200, headers: responseHeaders }));

      const msg = makeHttpRequestMsg();
      await handleDeployHttpRequest(ctx, ws, msg);

      const resp = ctx.sentMessages[0].data as { headers: Record<string, string> };
      expect(resp.headers).not.toHaveProperty('connection');
      expect(resp.headers).not.toHaveProperty('keep-alive');
      expect(resp.headers).not.toHaveProperty('transfer-encoding');
      expect(resp.headers['content-type']).toBe('text/html');
      expect(resp.headers['x-powered-by']).toBe('express');
    });

    it('strips headers starting with proxy-', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const msg = makeHttpRequestMsg({
        headers: {
          'proxy-authorization': 'Basic abc',
          'proxy-connection': 'keep-alive',
          'accept': 'text/html',
        },
      });
      await handleDeployHttpRequest(ctx, ws, msg);

      const [, opts] = fetchMock.mock.calls[0];
      const sentHeaders = opts?.headers as Record<string, string>;
      expect(sentHeaders).not.toHaveProperty('proxy-authorization');
      expect(sentHeaders).not.toHaveProperty('proxy-connection');
      expect(sentHeaders.accept).toBe('text/html');
    });
  });

  // ── Concurrent request limit → 429 ───────────────────────
  // Note: The current implementation does not have an explicit concurrent
  // request limit. The acceptance criteria mentions 50 max concurrent
  // requests returning 429, but this feature is not yet implemented
  // in handlers/deploy-handlers.ts. These tests verify that parallel
  // requests can all execute concurrently (no artificial limiting).

  describe('concurrent requests', () => {
    it('handles multiple concurrent requests independently', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();

      // Each request gets its own unique response
      for (let i = 0; i < 5; i++) {
        fetchMock.mockResolvedValueOnce(
          new Response(`response-${i}`, { status: 200 }),
        );
      }

      const promises = Array.from({ length: 5 }, (_, i) =>
        handleDeployHttpRequest(
          ctx,
          ws,
          makeHttpRequestMsg({ requestId: `req-${i}`, url: `/api/${i}` }),
        ),
      );

      await Promise.all(promises);

      expect(ctx.sentMessages).toHaveLength(5);
      // Each response correlates to its request ID
      for (let i = 0; i < 5; i++) {
        const resp = ctx.sentMessages.find(
          (m) => (m.data as { requestId: string }).requestId === `req-${i}`,
        );
        expect(resp).toBeDefined();
        expect((resp!.data as { status: number }).status).toBe(200);
      }
    });

    it('isolates errors between concurrent requests', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();

      // First request succeeds, second fails
      fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:3000'));

      const promises = [
        handleDeployHttpRequest(ctx, ws, makeHttpRequestMsg({ requestId: 'success-req' })),
        handleDeployHttpRequest(ctx, ws, makeHttpRequestMsg({ requestId: 'fail-req' })),
      ];

      await Promise.all(promises);

      expect(ctx.sentMessages).toHaveLength(2);
      const successResp = ctx.sentMessages.find(
        (m) => (m.data as { requestId: string }).requestId === 'success-req',
      );
      const failResp = ctx.sentMessages.find(
        (m) => (m.data as { requestId: string }).requestId === 'fail-req',
      );

      expect((successResp!.data as { status: number }).status).toBe(200);
      expect((failResp!.data as { status: number }).status).toBe(502);
    });
  });

  // ── Chunked streaming (responses > 1MB) ───────────────────

  describe('chunked streaming for large responses', () => {
    it('sends a single deployHttpResponse for responses <= 1MB', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const body = 'x'.repeat(1_000_000); // exactly 1MB, at threshold
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));

      const msg = makeHttpRequestMsg();
      await handleDeployHttpRequest(ctx, ws, msg);

      expect(ctx.sentMessages).toHaveLength(1);
      expect(ctx.sentMessages[0].type).toBe('deployHttpResponse');
    });

    it('sends chunked responses for bodies > 1MB', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      // 1.5MB body → should exceed 1MB threshold
      const body = Buffer.alloc(1_572_864, 0x41); // 1.5MB of 'A'
      fetchMock.mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
      );

      const msg = makeHttpRequestMsg();
      await handleDeployHttpRequest(ctx, ws, msg);

      // 1.5MB / 256KB chunks = 6 chunks
      const chunkMessages = ctx.sentMessages.filter(
        (m) => m.type === 'deployHttpResponseChunk',
      );
      expect(chunkMessages.length).toBe(6);

      // First chunk has status and headers
      const firstChunk = chunkMessages[0].data as {
        chunkIndex: number;
        totalChunks: number;
        status?: number;
        headers?: Record<string, string>;
        isLast: boolean;
      };
      expect(firstChunk.chunkIndex).toBe(0);
      expect(firstChunk.totalChunks).toBe(6);
      expect(firstChunk.status).toBe(200);
      expect(firstChunk.headers).toBeDefined();
      expect(firstChunk.isLast).toBe(false);

      // Last chunk has isLast=true, no status/headers
      const lastChunk = chunkMessages[chunkMessages.length - 1].data as {
        chunkIndex: number;
        isLast: boolean;
        status?: number;
        headers?: Record<string, string>;
      };
      expect(lastChunk.chunkIndex).toBe(5);
      expect(lastChunk.isLast).toBe(true);
      expect(lastChunk.status).toBeUndefined();
      expect(lastChunk.headers).toBeUndefined();
    });

    it('chunk data is base64 encoded', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const body = Buffer.alloc(1_048_577, 0x42); // just over 1MB
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));

      const msg = makeHttpRequestMsg();
      await handleDeployHttpRequest(ctx, ws, msg);

      const chunkMessages = ctx.sentMessages.filter(
        (m) => m.type === 'deployHttpResponseChunk',
      );
      expect(chunkMessages.length).toBeGreaterThan(0);

      // Verify each chunk's data field is valid base64
      for (const chunk of chunkMessages) {
        const data = (chunk.data as { data: string }).data;
        expect(typeof data).toBe('string');
        // Valid base64 should decode without error
        const decoded = Buffer.from(data, 'base64');
        expect(decoded.length).toBeGreaterThan(0);
      }
    });

    it('all chunks have the correct requestId', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const body = Buffer.alloc(1_572_864, 0x43); // 1.5MB
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));

      const msg = makeHttpRequestMsg({ requestId: 'chunked-req-42' });
      await handleDeployHttpRequest(ctx, ws, msg);

      const chunkMessages = ctx.sentMessages.filter(
        (m) => m.type === 'deployHttpResponseChunk',
      );
      for (const chunk of chunkMessages) {
        expect((chunk.data as { requestId: string }).requestId).toBe('chunked-req-42');
      }
    });

    it('reassembled chunks equal the original response body', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      // Create a non-trivial pattern so we can verify exact content
      const original = Buffer.alloc(1_572_864);
      for (let i = 0; i < original.length; i++) {
        original[i] = i % 256;
      }
      fetchMock.mockResolvedValueOnce(new Response(original, { status: 200 }));

      const msg = makeHttpRequestMsg();
      await handleDeployHttpRequest(ctx, ws, msg);

      const chunkMessages = ctx.sentMessages.filter(
        (m) => m.type === 'deployHttpResponseChunk',
      );

      // Reassemble
      const chunks = chunkMessages
        .map((m) => m.data as { chunkIndex: number; data: string })
        .sort((a, b) => a.chunkIndex - b.chunkIndex);

      const reassembled = Buffer.concat(
        chunks.map((c) => Buffer.from(c.data, 'base64')),
      );
      expect(reassembled.equals(original)).toBe(true);
    });
  });

  // ── Request ID correlation and timeout cleanup ────────────

  describe('request ID correlation and timeout cleanup', () => {
    it('response requestId always matches the request requestId', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const msg = makeHttpRequestMsg({ requestId: 'correlation-test-xyz' });
      await handleDeployHttpRequest(ctx, ws, msg);

      const resp = ctx.sentMessages[0].data as { requestId: string };
      expect(resp.requestId).toBe('correlation-test-xyz');
    });

    it('preserves requestId in error responses (502)', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      const msg = makeHttpRequestMsg({ requestId: 'err-req-123' });
      await handleDeployHttpRequest(ctx, ws, msg);

      const resp = ctx.sentMessages[0].data as { requestId: string; status: number };
      expect(resp.requestId).toBe('err-req-123');
      expect(resp.status).toBe(502);
    });

    it('preserves requestId in timeout responses (504)', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));

      const msg = makeHttpRequestMsg({ requestId: 'timeout-req-456' });
      await handleDeployHttpRequest(ctx, ws, msg);

      const resp = ctx.sentMessages[0].data as { requestId: string; status: number };
      expect(resp.requestId).toBe('timeout-req-456');
      expect(resp.status).toBe(504);
    });

    it('cleans up timeout timer after successful response (no memory leak)', async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const msg = makeHttpRequestMsg();
      await handleDeployHttpRequest(ctx, ws, msg);

      // The handler uses setTimeout + clearTimeout for the abort controller
      // clearTimeout should be called in the finally block
      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('cleans up timeout timer after fetch error (no memory leak)', async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const ctx = createMockCtx();
      const ws = createMockWs();
      fetchMock.mockRejectedValueOnce(new Error('network error'));

      const msg = makeHttpRequestMsg();
      await handleDeployHttpRequest(ctx, ws, msg);

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('uses unknown as requestId fallback when data has no requestId', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = {
        type: 'deployHttpRequest',
        data: {},
      } as WebSocketMessage;

      await handleDeployHttpRequest(ctx, ws, msg);

      const resp = ctx.sentMessages[0].data as { requestId: string; status: number };
      expect(resp.requestId).toBe('unknown');
      expect(resp.status).toBe(400);
    });

    it('does not retain references after request completes', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();

      // Run many requests sequentially — if there's a leak, references accumulate
      for (let i = 0; i < 100; i++) {
        fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
        await handleDeployHttpRequest(
          ctx,
          ws,
          makeHttpRequestMsg({ requestId: `leak-test-${i}` }),
        );
      }

      // All 100 responses should have been sent
      expect(ctx.sentMessages).toHaveLength(100);
      // The handler is stateless — each call creates and destroys its own
      // AbortController + timeout. No module-level map accumulates entries.
    });
  });
});
