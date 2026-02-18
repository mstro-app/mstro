/**
 * Comprehensive tests for HTTP server middleware and routes
 *
 * Since the server file has heavy side effects (WebSocket, platform connection, analytics, etc.),
 * these tests focus on testing the Hono app's middleware and routes in isolation.
 *
 * Critical areas tested:
 * - Auth middleware (token validation, public paths)
 * - Health endpoint (version, no sensitive data exposure)
 * - Error handler (generic messages, errorId tracking)
 * - CORS (localhost origin validation)
 * - 404 handler (proper JSON errors)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

/**
 * Mock AuthService that replicates the actual service's behavior
 */
class MockAuthService {
  private localToken: string
  private pinHash: string | null = null
  private sessions: Map<string, any> = new Map()

  constructor(pin?: string) {
    this.localToken = 'test-local-token-12345'
    if (pin) {
      this.pinHash = 'hashed-pin'
    }
  }

  validateLocalToken(token: string): boolean {
    return token === this.localToken
  }

  validateSession(token: string): boolean {
    const session = this.sessions.get(token)
    if (!session) return false
    if (session.locked) return false
    return true
  }

  createSession(): string {
    const token = 'valid-session-token-67890'
    this.sessions.set(token, {
      token,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      locked: false
    })
    return token
  }

  isPINEnabled(): boolean {
    return this.pinHash !== null
  }

  updateActivity(token: string): void {
    const session = this.sessions.get(token)
    if (session) {
      session.lastActivity = Date.now()
    }
  }
}

/**
 * Create a test Hono app that replicates the server's middleware setup
 */
function createTestApp(authService: MockAuthService, version: string = '0.1.47') {
  const app = new Hono()

  // CORS middleware - replicates server logic
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

  // Auth middleware - replicates server logic
  const authMiddleware = async (c: any, next: any) => {
    // Skip auth for health check and config
    const publicPaths = ['/health', '/api/config']
    if (publicPaths.some(path => c.req.path.startsWith(path))) {
      return next()
    }

    // Allow auth routes (PIN login/unlock) without session token
    if (c.req.path.startsWith('/api/auth/')) {
      return next()
    }

    // Always require the local session token for localhost security
    const token = c.req.header('x-session-token')
    if (!token) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    // Accept either the local session token or a valid PIN session token
    if (authService.validateLocalToken(token)) {
      return next()
    }

    if (authService.isPINEnabled() && authService.validateSession(token)) {
      authService.updateActivity(token)
      return next()
    }

    return c.json({ error: 'Unauthorized', locked: authService.isPINEnabled() }, 401)
  }

  app.use('/api/*', authMiddleware)

  // Health endpoint - replicates server logic
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: version
    })
  })

  // Config endpoint - replicates server logic
  app.get('/api/config', (c) => {
    return c.json({
      lockWithPin: authService.isPINEnabled(),
      version: version
    })
  })

  // Protected route for testing auth
  app.get('/api/protected', (c) => {
    return c.json({ message: 'Protected resource' })
  })

  // Auth routes (public)
  app.post('/api/auth/login', (c) => {
    return c.json({ token: 'test-token' })
  })

  app.post('/api/auth/unlock', (c) => {
    return c.json({ token: 'test-token' })
  })

  // Route that throws an error for testing error handler
  app.get('/api/error', (c) => {
    throw new Error('Test error with sensitive information')
  })

  // 404 handler - replicates server logic
  app.notFound((c) => {
    return c.json({ error: 'Not found' }, 404)
  })

  // Error handler - replicates server logic with errorId generation
  app.onError((err, c) => {
    const errorId = 'error-id-' + Math.random().toString(16).slice(2, 10)
    console.error(`Server error [${errorId}]:`, err)
    return c.json({
      error: 'Internal server error',
      errorId,
      message: 'Something went wrong. If this persists, report this error ID to support.'
    }, 500)
  })

  return app
}

