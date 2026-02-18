// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Platform Connection Service
 *
 * Handles WebSocket connection to the Mstro platform.
 * Requires token-based authentication from `mstro login`.
 *
 * Flow:
 * 1. Client reads token from ~/.mstro/credentials.json
 * 2. Client connects to platform WebSocket with auth token
 * 3. Platform validates token and auto-pairs to user's account
 * 4. Client becomes an "orchestra" visible in user's web dashboard
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, homedir, hostname, type } from 'node:os'
import { basename, join } from 'node:path'
import { AnalyticsEvents, trackEvent } from './analytics.js'
import { getClientId } from './client-id.js'
import { captureException } from './sentry.js'
import { isTmuxAvailable } from './terminal/tmux-manager.js'

const MSTRO_DIR = join(homedir(), '.mstro')
const CREDENTIALS_FILE = join(MSTRO_DIR, 'credentials.json')

// Refresh token every 30 days
const TOKEN_REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000

interface StoredCredentials {
  token: string
  userId: string
  email: string
  name?: string
  clientId: string
  lastRefreshedAt?: string
}

/**
 * Get stored credentials from ~/.mstro/credentials.json
 */
function getCredentials(): StoredCredentials | null {
  if (!existsSync(CREDENTIALS_FILE)) {
    return null
  }
  try {
    const content = readFileSync(CREDENTIALS_FILE, 'utf-8')
    const creds = JSON.parse(content)
    if (creds.token && creds.userId && creds.email) {
      return creds
    }
    return null
  } catch {
    return null
  }
}

/**
 * Update stored credentials (for token refresh)
 */
function updateCredentials(updates: Partial<StoredCredentials>): void {
  const creds = getCredentials()
  if (!creds) return

  writeFileSync(CREDENTIALS_FILE, JSON.stringify({ ...creds, ...updates }, null, 2), {
    mode: 0o600
  })
}

/**
 * Check if token should be refreshed
 */
function shouldRefreshToken(creds: StoredCredentials): boolean {
  if (!creds.lastRefreshedAt) {
    return true // Never refreshed
  }

  const lastRefreshed = new Date(creds.lastRefreshedAt).getTime()
  const now = Date.now()
  return now - lastRefreshed > TOKEN_REFRESH_INTERVAL_MS
}

