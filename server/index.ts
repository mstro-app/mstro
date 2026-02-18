// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Mstro Server (Node.js + Hono)
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { basename, join } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { type WebSocket as NodeWebSocket, WebSocketServer } from 'ws'
// Import route creators
import {
  createFileRoutes,
  createImproviseRoutes,
  createInstanceRoutes,
  createNotificationRoutes, 
  createShutdownRoute
} from './routes/index.js'
import { AnalyticsEvents, initAnalytics, shutdownAnalytics, trackEvent } from './services/analytics.js'
import { AuthService } from './services/auth.js'
import { FileService } from './services/files.js'
import { InstanceRegistry } from './services/instances.js'
import { PlatformConnection } from './services/platform.js'
import { captureException, flushSentry, initSentry } from './services/sentry.js'
import { getPTYManager } from './services/terminal/pty-manager.js'
import { WebSocketImproviseHandler } from './services/websocket/index.js'
import type { WSContext } from './services/websocket/types.js'
import { findAvailablePort } from './utils/port.js'

/**
 * Set the terminal tab title
 * Format: "mstro: directory_name"
 * Uses ANSI escape sequence: ESC ] 0 ; title BEL
 */
function setTerminalTitle(directory: string): void {
  const dirName = basename(directory) || directory
  const title = `mstro: ${dirName}`
  // ESC ] 0 ; title BEL - sets both window title and tab title
  process.stdout.write(`\x1b]0;${title}\x07`)
}

// Create Hono app with type inference
const app = new Hono()

// Configuration
const DEFAULT_PORT = 4101
const REQUESTED_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : DEFAULT_PORT
const WORKING_DIR = process.env.MSTRO_WORKING_DIR || process.env.WORKING_DIR || process.cwd()
const IS_PRODUCTION = process.env.NODE_ENV === 'production'

/**
 * Ensure .claude/settings.json exists with recommended settings
 * for optimal Claude Code performance with Mstro
 */
function ensureClaudeSettings(workingDir: string): void {
  const claudeDir = join(workingDir, '.claude')
  const settingsPath = join(claudeDir, 'settings.json')

  // Create .claude directory if it doesn't exist
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true })
  }

  // Recommended settings for Mstro
  const recommendedSettings = {
    env: {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
      DISABLE_NONESSENTIAL_TRAFFIC: "1"
    }
  }

  // If settings.json doesn't exist, create it
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, JSON.stringify(recommendedSettings, null, 2))
    console.log(`📝 Created .claude/settings.json with recommended settings`)
  } else {
    // If it exists, check if our env settings are present and merge if needed
    try {
      const existingSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      let updated = false

      // Ensure env object exists
      if (!existingSettings.env) {
        existingSettings.env = {}
        updated = true
      }

      // Add our recommended env settings if they don't exist
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
      // If we can't parse the existing file, don't overwrite it
      console.warn(`⚠️ Could not parse existing .claude/settings.json, skipping update`)
    }
  }
}

// Ensure Claude settings on startup
ensureClaudeSettings(WORKING_DIR)

// Set terminal tab title to show mstro is running and which directory
setTerminalTitle(WORKING_DIR)

// Initialize services
const authService = new AuthService()
const instanceRegistry = new InstanceRegistry()
const fileService = new FileService(WORKING_DIR)
const wsHandler = new WebSocketImproviseHandler()

// Instance registration deferred to startServer() when port is known
let _currentInstance: any

// Global middleware
// In production, restrict CORS to block cross-origin browser requests to localhost.
// In dev, allow localhost origins on any port for local frontend dev servers.
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return 'http://localhost'
    try {
      const url = new URL(origin)
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        return origin
      }
    } catch {}
    return 'http://localhost'
  }
}))
app.use('*', logger())

// ========================================
// Authentication Middleware
// ========================================

const authMiddleware = async (c: any, next: any) => {
  // Skip auth for health check and config
  const publicPaths = ['/health', '/api/config']
  if (publicPaths.some(path => c.req.path.startsWith(path))) {
    return next()
  }

  // Require the local session token for localhost security.
  // This prevents other local processes or malicious websites from
  // calling the API without the session token from ~/.mstro/session-token.
  const token = c.req.header('x-session-token')
  if (!token || !authService.validateLocalToken(token)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  return next()
}

app.use('/api/*', authMiddleware)

// ========================================
// Health & Configuration
// ========================================

// Read version from package.json once at startup
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname || '.', '..', 'package.json'), 'utf-8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: PKG_VERSION
  })
})