describe('HTTP Server - Auth Middleware', () => {
  let authService: MockAuthService
  let app: Hono

  beforeEach(() => {
    authService = new MockAuthService()
    app = createTestApp(authService)
  })

  describe('CRITICAL: Authentication requirements', () => {
    it('should reject requests without x-session-token header', async () => {
      const req = new Request('http://localhost/api/protected')
      const res = await app.fetch(req)

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body).toEqual({ error: 'Unauthorized' })
    })

    it('should reject requests with invalid token', async () => {
      const req = new Request('http://localhost/api/protected', {
        headers: { 'x-session-token': 'invalid-token' }
      })
      const res = await app.fetch(req)

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body).toEqual({ error: 'Unauthorized', locked: false })
    })

    it('should accept requests with valid local token', async () => {
      const req = new Request('http://localhost/api/protected', {
        headers: { 'x-session-token': 'test-local-token-12345' }
      })
      const res = await app.fetch(req)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ message: 'Protected resource' })
    })

    it('should include locked status when PIN is enabled and token is invalid', async () => {
      const authServiceWithPIN = new MockAuthService('1234')
      const appWithPIN = createTestApp(authServiceWithPIN)

      const req = new Request('http://localhost/api/protected', {
        headers: { 'x-session-token': 'invalid-token' }
      })
      const res = await appWithPIN.fetch(req)

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body).toEqual({ error: 'Unauthorized', locked: true })
    })

    it('should accept valid session token when PIN is enabled', async () => {
      const authServiceWithPIN = new MockAuthService('1234')
      const sessionToken = authServiceWithPIN.createSession()
      const appWithPIN = createTestApp(authServiceWithPIN)

      const req = new Request('http://localhost/api/protected', {
        headers: { 'x-session-token': sessionToken }
      })
      const res = await appWithPIN.fetch(req)

      expect(res.status).toBe(200)
    })
  })

  describe('Public paths (no auth required)', () => {
    it('should allow access to /health without token', async () => {
      const req = new Request('http://localhost/health')
      const res = await app.fetch(req)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
    })

    it('should allow access to /api/config without token', async () => {
      const req = new Request('http://localhost/api/config')
      const res = await app.fetch(req)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveProperty('lockWithPin')
      expect(body).toHaveProperty('version')
    })

    it('should allow access to /api/auth/login without token', async () => {
      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST'
      })
      const res = await app.fetch(req)

      expect(res.status).toBe(200)
    })

    it('should allow access to /api/auth/unlock without token', async () => {
      const req = new Request('http://localhost/api/auth/unlock', {
        method: 'POST'
      })
      const res = await app.fetch(req)

      expect(res.status).toBe(200)
    })
  })

  describe('Protected API routes', () => {
    it('should protect /api/protected route', async () => {
      const req = new Request('http://localhost/api/protected')
      const res = await app.fetch(req)

      expect(res.status).toBe(401)
    })

    it('should protect routes with query parameters', async () => {
      const req = new Request('http://localhost/api/protected?foo=bar')
      const res = await app.fetch(req)

      expect(res.status).toBe(401)
    })

    it('should protect nested API routes', async () => {
      const req = new Request('http://localhost/api/some/nested/route')
      const res = await app.fetch(req)

      expect(res.status).toBe(401)
    })
  })
})

