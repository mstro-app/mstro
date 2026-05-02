// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Platform Connection Service
 *
 * Handles WebSocket connection to the Mstro platform.
 * Requires token-based authentication from `mstro login`.
 *
 * Credential management lives in platform-credentials.ts.
 */

import { arch, hostname, type } from 'node:os'
import { basename } from 'node:path'
import { AnalyticsEvents, trackEvent } from './analytics.js'
import { getClientId } from './client-id.js'
import { CLI_VERSION, getCredentials } from './platform-credentials.js'
import { TokenLifecycle } from './platform-token-lifecycle.js'
import { captureException } from './sentry.js'

/**
 * Get machine identification string
 * Example: "Jessica @ node-v22.21.1 linux (arm64)"
 */
export function getMachineIdentifier(): string {
  const machineHostname = hostname()
  const nodeVersion = process.version
  const osType = type().toLowerCase()
  const cpuArch = arch()
  return `${machineHostname} @ node-${nodeVersion} ${osType} (${cpuArch})`
}

// Get WebSocket class - use global if available (Bun, Node 21+), otherwise use ws (Node 18-20)
let WebSocketImpl: typeof WebSocket
if (typeof WebSocket !== 'undefined') {
  WebSocketImpl = WebSocket
} else {
  try {
    const { default: WS } = await import('ws')
    WebSocketImpl = WS as unknown as typeof WebSocket
  } catch {
    throw new Error('WebSocket not available: install the "ws" package or use Node.js 21+')
  }
}

// PLATFORM_URL is set via --server / --dev flag in mstro.js
const DEFAULT_PLATFORM_URL = process.env.PLATFORM_URL || 'https://api.mstro.app'

/**
 * Relay wire-format version this CLI speaks. Bumped by the server when the
 * relay protocol changes incompatibly. Must match (or exceed) the server's
 * `minProtocolVersion` in `server/src/relay/version-policy.ts` — when the
 * server's floor moves above this value, the upgrade handshake returns 426
 * and the CLI surfaces the upgrade message via `handleSocketClose`.
 *
 * This is a build-time constant, not user-configurable: a stale CLI must be
 * told to upgrade rather than allowed to opt itself into compatibility.
 */
const PROTOCOL_VERSION = 1

/**
 * Long sentinel delay used after a 426 protocol-too-old close. The CLI
 * auto-upgrades on the next `mstro` invocation, so a tight reconnect loop
 * would just hammer the server with rejections that policy already decided
 * to refuse. One hour is long enough to count as "stop", short enough that
 * a forgotten foreground process eventually retries on its own.
 */
const PROTOCOL_UPGRADE_RECONNECT_DELAY_MS = 60 * 60 * 1000

interface ConnectionCallbacks {
  onConnected?: (connectionId: string) => void
  onDisconnected?: () => void
  onError?: (error: string) => void
  onWebConnected?: () => void
  onWebDisconnected?: () => void
  onRelayedMessage?: (message: unknown) => void
}

/** Number of missed pongs before treating connection as dead */
const MAX_MISSED_PONGS = 2

export class PlatformConnection {
  private ws: WebSocket | null = null
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private isIntentionallyClosed = false
  private workingDirectory: string
  private platformUrl: string
  private callbacks: ConnectionCallbacks
  private connectionId: string | null = null
  private isConnected = false
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private missedPongs = 0
  private everConnected = false
  private protocolUpgradeRequired = false
  private readonly startedAt: string
  private readonly tokens: TokenLifecycle

  constructor(
    workingDirectory: string,
    callbacks: ConnectionCallbacks = {},
    platformUrl?: string
  ) {
    this.workingDirectory = workingDirectory
    this.platformUrl = platformUrl || DEFAULT_PLATFORM_URL
    this.callbacks = callbacks
    this.startedAt = new Date().toISOString()
    this.tokens = new TokenLifecycle({
      platformUrl: this.platformUrl,
      send: (msg) => this.send(msg),
      getConnectionId: () => this.connectionId,
    })
  }

  private startHeartbeat(): void {
    this.missedPongs = 0
    this.heartbeatInterval = setInterval(() => this.heartbeatTick(), 25_000)
  }

