import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandlerContext } from '../../handler-context.js';
import type { WebSocketMessage, WSContext } from '../../types.js';
import { handleDeployHttpRequest } from '../deploy-handlers.js';

// ============================================================================
// Test HTTP server — simulates the developer's local app
// ============================================================================

let testServer: http.Server;
let testPort: number;

/** Captured request data from the test server */
interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let lastCapturedRequest: CapturedRequest | null = null;

/**
 * Configurable response for the test server.
 * Set before each test to control what the "local app" returns.
 */
let serverResponse: {
  status: number;
  headers: Record<string, string>;
  body: string;
} = { status: 200, headers: {}, body: '' };

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    testServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        lastCapturedRequest = {
          method: req.method || 'GET',
          url: req.url || '/',
          headers: req.headers,
          body,
        };

        for (const [key, value] of Object.entries(serverResponse.headers)) {
          res.setHeader(key, value);
        }
        res.writeHead(serverResponse.status);
        res.end(serverResponse.body);
      });
    });

    // Listen on random available port
    testServer.listen(0, '127.0.0.1', () => {
      const addr = testServer.address();
      if (addr && typeof addr === 'object') {
        testPort = addr.port;
      }
      resolve();
    });
  });
}

function stopTestServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    testServer.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ============================================================================
// Mock WebSocket context (captures messages sent back through the relay)
// ============================================================================

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
    gitHeadWatcher: null,
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
      requestId: overrides.requestId ?? 'integ-req-001',
      method: overrides.method ?? 'GET',
      url: overrides.url ?? '/api/hello',
      headers: overrides.headers ?? { 'content-type': 'application/json' },
      body: overrides.body,
      deploymentId: overrides.deploymentId ?? 'deploy-integ-1',
      port: overrides.port ?? testPort,
    },
  } as WebSocketMessage;
}

// ============================================================================
// Lifecycle
// ============================================================================

beforeAll(async () => {
  await startTestServer();
});

afterAll(async () => {
  await stopTestServer();
});