/**
 * Get machine identification string
 * Format: "hostname @ node-vX.X.X platform (arch)"
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
  const { default: WS } = await import('ws')
  WebSocketImpl = WS as unknown as typeof WebSocket
}

const DEFAULT_PLATFORM_URL = process.env.PLATFORM_URL || 'https://api.mstro.app'

interface ConnectionCallbacks {
  onConnected?: (connectionId: string) => void
  onDisconnected?: () => void
  onError?: (error: string) => void
  onWebConnected?: () => void
  onWebDisconnected?: () => void
  onRelayedMessage?: (message: any) => void
}

/**
 * Platform WebSocket connection with token-based authentication
 */
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
  private tokenRefreshInterval: ReturnType<typeof setInterval> | null = null
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    workingDirectory: string,
    callbacks: ConnectionCallbacks = {},
    platformUrl?: string
  ) {
    this.workingDirectory = workingDirectory
    this.platformUrl = platformUrl || DEFAULT_PLATFORM_URL
    this.callbacks = callbacks
  }

  /**
   * Refresh the device token if needed
   */
  private async maybeRefreshToken(): Promise<void> {
    const creds = getCredentials()
    if (!creds || !shouldRefreshToken(creds)) {
      return
    }

    try {
      const response = await fetch(`${this.platformUrl}/api/auth/device/refresh`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${creds.token}`,
          'Content-Type': 'application/json'
        }
      })

      if (response.ok) {
        const data = await response.json() as { accessToken: string }
        updateCredentials({
          token: data.accessToken,
          lastRefreshedAt: new Date().toISOString()
        })
      } else {
        console.warn('[Platform] Token refresh failed, will retry later')
      }
    } catch (err) {
      console.warn('[Platform] Token refresh error:', err)
    }
  }

  /**
   * Start periodic token refresh check
   */
  private startTokenRefreshCheck(): void {
    // Check every 24 hours
    this.tokenRefreshInterval = setInterval(() => {
      this.maybeRefreshToken()
    }, 24 * 60 * 60 * 1000)
  }

  /**
   * Start heartbeat to keep connection alive and refresh server-side TTL
   */
  private startHeartbeat(): void {
    // Send ping every 2 minutes (server TTL is 5 minutes)
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.isConnected) {
        try {
          this.ws.send(JSON.stringify({ type: 'ping' }))
        } catch {
          // Ignore send errors - will reconnect if disconnected
        }
      }
    }, 2 * 60 * 1000)
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  /**
   * Stop periodic token refresh check
   */
  private stopTokenRefreshCheck(): void {
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval)
      this.tokenRefreshInterval = null
    }
  }

  /**
   * Connect to platform WebSocket
   */
  connect(): void {
    this.isIntentionallyClosed = false
    const name = basename(this.workingDirectory)
    const machineHostname = hostname()
    const clientId = getClientId()
    const machineId = getMachineIdentifier()
    const nodeVersion = process.version
    const osType = type().toLowerCase()
    const cpuArch = arch()

    // Get auth token from credentials
    const credentials = getCredentials()
    const authToken = credentials?.token

    if (!authToken) {
      console.error('\n❌ Not logged in. Run `mstro login` first.\n')
      this.callbacks.onError?.('Not logged in - run `mstro login` first')
      return
    }

    // Check for tmux availability (for persistent terminals)
    const hasTmux = isTmuxAvailable()

    // Build URL params WITHOUT the auth token — token is sent post-connection
    // to avoid leaking it in proxy logs, browser history, and server access logs
    const params = new URLSearchParams({
      name,
      workingDirectory: this.workingDirectory,
      machineHostname,
      clientId,
      machineId,
      nodeVersion,
      osType,
      cpuArch,
      capabilities: JSON.stringify({ tmux: hasTmux })
    })

    const wsUrl = `${this.platformUrl.replace(/^http/, 'ws')}/ws/client?${params}`

    try {
      this.ws = new WebSocketImpl(wsUrl)
    } catch (err) {
      console.error('Failed to create WebSocket connection:', err)
      captureException(err instanceof Error ? err : new Error(String(err)), { context: 'platform.connect' })
      this.callbacks.onError?.('Failed to connect to platform')
      this.scheduleReconnect()
      return
    }

    // Connection timeout - if not connected within 10 seconds, show helpful error
    const connectionTimeout = setTimeout(() => {
      const state = this.ws?.readyState
      if (this.ws && (state === 0 || state === undefined)) { // CONNECTING or unknown
        console.error('\n❌ Connection timeout. The platform may have rejected your credentials.')
        console.error('   Run `mstro login --force` to re-authenticate.\n')
        this.ws.close()
        this.callbacks.onError?.('Connection timeout - run `mstro login --force`')
      }
    }, 10000)

    this.ws.onopen = () => {
      clearTimeout(connectionTimeout)
      console.log(`🌐 Connected to platform`)

      // Send auth token as first message instead of URL param
      this.ws!.send(JSON.stringify({ type: 'auth', token: authToken }))

      // Check if token needs refresh on connect
      this.maybeRefreshToken()
      // Start periodic refresh checks
      this.startTokenRefreshCheck()
      this.reconnectAttempts = 0
      trackEvent(AnalyticsEvents.PLATFORM_CONNECTED)
    }

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data.toString())
        this.handleMessage(message)
      } catch (err) {
        console.error('Failed to parse platform message:', err)
      }
    }

    // Track if we ever successfully connected (received 'paired' message)
    let everConnected = false
    const originalOnConnected = this.callbacks.onConnected
    this.callbacks.onConnected = (connectionId) => {
      everConnected = true
      originalOnConnected?.(connectionId)
    }

    this.ws.onclose = (event) => {
      // Stop heartbeat on any close
      this.stopHeartbeat()
      this.isConnected = false

      if (!this.isIntentionallyClosed) {
        // Check if we were rejected due to auth (code 4001 or 1006 before ever connecting)
        const isAuthFailure = event.code === 4001 ||
          event.reason?.includes('Unauthorized') ||
          (event.code === 1006 && !everConnected)

        if (isAuthFailure) {
          console.error('\n❌ Authentication failed. Your device token may be invalid or expired.')
          console.error('   Run `mstro login --force` to re-authenticate.\n')
          this.callbacks.onError?.('Authentication failed - run `mstro login --force`')
          return
        }

        console.log('Disconnected from platform, reconnecting...')
        this.callbacks.onDisconnected?.()
        trackEvent(AnalyticsEvents.PLATFORM_DISCONNECTED)
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = () => {
      // onclose will be called after this
    }
  }

  private handleMessage(message: any): void {
    switch (message.type) {
      case 'paired':
        this.isConnected = true
        this.connectionId = message.connectionId
        console.log(`⚡ Connected to mstro.app!`)
        // Start heartbeat to keep server-side TTL refreshed
        this.startHeartbeat()
        this.callbacks.onConnected?.(message.connectionId)
        break

      case 'web_connected':
        console.log('🔗 Web client connected')
        this.callbacks.onWebConnected?.()
        trackEvent(AnalyticsEvents.WEB_CLIENT_CONNECTED)
        break

      case 'web_disconnected':
        console.log('🔗 Web client disconnected')
        this.callbacks.onWebDisconnected?.()
        trackEvent(AnalyticsEvents.WEB_CLIENT_DISCONNECTED)
        break

      case 'pong':
        // Heartbeat response, ignore
        break

      default:
        // Relay message from web to wsHandler
        // These are messages like 'execute', 'initTab', 'autocomplete', etc.
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
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30000)

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      this.connect()
    }, delay)
  }

  /**
   * Send message to platform (will be relayed to web if connected)
   */
  send(message: any): void {
    if (this.ws && this.ws.readyState === WebSocketImpl.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }

  /**
   * Check if connected to platform
   */
  isConnectedToPlatform(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocketImpl.OPEN
  }

  /**
   * Disconnect from platform
   */
  disconnect(): void {
    this.isIntentionallyClosed = true

    // Stop heartbeat and token refresh checks
    this.stopHeartbeat()
    this.stopTokenRefreshCheck()

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