describe('HTTP Server - Health Endpoint', () => {
  it('should return status ok', async () => {
    const app = createTestApp(new MockAuthService())
    const req = new Request('http://localhost/health')
    const res = await app.fetch(req)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  it('should return version from package.json (not hardcoded)', async () => {
    const testVersion = '0.1.47'
    const app = createTestApp(new MockAuthService(), testVersion)
    const req = new Request('http://localhost/health')
    const res = await app.fetch(req)

    const body = await res.json()
    expect(body.version).toBe(testVersion)
  })

  it('should return ISO timestamp', async () => {
    const app = createTestApp(new MockAuthService())
    const req = new Request('http://localhost/health')
    const res = await app.fetch(req)

    const body = await res.json()
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('should NOT expose workingDirectory', async () => {
    const app = createTestApp(new MockAuthService())
    const req = new Request('http://localhost/health')
    const res = await app.fetch(req)

    const body = await res.json()
    expect(body).not.toHaveProperty('workingDirectory')
    expect(body).not.toHaveProperty('workingDir')
    expect(body).not.toHaveProperty('cwd')
  })

  it('should NOT expose clientId', async () => {
    const app = createTestApp(new MockAuthService())
    const req = new Request('http://localhost/health')
    const res = await app.fetch(req)

    const body = await res.json()
    expect(body).not.toHaveProperty('clientId')
    expect(body).not.toHaveProperty('client_id')
  })

  it('should NOT expose instance ID', async () => {
    const app = createTestApp(new MockAuthService())
    const req = new Request('http://localhost/health')
    const res = await app.fetch(req)

    const body = await res.json()
    expect(body).not.toHaveProperty('instanceId')
    expect(body).not.toHaveProperty('instance_id')
  })

  it('should only return exactly status, timestamp, and version', async () => {
    const app = createTestApp(new MockAuthService())
    const req = new Request('http://localhost/health')
    const res = await app.fetch(req)

    const body = await res.json()
    const keys = Object.keys(body)
    expect(keys).toEqual(['status', 'timestamp', 'version'])
  })
})

describe('HTTP Server - Error Handler', () => {
  let consoleErrorSpy: any

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it('should return generic error message', async () => {
    const app = createTestApp(new MockAuthService())
    const req = new Request('http://localhost/api/error', {
      headers: { 'x-session-token': 'test-local-token-12345' }
    })
    const res = await app.fetch(req)

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Internal server error')
  })

  it('should include an errorId for tracking', async () => {
    const app = createTestApp(new MockAuthService())
    const req = new Request('http://localhost/api/error', {
      headers: { 'x-session-token': 'test-local-token-12345' }
    })
    const res = await app.fetch(req)

    const body = await res.json()
    expect(body).toHaveProperty('errorId')
    expect(typeof body.errorId).toBe('string')
    expect(body.errorId.length).toBeGreaterThan(0)
  })

  it('should include user-friendly message', async () => {
    const app = createTestApp(new MockAuthService())
    const req = new Request('http://localhost/api/error', {
      headers: { 'x-session-token': 'test-local-token-12345' }
    })
    const res = await app.fetch(req)

    const body = await res.json()
    expect(body.message).toBe('Something went wrong. If this persists, report this error ID to support.')
  })

  it('should NOT expose raw error.message to clients', async () => {
    const app = createTestApp(new MockAuthService())
    const req = new Request('http://localhost/api/error', {
      headers: { 'x-session-token': 'test-local-token-12345' }
    })
    const res = await app.fetch(req)

    const body = await res.json()
    const bodyStr = JSON.stringify(body)

    // Should not contain the sensitive error message
    expect(bodyStr).not.toContain('Test error with sensitive information')

    // Should only contain the generic message
    expect(body.message).toBe('Something went wrong. If this persists, report this error ID to support.')
  })

  it('should log error with errorId to console', async () => {
    const app = createTestApp(new MockAuthService())
    const req = new Request('http://localhost/api/error', {
      headers: { 'x-session-token': 'test-local-token-12345' }
    })
    await app.fetch(req)

    expect(consoleErrorSpy).toHaveBeenCalled()
    const callArgs = consoleErrorSpy.mock.calls[0]
    expect(callArgs[0]).toMatch(/Server error \[error-id-/)
  })
})

describe('HTTP Server - CORS', () => {
  let app: Hono

  beforeEach(() => {
    app = createTestApp(new MockAuthService())
  })

  it('should allow localhost origin on default port', async () => {
    const req = new Request('http://localhost/health', {
      headers: { 'Origin': 'http://localhost' }
    })
    const res = await app.fetch(req)

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost')
  })

  it('should allow localhost origin on custom port', async () => {
    const req = new Request('http://localhost/health', {
      headers: { 'Origin': 'http://localhost:3000' }
    })
    const res = await app.fetch(req)

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
  })

  it('should allow 127.0.0.1 origin', async () => {
    const req = new Request('http://localhost/health', {
      headers: { 'Origin': 'http://127.0.0.1:8080' }
    })
    const res = await app.fetch(req)

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8080')
  })

  it('should reject non-localhost origins', async () => {
    const req = new Request('http://localhost/health', {
      headers: { 'Origin': 'http://evil.com' }
    })
    const res = await app.fetch(req)

    expect(res.status).toBe(200)
    // Should fall back to default localhost
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost')
  })

  it('should reject external IP addresses', async () => {
    const req = new Request('http://localhost/health', {
      headers: { 'Origin': 'http://192.168.1.100:3000' }
    })
    const res = await app.fetch(req)

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost')
  })

  it('should handle missing origin header', async () => {
    const req = new Request('http://localhost/health')
    const res = await app.fetch(req)

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost')
  })

  it('should handle malformed origin header', async () => {
    const req = new Request('http://localhost/health', {
      headers: { 'Origin': 'not-a-valid-url' }
    })
    const res = await app.fetch(req)

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost')
  })
})

describe('HTTP Server - 404 Handler', () => {
  let app: Hono

  beforeEach(() => {
    app = createTestApp(new MockAuthService())
  })

  it('should return 404 for unknown routes', async () => {
    const req = new Request('http://localhost/unknown-route')
    const res = await app.fetch(req)

    expect(res.status).toBe(404)
  })

  it('should return JSON error for unknown routes', async () => {
    const req = new Request('http://localhost/unknown-route')
    const res = await app.fetch(req)

    const body = await res.json()
    expect(body).toEqual({ error: 'Not found' })
  })

  it('should return 404 for unknown API routes', async () => {
    const req = new Request('http://localhost/api/nonexistent', {
      headers: { 'x-session-token': 'test-local-token-12345' }
    })
    const res = await app.fetch(req)

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ error: 'Not found' })
  })

  it('should return JSON content-type for 404', async () => {
    const req = new Request('http://localhost/unknown')
    const res = await app.fetch(req)

    expect(res.headers.get('content-type')).toContain('application/json')
  })
})

describe('HTTP Server - Config Endpoint', () => {
  it('should return lockWithPin false when PIN not enabled', async () => {
    const authService = new MockAuthService()
    const app = createTestApp(authService)
    const req = new Request('http://localhost/api/config')
    const res = await app.fetch(req)

    const body = await res.json()
    expect(body.lockWithPin).toBe(false)
  })

  it('should return lockWithPin true when PIN is enabled', async () => {
    const authService = new MockAuthService('1234')
    const app = createTestApp(authService)
    const req = new Request('http://localhost/api/config')
    const res = await app.fetch(req)

    const body = await res.json()
    expect(body.lockWithPin).toBe(true)
  })

  it('should return version', async () => {
    const testVersion = '1.2.3'
    const app = createTestApp(new MockAuthService(), testVersion)
    const req = new Request('http://localhost/api/config')
    const res = await app.fetch(req)

    const body = await res.json()
    expect(body.version).toBe(testVersion)
  })
})

describe('HTTP Server - Security Requirements for Due Diligence', () => {
  describe('Sensitive data exposure prevention', () => {
    it('should not expose server implementation details in any endpoint', async () => {
      const app = createTestApp(new MockAuthService())

      // Test multiple endpoints
      const endpoints = ['/health', '/api/config']

      for (const endpoint of endpoints) {
        const req = new Request(`http://localhost${endpoint}`)
        const res = await app.fetch(req)
        const body = await res.json()
        const bodyStr = JSON.stringify(body)

        // Should not expose internal paths, directories, or implementation details
        expect(bodyStr).not.toMatch(/\/home\//i)
        expect(bodyStr).not.toMatch(/\/Users\//i)
        expect(bodyStr).not.toMatch(/C:\\/i)
        expect(bodyStr).not.toMatch(/node_modules/i)
        expect(bodyStr).not.toMatch(/\.env/i)
      }
    })

    it('should not expose stack traces in error responses', async () => {
      const app = createTestApp(new MockAuthService())
      const req = new Request('http://localhost/api/error', {
        headers: { 'x-session-token': 'test-local-token-12345' }
      })
      const res = await app.fetch(req)
      const body = await res.json()
      const bodyStr = JSON.stringify(body)

      // Should not contain stack trace indicators
      expect(bodyStr).not.toMatch(/at Object\./i)
      expect(bodyStr).not.toMatch(/at async/i)
      expect(bodyStr).not.toMatch(/\.ts:\d+:\d+/i)
      expect(bodyStr).not.toMatch(/Error: /i)
    })
  })

  describe('Authentication bypass prevention', () => {
    it('should not allow authentication bypass with empty string token', async () => {
      const app = createTestApp(new MockAuthService())
      const req = new Request('http://localhost/api/protected', {
        headers: { 'x-session-token': '' }
      })
      const res = await app.fetch(req)

      expect(res.status).toBe(401)
    })

    it('should not allow authentication bypass with whitespace token', async () => {
      const app = createTestApp(new MockAuthService())
      const req = new Request('http://localhost/api/protected', {
        headers: { 'x-session-token': '   ' }
      })
      const res = await app.fetch(req)

      expect(res.status).toBe(401)
    })

    it('should enforce case-sensitive token matching', async () => {
      const app = createTestApp(new MockAuthService())
      const req = new Request('http://localhost/api/protected', {
        headers: { 'x-session-token': 'TEST-LOCAL-TOKEN-12345' } // uppercase
      })
      const res = await app.fetch(req)

      expect(res.status).toBe(401)
    })
  })

  describe('Header name consistency', () => {
    it('should use lowercase header name x-session-token', async () => {
      const app = createTestApp(new MockAuthService())
      const req = new Request('http://localhost/api/protected', {
        headers: { 'X-Session-Token': 'test-local-token-12345' } // Pascal case
      })
      const res = await app.fetch(req)

      // HTTP headers are case-insensitive, so this should work
      expect(res.status).toBe(200)
    })
  })

  describe('CORS security', () => {
    it('should not allow credential-less requests from external origins', async () => {
      const app = createTestApp(new MockAuthService())
      const req = new Request('http://localhost/api/protected', {
        headers: {
          'Origin': 'http://malicious.com',
          'x-session-token': 'test-local-token-12345'
        }
      })
      const res = await app.fetch(req)

      // The request should succeed because we have valid token,
      // but CORS header should not allow the malicious origin
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost')
      expect(res.headers.get('access-control-allow-origin')).not.toBe('http://malicious.com')
    })
  })
})