beforeEach(() => {
  lastCapturedRequest = null;
  serverResponse = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// Integration tests — full HTTP-over-WebSocket round trip
// ============================================================================

describe('deploy HTTP relay integration', () => {

  // ── GET request round trip ───────────────────────────────────

  describe('GET request round trip', () => {
    it('relays GET request to local server and returns response', async () => {
      serverResponse = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"message":"hello from local server"}',
      };

      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({ method: 'GET', url: '/api/hello' });

      await handleDeployHttpRequest(ctx, ws, msg);

      // Verify the test server received the request
      expect(lastCapturedRequest).not.toBeNull();
      expect(lastCapturedRequest!.method).toBe('GET');
      expect(lastCapturedRequest!.url).toBe('/api/hello');

      // Verify the response came back through the handler
      expect(ctx.sentMessages).toHaveLength(1);
      expect(ctx.sentMessages[0].type).toBe('deployHttpResponse');
      const resp = ctx.sentMessages[0].data as {
        requestId: string;
        status: number;
        headers: Record<string, string>;
        body: string;
      };
      expect(resp.requestId).toBe('integ-req-001');
      expect(resp.status).toBe(200);
      expect(resp.body).toBe('{"message":"hello from local server"}');
      expect(resp.headers['content-type']).toBe('application/json');
    });

    it('preserves query string parameters through the relay', async () => {
      serverResponse = { status: 200, headers: {}, body: 'found' };

      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({ url: '/search?q=test&page=3&limit=10' });

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(lastCapturedRequest!.url).toBe('/search?q=test&page=3&limit=10');
      expect((ctx.sentMessages[0].data as { status: number }).status).toBe(200);
    });
  });

  // ── POST with body and content-type preserved ────────────────

  describe('POST with body and content-type preserved', () => {
    it('relays POST body and content-type to local server', async () => {
      serverResponse = {
        status: 201,
        headers: { 'content-type': 'application/json' },
        body: '{"id":42,"name":"created"}',
      };

      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({
        method: 'POST',
        url: '/api/items',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"new item","price":9.99}',
      });

      await handleDeployHttpRequest(ctx, ws, msg);

      // Verify test server received correct method, body, and content-type
      expect(lastCapturedRequest!.method).toBe('POST');
      expect(lastCapturedRequest!.body).toBe('{"name":"new item","price":9.99}');
      expect(lastCapturedRequest!.headers['content-type']).toBe('application/json');

      // Verify response
      const resp = ctx.sentMessages[0].data as {
        status: number;
        headers: Record<string, string>;
        body: string;
      };
      expect(resp.status).toBe(201);
      expect(resp.body).toBe('{"id":42,"name":"created"}');
      expect(resp.headers['content-type']).toBe('application/json');
    });

    it('handles POST with form-urlencoded body', async () => {
      serverResponse = { status: 200, headers: {}, body: 'submitted' };

      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({
        method: 'POST',
        url: '/submit',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'username=alice&password=secret',
      });

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(lastCapturedRequest!.body).toBe('username=alice&password=secret');
      expect(lastCapturedRequest!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    });
  });

  // ── Custom headers preserved through relay ───────────────────

  describe('custom headers preserved through relay', () => {
    it('forwards custom request headers to local server', async () => {
      serverResponse = { status: 200, headers: {}, body: 'ok' };

      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({
        headers: {
          'content-type': 'application/json',
          'x-custom-auth': 'Bearer my-token-123',
          'x-request-id': 'trace-abc-def',
          'accept-language': 'en-US,en;q=0.9',
        },
      });

      await handleDeployHttpRequest(ctx, ws, msg);

      // Custom headers should arrive at the test server
      expect(lastCapturedRequest!.headers['x-custom-auth']).toBe('Bearer my-token-123');
      expect(lastCapturedRequest!.headers['x-request-id']).toBe('trace-abc-def');
      expect(lastCapturedRequest!.headers['accept-language']).toBe('en-US,en;q=0.9');
    });

    it('preserves custom response headers from local server', async () => {
      serverResponse = {
        status: 200,
        headers: {
          'x-powered-by': 'express',
          'x-request-id': 'resp-trace-789',
          'cache-control': 'no-cache',
          'content-type': 'text/html',
        },
        body: '<h1>Hi</h1>',
      };

      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg();

      await handleDeployHttpRequest(ctx, ws, msg);

      const resp = ctx.sentMessages[0].data as { headers: Record<string, string> };
      expect(resp.headers['x-powered-by']).toBe('express');
      expect(resp.headers['x-request-id']).toBe('resp-trace-789');
      expect(resp.headers['cache-control']).toBe('no-cache');
      expect(resp.headers['content-type']).toBe('text/html');
    });

    it('strips hop-by-hop headers but preserves application headers', async () => {
      serverResponse = { status: 200, headers: {}, body: 'ok' };

      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({
        headers: {
          'content-type': 'application/json',
          'x-app-header': 'preserved',
          'connection': 'keep-alive',
          'transfer-encoding': 'chunked',
          'proxy-authorization': 'Basic abc',
        },
      });

      await handleDeployHttpRequest(ctx, ws, msg);

      // Application headers should be preserved through the relay
      expect(lastCapturedRequest!.headers['x-app-header']).toBe('preserved');
      expect(lastCapturedRequest!.headers['content-type']).toBe('application/json');
      // proxy-* headers should be stripped by the handler
      expect(lastCapturedRequest!.headers['proxy-authorization']).toBeUndefined();
      // Note: transport-level headers like connection/keep-alive may be
      // re-added by Node's HTTP client, so we don't assert their absence
      // here. The unit tests verify handler-level stripping with mocked fetch.
    });
  });

  // ── Status codes preserved ───────────────────────────────────

  describe('status codes preserved', () => {
    it('preserves 200 OK', async () => {
      serverResponse = { status: 200, headers: {}, body: 'ok' };

      const ctx = createMockCtx();
      const ws = createMockWs();
      await handleDeployHttpRequest(ctx, ws, makeHttpRequestMsg());

      expect((ctx.sentMessages[0].data as { status: number }).status).toBe(200);
    });

    it('preserves 404 Not Found', async () => {
      serverResponse = {
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: '{"error":"not found"}',
      };

      const ctx = createMockCtx();
      const ws = createMockWs();
      await handleDeployHttpRequest(ctx, ws, makeHttpRequestMsg({ url: '/nonexistent' }));

      const resp = ctx.sentMessages[0].data as { status: number; body: string };
      expect(resp.status).toBe(404);
      expect(resp.body).toBe('{"error":"not found"}');
    });

    it('preserves 500 Internal Server Error', async () => {
      serverResponse = {
        status: 500,
        headers: { 'content-type': 'text/plain' },
        body: 'Internal Server Error',
      };

      const ctx = createMockCtx();
      const ws = createMockWs();
      await handleDeployHttpRequest(ctx, ws, makeHttpRequestMsg());

      const resp = ctx.sentMessages[0].data as { status: number; body: string };
      expect(resp.status).toBe(500);
      expect(resp.body).toBe('Internal Server Error');
    });

    it('preserves 201 Created', async () => {
      serverResponse = { status: 201, headers: {}, body: '{"id":1}' };

      const ctx = createMockCtx();
      const ws = createMockWs();
      await handleDeployHttpRequest(ctx, ws, makeHttpRequestMsg({ method: 'POST', body: '{}' }));

      expect((ctx.sentMessages[0].data as { status: number }).status).toBe(201);
    });

    it('preserves 204 No Content', async () => {
      serverResponse = { status: 204, headers: {}, body: '' };

      const ctx = createMockCtx();
      const ws = createMockWs();
      await handleDeployHttpRequest(ctx, ws, makeHttpRequestMsg({ method: 'DELETE', url: '/api/items/1' }));

      expect((ctx.sentMessages[0].data as { status: number }).status).toBe(204);
    });

    it('preserves 302 redirect with location header', async () => {
      serverResponse = {
        status: 302,
        headers: { location: '/new-location' },
        body: '',
      };

      const ctx = createMockCtx();
      const ws = createMockWs();
      await handleDeployHttpRequest(ctx, ws, makeHttpRequestMsg());

      const resp = ctx.sentMessages[0].data as { status: number; headers: Record<string, string> };
      expect(resp.status).toBe(302);
      expect(resp.headers.location).toBe('/new-location');
    });

    it('preserves 429 Too Many Requests', async () => {
      serverResponse = {
        status: 429,
        headers: { 'retry-after': '60' },
        body: 'Rate limited',
      };

      const ctx = createMockCtx();
      const ws = createMockWs();
      await handleDeployHttpRequest(ctx, ws, makeHttpRequestMsg());

      const resp = ctx.sentMessages[0].data as { status: number; headers: Record<string, string> };
      expect(resp.status).toBe(429);
      expect(resp.headers['retry-after']).toBe('60');
    });
  });

  // ── Timeout when CLI doesn't respond within 30s ──────────────

  describe('timeout handling', () => {
    it('returns 504 when local server does not respond in time', async () => {
      // Create a separate slow server that never responds within timeout
      const slowServer = http.createServer((_req, _res) => {
        // Never call res.end() — simulate hang
      });

      const slowPort = await new Promise<number>((resolve) => {
        slowServer.listen(0, '127.0.0.1', () => {
          const addr = slowServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });

      try {
        const ctx = createMockCtx();
        const ws = createMockWs();

        // Use a very short timeout by temporarily patching the abort controller
        // The handler uses a 30s timeout, so we mock setTimeout to fire immediately
        // for the abort controller's timeout
        const originalSetTimeout = globalThis.setTimeout;
        let abortTimerCalled = false;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, delay, ...args) => {
          // The deploy handler sets a 30_000ms timeout for the AbortController
          if (delay === 30_000 && !abortTimerCalled) {
            abortTimerCalled = true;
            // Fire the abort immediately (10ms) to avoid waiting 30s
            return originalSetTimeout(fn as (...args: unknown[]) => void, 10, ...args);
          }
          return originalSetTimeout(fn as (...args: unknown[]) => void, delay, ...args);
        });

        await handleDeployHttpRequest(ctx, ws, makeHttpRequestMsg({ port: slowPort }));

        const resp = ctx.sentMessages[0].data as { requestId: string; status: number; body: string };
        expect(resp.status).toBe(504);
        expect(resp.body).toBe('Gateway Timeout');
      } finally {
        await new Promise<void>((resolve) => slowServer.close(() => resolve()));
      }
    });
  });

  // ── Error when CLI is disconnected (connection refused) ──────

  describe('error when target server is not running', () => {
    it('returns 502 when no server is running on the target port', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();

      // Use a port that no server is listening on
      const msg = makeHttpRequestMsg({ port: 59999 });

      await handleDeployHttpRequest(ctx, ws, msg);

      const resp = ctx.sentMessages[0].data as { requestId: string; status: number; body: string };
      expect(resp.requestId).toBe('integ-req-001');
      expect(resp.status).toBe(502);
      expect(resp.body).toContain('Bad Gateway');
    });
  });

  // ── Full round trip with multiple HTTP methods ───────────────

  describe('full round trip with various methods', () => {
    it('handles PUT with body round trip', async () => {
      serverResponse = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"updated":true}',
      };

      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({
        method: 'PUT',
        url: '/api/items/42',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"updated item"}',
      });

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(lastCapturedRequest!.method).toBe('PUT');
      expect(lastCapturedRequest!.url).toBe('/api/items/42');
      expect(lastCapturedRequest!.body).toBe('{"name":"updated item"}');

      const resp = ctx.sentMessages[0].data as { status: number; body: string };
      expect(resp.status).toBe(200);
      expect(resp.body).toBe('{"updated":true}');
    });

    it('handles PATCH with partial body round trip', async () => {
      serverResponse = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"patched":true}',
      };

      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({
        method: 'PATCH',
        url: '/api/items/42',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"patched"}',
      });

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(lastCapturedRequest!.method).toBe('PATCH');
      expect(lastCapturedRequest!.body).toBe('{"name":"patched"}');

      const resp = ctx.sentMessages[0].data as { status: number };
      expect(resp.status).toBe(200);
    });

    it('handles DELETE round trip', async () => {
      serverResponse = { status: 204, headers: {}, body: '' };

      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({ method: 'DELETE', url: '/api/items/42' });

      await handleDeployHttpRequest(ctx, ws, msg);

      expect(lastCapturedRequest!.method).toBe('DELETE');
      expect(lastCapturedRequest!.url).toBe('/api/items/42');

      expect((ctx.sentMessages[0].data as { status: number }).status).toBe(204);
    });
  });

  // ── Multiple concurrent requests ────────────────────────────

  describe('concurrent request isolation', () => {
    it('handles multiple concurrent requests to the same server', async () => {
      // The test server always returns the same response, but we verify
      // each request gets its own response with the correct requestId
      serverResponse = { status: 200, headers: {}, body: 'concurrent-ok' };

      const ctx = createMockCtx();
      const ws = createMockWs();

      const promises = Array.from({ length: 5 }, (_, i) =>
        handleDeployHttpRequest(
          ctx,
          ws,
          makeHttpRequestMsg({ requestId: `concurrent-${i}`, url: `/api/${i}` }),
        ),
      );

      await Promise.all(promises);

      expect(ctx.sentMessages).toHaveLength(5);

      // Each response should have the correct requestId
      for (let i = 0; i < 5; i++) {
        const resp = ctx.sentMessages.find(
          (m) => (m.data as { requestId: string }).requestId === `concurrent-${i}`,
        );
        expect(resp).toBeDefined();
        expect((resp!.data as { status: number }).status).toBe(200);
      }
    });
  });

  // ── Request ID correlation ──────────────────────────────────

  describe('request ID correlation', () => {
    it('response requestId matches the request for success', async () => {
      serverResponse = { status: 200, headers: {}, body: 'ok' };

      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({ requestId: 'corr-test-abc' });

      await handleDeployHttpRequest(ctx, ws, msg);

      expect((ctx.sentMessages[0].data as { requestId: string }).requestId).toBe('corr-test-abc');
    });

    it('response requestId matches the request for errors', async () => {
      const ctx = createMockCtx();
      const ws = createMockWs();
      const msg = makeHttpRequestMsg({ requestId: 'corr-err-xyz', port: 59999 });

      await handleDeployHttpRequest(ctx, ws, msg);

      expect((ctx.sentMessages[0].data as { requestId: string }).requestId).toBe('corr-err-xyz');
    });
  });

  // ── Large response body ─────────────────────────────────────

  describe('large response body handling', () => {
    it('returns a single response for body at chunk threshold (1MB)', async () => {
      // Exactly 1MB — should be a single message, not chunked
      const body = 'x'.repeat(1_048_576);
      serverResponse = { status: 200, headers: { 'content-type': 'text/plain' }, body };

      const ctx = createMockCtx();
      const ws = createMockWs();
      await handleDeployHttpRequest(ctx, ws, makeHttpRequestMsg());

      expect(ctx.sentMessages).toHaveLength(1);
      expect(ctx.sentMessages[0].type).toBe('deployHttpResponse');
    });

    it('chunks response body exceeding 1MB', async () => {
      // 1.5MB — should be chunked
      const body = 'A'.repeat(1_572_864);
      serverResponse = {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body,
      };

      const ctx = createMockCtx();
      const ws = createMockWs();
      await handleDeployHttpRequest(ctx, ws, makeHttpRequestMsg());

      const chunkMessages = ctx.sentMessages.filter((m) => m.type === 'deployHttpResponseChunk');
      expect(chunkMessages.length).toBeGreaterThan(1);

      // First chunk includes status and headers
      const firstChunk = chunkMessages[0].data as {
        chunkIndex: number;
        totalChunks: number;
        status?: number;
        headers?: Record<string, string>;
        isLast: boolean;
      };
      expect(firstChunk.chunkIndex).toBe(0);
      expect(firstChunk.status).toBe(200);
      expect(firstChunk.headers).toBeDefined();
      expect(firstChunk.isLast).toBe(false);

      // Last chunk has isLast=true
      const lastChunk = chunkMessages[chunkMessages.length - 1].data as {
        isLast: boolean;
      };
      expect(lastChunk.isLast).toBe(true);

      // Reassemble and verify content matches
      const chunks = chunkMessages
        .map((m) => m.data as { chunkIndex: number; data: string })
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
      const reassembled = Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'base64')));
      expect(reassembled.toString('utf-8')).toBe(body);
    });
  });
});
