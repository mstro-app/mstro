// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

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
import {
  CLI_VERSION,
  getCredentials,
  shouldRefreshToken,
  updateCredentials,
} from './platform-credentials.js'
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
  const { default: WS } = await import('ws')
  WebSocketImpl = WS as unknown as typeof WebSocket
}

// PLATFORM_URL is set via --server / --dev flag in mstro.js
const DEFAULT_PLATFORM_URL = process.env.PLATFORM_URL || 'https://api.mstro.app'

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
  private tokenRefreshInterval: ReturnType<typeof setInterval> | null = null
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private missedPongs = 0
  private everConnected = false
  private readonly startedAt: string

  constructor(
    workingDirectory: string,
    callbacks: ConnectionCallbacks = {},
    platformUrl?: string
  ) {
    this.workingDirectory = workingDirectory
    this.platformUrl = platformUrl || DEFAULT_PLATFORM_URL
    this.callbacks = callbacks
    this.startedAt = new Date().toISOString()
  }

  private async maybeRefreshToken(): Promise<void> {
    const creds = getCredentials()
    if (!creds || !shouldRefreshToken(creds)) return

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

  private startTokenRefreshCheck(): void {
    this.tokenRefreshInterval = setInterval(() => {
      this.maybeRefreshToken()
    }, 24 * 60 * 60 * 1000)
  }

  private startHeartbeat(): void {
    this.missedPongs = 0
    this.heartbeatInterval = setInterval(() => this.heartbeatTick(), 2 * 60 * 1000)
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

  private stopTokenRefreshCheck(): void {
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval)
      this.tokenRefreshInterval = null
    }
  }

  connect(): void {
    this.isIntentionallyClosed = false
    const name = basename(this.workingDirectory)
    const machineHostname = hostname()
    const clientId = getClientId()
    const machineId = getMachineIdentifier()
    const nodeVersion = process.version
    const osType = type().toLowerCase()
    const cpuArch = arch()

    const credentials = getCredentials()
    const authToken = credentials?.token

    if (!authToken) {
      console.error('\n❌ Not logged in. Run `mstro login` first.\n')
      this.callbacks.onError?.('Not logged in - run `mstro login` first')
      return
    }

    const params = new URLSearchParams({
      name,
      workingDirectory: this.workingDirectory,
      machineHostname,
      clientId,
      machineId,
      nodeVersion,
      osType,
      cpuArch,
      cliVersion: CLI_VERSION,
      capabilities: JSON.stringify({}),
      startedAt: this.startedAt,
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

    const connectionTimeout = setTimeout(() => {
      const state = this.ws?.readyState
      if (this.ws && (state === 0 || state === undefined)) {
        console.error('\n❌ Connection timeout. The platform may have rejected your credentials.')
        console.error('   Run `mstro login --force` to re-authenticate.\n')
        this.ws.close()
        this.callbacks.onError?.('Connection timeout - run `mstro login --force`')
      }
    }, 10000)

    this.ws.onopen = () => {
      clearTimeout(connectionTimeout)
      this.ws!.send(JSON.stringify({ type: 'auth', token: authToken }))
      this.maybeRefreshToken()
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

    this.ws.onclose = (event) => {
      this.stopHeartbeat()
      this.isConnected = false

      if (!this.isIntentionallyClosed) {
        const isAuthFailure = event.code === 4001 ||
          event.reason?.includes('Unauthorized') ||
          (event.code === 1006 && !this.everConnected)

        if (isAuthFailure) {
          console.error('\n❌ Authentication failed. Your device token may be invalid or expired.')
          console.error('   Run `mstro login --force` to re-authenticate.\n')
          this.callbacks.onError?.('Authentication failed - run `mstro login --force`')
          return
        }

        console.log('Disconnected, reconnecting...')
        this.callbacks.onDisconnected?.()
        trackEvent(AnalyticsEvents.PLATFORM_DISCONNECTED)
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = () => {
      // onclose will be called after this
    }
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
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30000)

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
