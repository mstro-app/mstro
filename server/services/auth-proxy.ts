// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Auth Proxy Service
 *
 * HTTP proxy on localhost that injects the owner's Anthropic API credentials
 * into requests from sandboxed Claude Code processes. Sandboxed processes
 * never see the real API key — they send requests to this proxy via
 * ANTHROPIC_BASE_URL, and the proxy adds the x-api-key header before
 * forwarding to api.anthropic.com.
 *
 * Lifecycle: starts with the mstro CLI server, stops on shutdown.
 * Only used by sandboxed "can control" sessions — owner sessions
 * use credentials directly.
 */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readOwnerApiCredential } from './sandbox-config.js'

const ANTHROPIC_API_HOST = 'api.anthropic.com'

/** Headers that should not be forwarded to the upstream API */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
])

export class AuthProxy {
  private server: Server | null = null
  private port = 0
  /** Shared secret token — only processes that know this token can use the proxy. */
  private readonly proxyToken: string = randomBytes(16).toString('hex')

  /** Get the shared secret token for passing to sandboxed processes. */
  getProxyToken(): string {
    return this.proxyToken
  }

  /** Start the auth proxy on a random available port. */
  async start(): Promise<void> {
    if (this.server) return

    const server = createServer((inReq, inRes) => {
      this.handleRequest(inReq, inRes)
    })

    return new Promise((resolve, reject) => {
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
        }
        this.server = server
        resolve()
      })
    })
  }

  /** Stop the auth proxy and release the port. */
  async stop(): Promise<void> {
    if (!this.server) return
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null
        this.port = 0
        resolve()
      })
    })
  }

  /** Returns the port the proxy is listening on, or 0 if not started. */
  getPort(): number {
    return this.port
  }

  /** Returns true if the proxy is running. */
  isRunning(): boolean {
    return this.server !== null && this.port > 0
  }

  /**
   * Handle an incoming request from a sandboxed Claude Code process.
   * Reads the owner's credentials (fresh on each request to pick up token refreshes),
   * injects the auth header, and pipes the request/response to api.anthropic.com.
   */
  private handleRequest(inReq: IncomingMessage, inRes: ServerResponse): void {
    // Verify caller identity via shared secret embedded in the x-api-key header.
    // Sandboxed processes receive ANTHROPIC_API_KEY=sk-ant-proxy00-<token>.
    const incomingKey = inReq.headers['x-api-key'] as string | undefined
    const expectedPrefix = `sk-ant-proxy00-${this.proxyToken}`
    if (incomingKey !== expectedPrefix) {
      inRes.writeHead(403, { 'content-type': 'application/json' })
      inRes.end(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid proxy credentials.' },
      }))
      return
    }

    const credential = readOwnerApiCredential()
    if (!credential) {
      inRes.writeHead(503, { 'content-type': 'application/json' })
      inRes.end(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'No owner API credentials available. The machine owner must be logged in to Claude Code or have ANTHROPIC_API_KEY set.' },
      }))
      return
    }

    // Build upstream headers: copy incoming, strip hop-by-hop, inject auth
    const upstreamHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(inReq.headers)) {
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue
      if (key.toLowerCase() === 'x-api-key') continue // strip dummy key (contains proxy token)
      if (key.toLowerCase() === 'authorization') continue // strip dummy auth
      if (value) {
        upstreamHeaders[key] = Array.isArray(value) ? value.join(', ') : value
      }
    }

    upstreamHeaders.host = ANTHROPIC_API_HOST
    upstreamHeaders['x-api-key'] = credential.value

    const upstreamReq = httpsRequest(
      {
        hostname: ANTHROPIC_API_HOST,
        port: 443,
        path: inReq.url || '/',
        method: inReq.method || 'POST',
        headers: upstreamHeaders,
      },
      (upstreamRes) => {
        inRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(inRes)
      },
    )

    // Error on upstream connection → 502
    upstreamReq.on('error', (err) => {
      if (!inRes.headersSent) {
        inRes.writeHead(502, { 'content-type': 'application/json' })
        inRes.end(JSON.stringify({
          type: 'error',
          error: { type: 'proxy_error', message: `Auth proxy failed to reach Anthropic API: ${err.message}` },
        }))
      }
    })

    // Client disconnect → abort upstream
    inReq.on('close', () => {
      if (!upstreamReq.destroyed) upstreamReq.destroy()
    })

    // Pipe request body (prompt data, potentially large)
    inReq.pipe(upstreamReq)
  }
}

// ── Module-level singleton ───────────────────────────────────

let _instance: AuthProxy | null = null

/** Get or create the singleton AuthProxy instance. */
export function getAuthProxy(): AuthProxy {
  if (!_instance) {
    _instance = new AuthProxy()
  }
  return _instance
}

/** Get the auth proxy port, or 0 if not started. */
export function getAuthProxyPort(): number {
  return _instance?.getPort() ?? 0
}

/** Get the auth proxy shared secret token. */
export function getAuthProxyToken(): string {
  return _instance?.getProxyToken() ?? ''
}
