// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Mstro Server (Node.js + Hono)
 *
 * Setup helpers live in server-setup.ts.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { serve } from '@hono/node-server'
import { type Context, Hono, type Next } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { WebSocketServer } from 'ws'
import {
  createFileRoutes,
  createImproviseRoutes,
  createInstanceRoutes,
  createNotificationRoutes,
  createShutdownRoute
} from './routes/index.js'
import {
  attachLocalWebSocketRouting,
  createPlatformRelay,
  ensureClaudeSettings,
  registerProcessErrorHandlers,
  setTerminalTitle
} from './server-setup.js'
import { AnalyticsEvents, initAnalytics, shutdownAnalytics, trackEvent } from './services/analytics.js'
import { AuthService } from './services/auth.js'
import { FileService } from './services/files.js'
import { InstanceRegistry, type MstroInstance } from './services/instances.js'
import { captureException, flushSentry, initSentry } from './services/sentry.js'
import { getPTYManager, reloadPty } from './services/terminal/pty-manager.js'
import { WebSocketImproviseHandler } from './services/websocket/index.js'
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
  const publicPaths = ['/health', '/api/config']
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

function logStartupBanner(port: number): void {
  const home = homedir()
  const displayDir = WORKING_DIR.startsWith(home) ? `~${WORKING_DIR.slice(home.length)}` : WORKING_DIR
  console.log(`App: ${displayDir}`)
  trackEvent(AnalyticsEvents.SERVER_STARTED, { port, working_dir_basename: basename(WORKING_DIR) })
}

function makeGracefulShutdown(deps: {
  platformConnection: { disconnect: () => void }
  wss: WebSocketServer
}) {
  return async () => {
    trackEvent(AnalyticsEvents.SERVER_STOPPED)
    await Promise.all([shutdownAnalytics(), flushSentry()])
    deps.platformConnection.disconnect()
    instanceRegistry.unregister()
    getPTYManager().closeAll()
    deps.wss.close()
    console.log('\n\n👋 Shutting down gracefully...\n')
    process.exit(0)
  }
}

async function startServer() {
  initSentry()
  await initAnalytics()

  const port = await findAvailablePort(REQUESTED_PORT, 20)
  _currentInstance = instanceRegistry.register(port, WORKING_DIR)

  const server = serve({ fetch: app.fetch, port })
  const wss = new WebSocketServer({ server: server as Server })

  attachLocalWebSocketRouting({ wss, port, workingDir: WORKING_DIR, authService, wsHandler })
  logStartupBanner(port)

  const platformConnection = createPlatformRelay(WORKING_DIR, wsHandler)
  registerProcessErrorHandlers()

  const gracefulShutdown = makeGracefulShutdown({ platformConnection, wss })
  process.on('SIGINT', gracefulShutdown)
  process.on('SIGTERM', gracefulShutdown)
}

startServer()
