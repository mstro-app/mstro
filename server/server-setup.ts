// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Server Setup Utilities — Helpers for the main server entry point.
 *
 * - ensureClaudeSettings: Ensures .claude/settings.json has recommended defaults
 * - wrapWebSocket / createPlatformRelayContext: WSContext adapters
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { basename, join } from 'node:path'
import type { WebSocket as NodeWebSocket, WebSocketServer } from 'ws'
import type { AuthService } from './services/auth.js'
import { PlatformConnection } from './services/platform.js'
import { captureException } from './services/sentry.js'
import type { WebSocketImproviseHandler } from './services/websocket/index.js'
import type { WSContext } from './services/websocket/types.js'

/**
 * Set the terminal tab title
 * Format: "mstro: directory_name"
 */
export function setTerminalTitle(directory: string): void {
  const dirName = basename(directory) || directory
  const title = `mstro: ${dirName}`
  process.stdout.write(`\x1b]0;${title}\x07`)
}

/**
 * Ensure .claude/settings.json exists with recommended settings
 * for optimal Claude Code performance with Mstro
 */
export function ensureClaudeSettings(workingDir: string): void {
  const claudeDir = join(workingDir, '.claude')
  const settingsPath = join(claudeDir, 'settings.json')

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true })
  }

  const recommendedSettings = {
    env: {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
      DISABLE_NONESSENTIAL_TRAFFIC: "1"
    }
  }

  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, JSON.stringify(recommendedSettings, null, 2))
    console.log(`📝 Created .claude/settings.json with recommended settings`)
  } else {
    try {
      const existingSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      let updated = false

      if (!existingSettings.env) {
        existingSettings.env = {}
        updated = true
      }

      if (!existingSettings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
        existingSettings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "64000"
        updated = true
      }
      if (!existingSettings.env.DISABLE_NONESSENTIAL_TRAFFIC) {
        existingSettings.env.DISABLE_NONESSENTIAL_TRAFFIC = "1"
        updated = true
      }

      if (updated) {
        writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2))
        console.log(`📝 Updated .claude/settings.json with recommended env settings`)
      }
    } catch (_e) {
      console.warn(`⚠️ Could not parse existing .claude/settings.json, skipping update`)
    }
  }
}

/**
 * Wrap a ws WebSocket to match our WSContext interface
 */
export function wrapWebSocket(ws: NodeWebSocket, workingDir: string): WSContext {
  return {
    send: (data: string | Buffer) => ws.send(data),
    close: () => ws.close(),
    get readyState() { return ws.readyState },
    _workingDir: workingDir,
    _ws: ws
  } as WSContext
}

/**
 * Create a virtual WebSocket context that sends responses through the platform relay.
 * This allows messages from the web (via platform) to be handled by the same wsHandler.
 */
export function createPlatformRelayContext(
  platformSend: (message: unknown) => void,
  workingDir: string
): WSContext {
  return {
    send: (data: string | Buffer) => {
      try {
        const response = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString())
        platformSend(response)
      } catch (e) {
        console.error('[PlatformRelay] Failed to parse response:', e)
      }
    },
    close: () => {
      // No-op for platform relay
    },
    readyState: 1, // WebSocket.OPEN
    _workingDir: workingDir,
    _isPlatformRelay: true
  } as WSContext
}

/** Strip the privileged `_permission` field from inbound local messages. */
function sanitizeLocalMessage(raw: Buffer | string): string {
  const message = typeof raw === 'string' ? raw : raw.toString('utf-8')
  if (!message.includes('_permission')) return message
  try {
    const parsed = JSON.parse(message)
    if ('_permission' in parsed) {
      delete parsed._permission
      return JSON.stringify(parsed)
    }
  } catch { /* not JSON — pass through */ }
  return message
}

/** Attach the local WebSocket connection handler to the WebSocketServer. */
export function attachLocalWebSocketRouting(opts: {
  wss: WebSocketServer
  port: number
  workingDir: string
  authService: AuthService
  wsHandler: WebSocketImproviseHandler
}): void {
  const { wss, port, workingDir, authService, wsHandler } = opts

  wss.on('connection', (ws: NodeWebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)
    if (url.pathname !== '/ws') {
      ws.close(1008, 'Invalid WebSocket path')
      return
    }

    const wsToken = url.searchParams.get('token')
    if (!wsToken || !authService.validateLocalToken(wsToken)) {
      ws.close(4001, 'Unauthorized')
      return
    }

    const wrappedWs = wrapWebSocket(ws, workingDir)
    wsHandler.handleConnection(wrappedWs, workingDir)

    ws.on('message', (data: Buffer | string) => {
      wsHandler.handleMessage(wrappedWs, sanitizeLocalMessage(data), workingDir)
    })
    ws.on('close', () => wsHandler.handleClose(wrappedWs))
    ws.on('error', (error: Error) => {
      console.error('[WebSocket] Error:', error)
      captureException(error, { context: 'websocket.connection' })
    })
  })
}

/** Connect to the platform relay and wire up message bridging to the local wsHandler. */
export function createPlatformRelay(workingDir: string, wsHandler: WebSocketImproviseHandler): PlatformConnection {
  let platformRelayContext: WSContext | null = null
  let pendingRelayMessages: unknown[] = []

  const platformConnection = new PlatformConnection(workingDir, {
    onConnected: () => {
      console.log(`Connected: https://mstro.app`)
      wsHandler.setUsageReporter((report) => {
        platformConnection.send({ type: 'reportUsage', data: report })
      })
    },
    onDisconnected: () => {
      if (platformRelayContext) {
        wsHandler.handleClose(platformRelayContext)
        platformRelayContext = null
      }
      pendingRelayMessages = []
    },
    onWebConnected: () => {
      if (platformRelayContext) {
        wsHandler.handleClose(platformRelayContext)
      }
      platformRelayContext = createPlatformRelayContext(
        (message) => platformConnection.send(message),
        workingDir
      )
      wsHandler.handleConnection(platformRelayContext, workingDir)
      if (pendingRelayMessages.length > 0) {
        for (const message of pendingRelayMessages) {
          wsHandler.handleMessage(platformRelayContext, JSON.stringify(message), workingDir)
        }
        pendingRelayMessages = []
      }
    },
    onWebDisconnected: () => {
      if (platformRelayContext) {
        wsHandler.handleClose(platformRelayContext)
        platformRelayContext = null
      }
      pendingRelayMessages = []
    },
    onRelayedMessage: (message) => {
      if (platformRelayContext) {
        wsHandler.handleMessage(platformRelayContext, JSON.stringify(message), workingDir)
      } else {
        // Cap pending messages to prevent unbounded memory growth while disconnected
        if (pendingRelayMessages.length < 100) {
          pendingRelayMessages.push(message)
        }
      }
    }
  })
  platformConnection.connect()
  return platformConnection
}

/** Install process-level error handlers that capture to Sentry. */
export function registerProcessErrorHandlers(): void {
  process.on('uncaughtException', (err) => {
    console.error('[Server] Uncaught exception:', err)
    captureException(err, { context: 'uncaughtException' })
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[Server] Unhandled rejection:', reason)
    captureException(reason instanceof Error ? reason : new Error(String(reason)), { context: 'unhandledRejection' })
  })
}