app.get('/api/config', (c) => {
  return c.json({
    version: PKG_VERSION
  })
})

// ========================================
// Mount Routes
// ========================================

app.route('/api/instances', createInstanceRoutes(instanceRegistry))
app.route('/api/shutdown', createShutdownRoute(instanceRegistry))
app.route('/api/improvise', createImproviseRoutes(WORKING_DIR))
app.route('/api/files', createFileRoutes(fileService))
app.route('/api/notifications', createNotificationRoutes(WORKING_DIR))

// ========================================
// Static File Serving (Production Only)
// ========================================

if (IS_PRODUCTION) {
  // For production static file serving, use a reverse proxy like nginx
  // or implement a simple static file middleware if needed
  console.log('Production mode: serve static files via nginx or similar')
}

// ========================================
// 404 & Error Handlers
// ========================================

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404)
})

app.onError((err, c) => {
  const errorId = randomBytes(4).toString('hex')
  console.error(`Server error [${errorId}]:`, err)
  captureException(err, { errorId, path: c.req.path, method: c.req.method })
  return c.json({
    error: 'Internal server error',
    errorId,
    message: 'Something went wrong. If this persists, report this error ID to support.'
  }, 500)
})

// ========================================
// Node.js Server with WebSocket Support
// ========================================

/**
 * Wrap a ws WebSocket to match our WSContext interface
 */
function wrapWebSocket(ws: NodeWebSocket, workingDir: string): WSContext {
  return {
    send: (data: string | Buffer) => ws.send(data),
    close: () => ws.close(),
    readyState: ws.readyState,
    _workingDir: workingDir,
    _ws: ws
  } as WSContext
}

/**
 * Create a virtual WebSocket context that sends responses through the platform relay
 * This allows messages from the web (via platform) to be handled by the same wsHandler
 */
function createPlatformRelayContext(
  platformSend: (message: any) => void,
  workingDir: string
): WSContext {
  return {
    send: (data: string | Buffer) => {
      // Parse the response and send through platform relay
      try {
        const response = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString())
        platformSend(response)
      } catch (e) {
        // If not JSON, send as-is (shouldn't happen with our protocol)
        console.error('[PlatformRelay] Failed to parse response:', e)
      }
    },
    close: () => {
      // No-op for platform relay - connection is managed by PlatformConnection
    },
    readyState: 1, // WebSocket.OPEN
    _workingDir: workingDir,
    _isPlatformRelay: true
  } as WSContext
}