  private heartbeatTick(): void {
    if (!this.ws || !this.isConnected) return

    if (this.missedPongs >= MAX_MISSED_PONGS) {
      console.log(`[Platform] ${this.missedPongs} pongs missed — forcing reconnect`)
      this.missedPongs = 0
      this.stopHeartbeat()
      try { this.ws.close() } catch { /* ignore */ }
      return
    }
    this.missedPongs++
    try {
      this.ws.send(JSON.stringify({ type: 'ping' }))
    } catch {
      // Send failed — onclose will handle reconnect
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  connect(): void {
    this.isIntentionallyClosed = false
    this.protocolUpgradeRequired = false

    const authToken = getCredentials()?.token
    if (!authToken) {
      console.error('\n❌ Not logged in. Run `mstro login` first.\n')
      this.callbacks.onError?.('Not logged in - run `mstro login` first')
      return
    }

    const wsUrl = this.buildConnectionUrl()
    try {
      this.ws = new WebSocketImpl(wsUrl)
    } catch (err) {
      console.error('Failed to create WebSocket connection:', err)
      captureException(err instanceof Error ? err : new Error(String(err)), { context: 'platform.connect' })
      this.callbacks.onError?.('Failed to connect to platform')
      this.scheduleReconnect()
      return
    }

    const connectionTimeout = this.startConnectionTimeout()
    this.attachSocketHandlers(this.ws, authToken, connectionTimeout)
    this.tokens.maybeVerifyInParallel()
  }

  private buildConnectionUrl(): string {
    const params = new URLSearchParams({
      name: basename(this.workingDirectory),
      workingDirectory: this.workingDirectory,
      machineHostname: hostname(),
      clientId: getClientId(),
      machineId: getMachineIdentifier(),
      nodeVersion: process.version,
      osType: type().toLowerCase(),
      cpuArch: arch(),
      cliVersion: CLI_VERSION,
      capabilities: JSON.stringify({}),
      startedAt: this.startedAt,
      protocolVersion: String(PROTOCOL_VERSION),
    })
    return `${this.platformUrl.replace(/^http/, 'ws')}/ws/client?${params}`
  }

  private startConnectionTimeout(): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const state = this.ws?.readyState
      if (this.ws && (state === 0 || state === undefined)) {
        console.error('\n❌ Connection timeout. The platform may have rejected your credentials.')
        console.error('   Run `mstro login --force` to re-authenticate.\n')
        this.ws.close()
        this.callbacks.onError?.('Connection timeout - run `mstro login --force`')
      }
    }, 10000)
  }

  private attachSocketHandlers(
    ws: WebSocket,
    authToken: string,
    connectionTimeout: ReturnType<typeof setTimeout>,
  ): void {
    ws.onopen = () => {
      clearTimeout(connectionTimeout)
      ws.send(JSON.stringify({ type: 'auth', token: authToken }))
      this.tokens.maybeRefresh()
      this.tokens.startPeriodicCheck()
      this.reconnectAttempts = 0
      trackEvent(AnalyticsEvents.PLATFORM_CONNECTED)
    }

    ws.onmessage = (event) => {
      try {
        this.handleMessage(JSON.parse(event.data.toString()))
      } catch (err) {
        console.error('Failed to parse platform message:', err)
      }
    }

    ws.onclose = (event) => {
      clearTimeout(connectionTimeout)
      this.handleSocketClose(event)
    }

    ws.onerror = () => {
      clearTimeout(connectionTimeout)
      // onclose will be called after this
    }

    // The Node `ws` library exposes the raw HTTP upgrade response as an
    // `unexpected-response` event when the server returns a non-101 status
    // (for us: 426 Upgrade Required from the protocol-version gate). The
    // global WebSocket in Bun / Node 21+ doesn't expose this — for those
    // runtimes we rely on the close-code path below. Both paths feed into
    // `protocolUpgradeRequired`, so `handleSocketClose` can decide once.
    const wsWithEmitter = ws as unknown as {
      on?: (event: string, listener: (...args: unknown[]) => void) => void
    }
    if (typeof wsWithEmitter.on === 'function') {
      wsWithEmitter.on('unexpected-response', (...args: unknown[]) => {
        const response = args[1] as { statusCode?: number } | undefined
        if (response?.statusCode === 426) {
          this.protocolUpgradeRequired = true
        }
      })
    }
  }

  private handleSocketClose(event: CloseEvent): void {
    this.stopHeartbeat()
    this.isConnected = false

    if (this.isIntentionallyClosed) return

    if (this.isProtocolTooOldClose(event)) {
      this.handleProtocolUpgradeRequired()
      return
    }

    const isAuthFailure = event.code === 4001 ||
      event.reason?.includes('Unauthorized') ||
      (event.code === 1006 && !this.everConnected)

    if (isAuthFailure) {
      console.error('\n❌ Authentication failed. Your device token may be invalid or expired.')
      console.error('   Run `mstro login --force` to re-authenticate.\n')
      this.tokens.notifyAuthExpired()
      this.callbacks.onError?.('Authentication failed - run `mstro login --force`')
      return
    }

    console.log('Disconnected, reconnecting...')
    this.callbacks.onDisconnected?.()
    trackEvent(AnalyticsEvents.PLATFORM_DISCONNECTED)
    this.scheduleReconnect()
  }

  /**
   * The relay can refuse a CLI for being too old in two shapes:
   *
   *   1. **HTTP 426 during upgrade** — the `ws` library surfaces this via
   *      its `unexpected-response` event, which sets
   *      `protocolUpgradeRequired` before `onclose` fires. This is the path
   *      the current server takes (`checkProtocolVersionGate`).
   *
   *   2. **WS close 1002/1008 with `protocol-too-old` reason** — reserved
   *      for a future server variant that completes the upgrade and then
   *      closes (e.g. when the policy check moves into a post-handshake
   *      stage). The reason string is part of the contract with the server.
   *
   * Anything else (1006 race after a successful run, 1001 going-away on
   * deploy) must fall through to the regular reconnect path so transient
   * failures keep healing on their own.
   */
  private isProtocolTooOldClose(event: CloseEvent): boolean {
    if (this.protocolUpgradeRequired) return true
    const code = event.code
    if ((code === 1002 || code === 1008) && event.reason?.includes('protocol-too-old')) {
      return true
    }
    return false
  }

  private handleProtocolUpgradeRequired(): void {
    const message = 'Mstro CLI is out of date for this orchestra. Run `mstro` again to upgrade and reconnect.'
    console.error(`\n❌ ${message}\n`)
    this.callbacks.onError?.(message)
    this.callbacks.onDisconnected?.()

    // Don't exit the process — terminal sessions and other local state stay
    // alive while the user re-runs `mstro`. Schedule a single, far-future
    // reconnect as a sentinel so we silently retry exactly once if the
    // process is somehow still around an hour later. The existing
    // exponential-backoff path is bypassed deliberately: hammering a server
    // that has already decided to refuse on policy is pointless.
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
    }
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      this.connect()
    }, PROTOCOL_UPGRADE_RECONNECT_DELAY_MS)
  }

  private handleMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'paired':
        this.isConnected = true
        this.everConnected = true
        this.connectionId = message.connectionId as string
        this.startHeartbeat()
        this.callbacks.onConnected?.(message.connectionId as string)
        break
      case 'web_connected':
        this.callbacks.onWebConnected?.()
        trackEvent(AnalyticsEvents.WEB_CLIENT_CONNECTED)
        break
      case 'web_disconnected':
        this.callbacks.onWebDisconnected?.()
        trackEvent(AnalyticsEvents.WEB_CLIENT_DISCONNECTED)
        break
      case 'ping':
        // Server-initiated ping — respond with pong to reset stale detection
        this.send({ type: 'pong' })
        break
      case 'pong':
        this.missedPongs = 0
        break
      default:
        this.callbacks.onRelayedMessage?.(message)
        break
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('Max reconnection attempts reached. Restart "mstro" to try again.')
      return
    }

    this.reconnectAttempts++
    const base = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30000)
    const jitter = base * 0.25 * (2 * Math.random() - 1)
    const delay = Math.max(0, Math.round(base + jitter))

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      this.connect()
    }, delay)
  }

  send(message: unknown): void {
    if (this.ws && this.ws.readyState === WebSocketImpl.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }

  isConnectedToPlatform(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocketImpl.OPEN
  }

  disconnect(): void {
    this.isIntentionallyClosed = true
    this.stopHeartbeat()
    this.tokens.stopPeriodicCheck()

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.isConnected = false
    this.connectionId = null
  }
}
