// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Mstro Server (Node.js + Hono)
 *
 * Setup helpers live in server-setup.ts.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, Server } from 'node:http'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { serve } from '@hono/node-server'
import { type Context, Hono, type Next } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { type WebSocket as NodeWebSocket, WebSocketServer } from 'ws'
import {
  createFileRoutes,
  createImproviseRoutes,
  createInstanceRoutes,
  createNotificationRoutes,
  createShutdownRoute
} from './routes/index.js'
import { createPlatformRelayContext, ensureClaudeSettings, setTerminalTitle, wrapWebSocket } from './server-setup.js'
import { AnalyticsEvents, initAnalytics, shutdownAnalytics, trackEvent } from './services/analytics.js'
import { AuthService } from './services/auth.js'
import { createAiBrokerRoutes, setDeployHealthUpdateListener, setDeployUsageReportListener } from './services/deploy/ai-broker.js'
import { FileService } from './services/files.js'
import { InstanceRegistry, type MstroInstance } from './services/instances.js'
import { PlatformConnection } from './services/platform.js'
import { captureException, flushSentry, initSentry } from './services/sentry.js'
import { getPTYManager, reloadPty } from './services/terminal/pty-manager.js'
import { WebSocketImproviseHandler } from './services/websocket/index.js'
import type { WSContext } from './services/websocket/types.js'
import { findAvailablePort } from './utils/port.js'

// Configuration
const DEFAULT_PORT = 4101
const REQUESTED_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : DEFAULT_PORT
const WORKING_DIR = process.env.MSTRO_WORKING_DIR || process.env.WORKING_DIR || process.cwd()
const IS_PRODUCTION = process.env.NODE_ENV === 'production'

// Ensure Claude settings on startup
ensureClaudeSettings(WORKING_DIR)
setTerminalTitle(WORKING_DIR)

// Initialize services
const app = new Hono()
const authService = new AuthService()
const instanceRegistry = new InstanceRegistry()
const fileService = new FileService(WORKING_DIR)
const wsHandler = new WebSocketImproviseHandler()
let _currentInstance: MstroInstance | undefined

// Read version from package.json once at startup
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname || '.', '..', 'package.json'), 'utf-8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

// ── Middleware ─────────────────────────────────────────────────

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

const authMiddleware = async (c: Context, next: Next) => {
  const publicPaths = ['/health', '/api/config', '/api/deploy/ai']
  if (publicPaths.some(path => c.req.path.startsWith(path))) {
    return next()
  }
  const token = c.req.header('x-session-token')
  if (!token || !authService.validateLocalToken(token)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return next()
}

app.use('/api/*', authMiddleware)

// ── Routes ────────────────────────────────────────────────────

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString(), version: PKG_VERSION }))
app.get('/api/config', (c) => c.json({ version: PKG_VERSION }))

app.route('/api/instances', createInstanceRoutes(instanceRegistry))
app.route('/api/shutdown', createShutdownRoute(instanceRegistry))
app.route('/api/improvise', createImproviseRoutes(WORKING_DIR))
app.route('/api/files', createFileRoutes(fileService))
app.route('/api/notifications', createNotificationRoutes(WORKING_DIR))
app.route('/api/deploy/ai', createAiBrokerRoutes())

app.post('/api/reload-pty', async (c) => {
  const success = await reloadPty()
  return c.json({ success, available: success })
})

if (IS_PRODUCTION) {
  // For production static file serving, use a reverse proxy like nginx
}

app.notFound((c) => c.json({ error: 'Not found' }, 404))

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

// ── Server Startup ────────────────────────────────────────────