// Start server with dynamic port selection
async function startServer() {
  // Initialize error tracking (must be first)
  initSentry()

  // Initialize analytics (fetches config from platform)
  await initAnalytics()

  const PORT = await findAvailablePort(REQUESTED_PORT, 20)

  if (PORT !== REQUESTED_PORT) {
    console.log(`⚠️  Port ${REQUESTED_PORT} in use, using port ${PORT}`)
  }

  _currentInstance = instanceRegistry.register(PORT, WORKING_DIR)

  // Create HTTP server with Hono
  const server = serve({
    fetch: app.fetch,
    port: PORT
  })

  // Create WebSocket server attached to the HTTP server
  const wss = new WebSocketServer({ server: server as any })

  wss.on('connection', (ws: NodeWebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`)

    // Only handle /ws endpoint
    if (url.pathname !== '/ws') {
      ws.close(1008, 'Invalid WebSocket path')
      return
    }

    // Require local session token for WebSocket connections
    const wsToken = url.searchParams.get('token')
    if (!wsToken || !authService.validateLocalToken(wsToken)) {
      ws.close(4001, 'Unauthorized')
      return
    }

    // Always use the server's working directory — don't allow clients to override
    const workingDir = WORKING_DIR
    const wrappedWs = wrapWebSocket(ws, workingDir)

    wsHandler.handleConnection(wrappedWs, workingDir)

    ws.on('message', (data: Buffer | string) => {
      const message = typeof data === 'string' ? data : data.toString('utf-8')
      wsHandler.handleMessage(wrappedWs, message, workingDir)
    })

    ws.on('close', () => {
      wsHandler.handleClose(wrappedWs)
    })

    ws.on('error', (error: Error) => {
      console.error('[WebSocket] Error:', error)
      captureException(error, { context: 'websocket.connection' })
    })
  })

  console.log(`🚀 Mstro Server (Node.js + Hono) on port ${PORT}`)
  console.log(`📁 Working directory: ${WORKING_DIR}`)
  console.log(`Runtime: Node.js ${process.version}`)
  console.log(`Framework: Hono`)

  // Track server started event
  trackEvent(AnalyticsEvents.SERVER_STARTED, {
    port: PORT,
    working_dir_basename: basename(WORKING_DIR),
  })

  // Create a virtual WebSocket context for platform relay
  // This allows messages from the web (via platform) to use the same wsHandler
  let platformRelayContext: WSContext | null = null

  // Queue for messages that arrive before relay context is ready
  // This handles race conditions where initTab arrives before web_connected
  let pendingRelayMessages: any[] = []

  // Connect to platform
  const platformConnection = new PlatformConnection(WORKING_DIR, {
    onConnected: (_connectionId) => {
      console.log(`🎵 Orchestra ready: ${basename(WORKING_DIR)}`)

      // Set up usage reporter to send token usage to platform
      wsHandler.setUsageReporter((report) => {
        platformConnection.send({
          type: 'reportUsage',
          data: report
        })
      })
    },
    onWebConnected: () => {
      // Create the relay context when web connects
      platformRelayContext = createPlatformRelayContext(
        (message) => platformConnection.send(message),
        WORKING_DIR
      )
      // Initialize the connection for the wsHandler
      wsHandler.handleConnection(platformRelayContext, WORKING_DIR)

      // Process any messages that arrived before relay context was ready
      if (pendingRelayMessages.length > 0) {
        for (const message of pendingRelayMessages) {
          wsHandler.handleMessage(platformRelayContext, JSON.stringify(message), WORKING_DIR)
        }
        pendingRelayMessages = []
      }
    },
    onWebDisconnected: () => {
      // Clean up when web disconnects
      if (platformRelayContext) {
        wsHandler.handleClose(platformRelayContext)
        platformRelayContext = null
      }
      // Clear any pending messages
      pendingRelayMessages = []
    },
    onRelayedMessage: (message) => {
      // Forward messages from web (via platform) to the wsHandler
      if (platformRelayContext) {
        wsHandler.handleMessage(platformRelayContext, JSON.stringify(message), WORKING_DIR)
      } else {
        // Queue the message - it will be processed when web_connected arrives
        pendingRelayMessages.push(message)
      }
    }
  })
  platformConnection.connect()

  // Catch unhandled errors at process level
  process.on('uncaughtException', (err) => {
    console.error('[Server] Uncaught exception:', err)
    captureException(err, { context: 'uncaughtException' })
  })

  process.on('unhandledRejection', (reason) => {
    console.error('[Server] Unhandled rejection:', reason)
    captureException(reason instanceof Error ? reason : new Error(String(reason)), { context: 'unhandledRejection' })
  })

  // Cleanup on exit
  process.on('SIGINT', async () => {
    trackEvent(AnalyticsEvents.SERVER_STOPPED)
    await Promise.all([shutdownAnalytics(), flushSentry()])
    platformConnection.disconnect()
    instanceRegistry.unregister()
    // Close all non-persistent terminal sessions (PTY processes)
    // Note: Persistent (tmux) sessions are intentionally left running
    getPTYManager().closeAll()
    wss.close()
    console.log('\n\n👋 Shutting down gracefully...\n')
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    trackEvent(AnalyticsEvents.SERVER_STOPPED)
    await Promise.all([shutdownAnalytics(), flushSentry()])
    platformConnection.disconnect()
    instanceRegistry.unregister()
    // Close all non-persistent terminal sessions (PTY processes)
    // Note: Persistent (tmux) sessions are intentionally left running
    getPTYManager().closeAll()
    wss.close()
    console.log('\n\n👋 Shutting down gracefully...\n')
    process.exit(0)
  })

  // Periodic cleanup
  setInterval(() => {
    wsHandler.cleanupStaleSessions()
  }, 5 * 60 * 1000) // Every 5 minutes
}

startServer()