async function startServer() {
  initSentry()
  await initAnalytics()

  const PORT = await findAvailablePort(REQUESTED_PORT, 20)
  _currentInstance = instanceRegistry.register(PORT, WORKING_DIR)

  const server = serve({ fetch: app.fetch, port: PORT })
  const wss = new WebSocketServer({ server: server as Server })

  wss.on('connection', (ws: NodeWebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`)
    if (url.pathname !== '/ws') {
      ws.close(1008, 'Invalid WebSocket path')
      return
    }

    const wsToken = url.searchParams.get('token')
    if (!wsToken || !authService.validateLocalToken(wsToken)) {
      ws.close(4001, 'Unauthorized')
      return
    }

    const workingDir = WORKING_DIR
    const wrappedWs = wrapWebSocket(ws, workingDir)
    wsHandler.handleConnection(wrappedWs, workingDir)

    ws.on('message', (data: Buffer | string) => {
      let message = typeof data === 'string' ? data : data.toString('utf-8')
      // Strip _permission from local WebSocket messages — only the platform relay
      // should inject permission metadata. Local connections are always the machine owner.
      if (message.includes('_permission')) {
        try {
          const parsed = JSON.parse(message)
          if ('_permission' in parsed) {
            delete parsed._permission
            message = JSON.stringify(parsed)
          }
        } catch { /* not JSON — pass through */ }
      }
      wsHandler.handleMessage(wrappedWs, message, workingDir)
    })
    ws.on('close', () => wsHandler.handleClose(wrappedWs))
    ws.on('error', (error: Error) => {
      console.error('[WebSocket] Error:', error)
      captureException(error, { context: 'websocket.connection' })
    })
  })

  const home = homedir()
  const displayDir = WORKING_DIR.startsWith(home) ? `~${WORKING_DIR.slice(home.length)}` : WORKING_DIR
  console.log(`App: ${displayDir}`)
  trackEvent(AnalyticsEvents.SERVER_STARTED, { port: PORT, working_dir_basename: basename(WORKING_DIR) })

  // Platform relay
  let platformRelayContext: WSContext | null = null
  let pendingRelayMessages: unknown[] = []

  const platformConnection = new PlatformConnection(WORKING_DIR, {
    onConnected: () => {
      console.log(`Connected: https://mstro.app`)
      wsHandler.setUsageReporter((report) => {
        platformConnection.send({ type: 'reportUsage', data: report })
      })
      setDeployUsageReportListener((report) => {
        platformConnection.send({ type: 'deployUsageReport', data: report })
      })
      setDeployHealthUpdateListener((update) => {
        platformConnection.send({ type: 'deployAiHealthUpdate', data: update })
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
      // Clean up previous relay context to prevent duplicate broadcasts
      if (platformRelayContext) {
        wsHandler.handleClose(platformRelayContext)
      }
      platformRelayContext = createPlatformRelayContext(
        (message) => platformConnection.send(message),
        WORKING_DIR
      )
      wsHandler.handleConnection(platformRelayContext, WORKING_DIR)
      if (pendingRelayMessages.length > 0) {
        for (const message of pendingRelayMessages) {
          wsHandler.handleMessage(platformRelayContext, JSON.stringify(message), WORKING_DIR)
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
        wsHandler.handleMessage(platformRelayContext, JSON.stringify(message), WORKING_DIR)
      } else {
        // Cap pending messages to prevent unbounded memory growth while disconnected
        if (pendingRelayMessages.length < 100) {
          pendingRelayMessages.push(message)
        }
      }
    }
  })
  platformConnection.connect()

  // Process-level error handling
  process.on('uncaughtException', (err) => {
    console.error('[Server] Uncaught exception:', err)
    captureException(err, { context: 'uncaughtException' })
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[Server] Unhandled rejection:', reason)
    captureException(reason instanceof Error ? reason : new Error(String(reason)), { context: 'unhandledRejection' })
  })

  const gracefulShutdown = async () => {
    trackEvent(AnalyticsEvents.SERVER_STOPPED)
    await Promise.all([shutdownAnalytics(), flushSentry()])
    platformConnection.disconnect()
    instanceRegistry.unregister()
    getPTYManager().closeAll()
    wss.close()
    console.log('\n\n👋 Shutting down gracefully...\n')
    process.exit(0)
  }

  process.on('SIGINT', gracefulShutdown)
  process.on('SIGTERM', gracefulShutdown)
}

startServer()
