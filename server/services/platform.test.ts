/**
 * Platform Connection Service Tests
 *
 * Comprehensive test suite for due diligence validation.
 * Tests critical security features, connection lifecycle, message handling, and token refresh.
 */

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock modules before importing the module under test
const mockFs = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}

const mockOs = {
  hostname: vi.fn(),
  type: vi.fn(),
  arch: vi.fn(),
  homedir: vi.fn(),
}

const mockPath = {
  join: vi.fn((...args: string[]) => args.join('/')),
  basename: vi.fn((path: string) => path.split('/').pop() || ''),
}

const mockClientId = {
  getClientId: vi.fn(),
}

const mockTmux = {
  isTmuxAvailable: vi.fn(),
}

// Mock fetch globally
global.fetch = vi.fn()

// Mock WebSocket class
class MockWebSocket extends EventEmitter {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  public readyState: number = MockWebSocket.CONNECTING
  public url: string
  public onopen: ((event: any) => void) | null = null
  public onclose: ((event: any) => void) | null = null
  public onerror: ((event: any) => void) | null = null
  public onmessage: ((event: any) => void) | null = null

  constructor(url: string) {
    super()
    this.url = url
  }

  send(data: string): void {
    this.emit('send', data)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    if (this.onclose) {
      this.onclose({ code: 1000, reason: 'Normal closure' })
    }
  }

  // Helper methods for testing
  triggerOpen(): void {
    this.readyState = MockWebSocket.OPEN
    if (this.onopen) {
      this.onopen({})
    }
  }

  triggerMessage(data: any): void {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) })
    }
  }

  triggerClose(code: number = 1000, reason: string = ''): void {
    this.readyState = MockWebSocket.CLOSED
    if (this.onclose) {
      this.onclose({ code, reason })
    }
  }

  triggerError(): void {
    if (this.onerror) {
      this.onerror({})
    }
  }
}

// Store WebSocket instance for test access
let lastWebSocketInstance: MockWebSocket | null = null

function createMockWebSocket(url: string): MockWebSocket {
  lastWebSocketInstance = new MockWebSocket(url)
  return lastWebSocketInstance
}

const WebSocketConstructor = vi.fn(createMockWebSocket) as any
WebSocketConstructor.OPEN = MockWebSocket.OPEN
WebSocketConstructor.CONNECTING = MockWebSocket.CONNECTING
WebSocketConstructor.CLOSING = MockWebSocket.CLOSING
WebSocketConstructor.CLOSED = MockWebSocket.CLOSED

// Mock modules
vi.mock('fs', () => mockFs)
vi.mock('os', () => mockOs)
vi.mock('path', () => mockPath)
vi.mock('./client-id.js', () => mockClientId)
vi.mock('./terminal/tmux-manager.js', () => mockTmux)

// Mock undici WebSocket for Node 18-20 compatibility
vi.mock('undici', () => ({
  WebSocket: WebSocketConstructor,
}))

// Configure homedir before import so module-level constants are correct
mockOs.homedir.mockReturnValue('/home/testuser')

// Set global WebSocket to the mock constructor so platform.ts uses it directly
;(global as any).WebSocket = WebSocketConstructor

// Now import the module under test
const platformModule = await import('./platform.js')
const { PlatformConnection, getMachineIdentifier } = platformModule

describe('Platform Connection Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lastWebSocketInstance = null

    // Restore WebSocketConstructor implementation and static properties after clearAllMocks
    WebSocketConstructor.mockImplementation(createMockWebSocket)
    WebSocketConstructor.OPEN = MockWebSocket.OPEN
    WebSocketConstructor.CONNECTING = MockWebSocket.CONNECTING
    WebSocketConstructor.CLOSING = MockWebSocket.CLOSING
    WebSocketConstructor.CLOSED = MockWebSocket.CLOSED

    // Set up default mocks
    mockOs.homedir.mockReturnValue('/home/testuser')
    mockOs.hostname.mockReturnValue('test-machine')
    mockOs.type.mockReturnValue('Linux')
    mockOs.arch.mockReturnValue('x64')
    mockClientId.getClientId.mockReturnValue('test-client-id-123')
    mockTmux.isTmuxAvailable.mockReturnValue(true)

    // Mock process.version
    Object.defineProperty(process, 'version', {
      value: 'v22.0.0',
      writable: true,
      configurable: true,
    })

    // Mock console methods to reduce noise
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.restoreAllMocks()
  })

  describe('CRITICAL SECURITY: Auth Token NOT in URL', () => {
    it('should NOT include token in WebSocket URL query parameters', () => {
      const credentials = {
        token: 'secret-auth-token-12345',
        userId: 'user-123',
        email: 'test@example.com',
        clientId: 'test-client-id-123',
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

      const connection = new PlatformConnection('/test/dir', {}, 'https://api.test.com')
      connection.connect()

      expect(WebSocketConstructor).toHaveBeenCalled()
      const wsUrl = WebSocketConstructor.mock.calls[0][0]

      // CRITICAL: Token must NOT be in URL
      expect(wsUrl).not.toContain('token=')
      expect(wsUrl).not.toContain('secret-auth-token')
      expect(wsUrl).not.toContain(credentials.token)

      // URL should contain other params but NOT token
      expect(wsUrl).toContain('name=')
      expect(wsUrl).toContain('clientId=')
      expect(wsUrl).toContain('machineHostname=')
    })

    it('should send auth token as first message after connection opens', () => {
      const credentials = {
        token: 'secret-auth-token-12345',
        userId: 'user-123',
        email: 'test@example.com',
        clientId: 'test-client-id-123',
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

      const connection = new PlatformConnection('/test/dir', {}, 'https://api.test.com')
      connection.connect()

      expect(lastWebSocketInstance).toBeTruthy()

      const sentMessages: string[] = []
      lastWebSocketInstance!.on('send', (data: string) => {
        sentMessages.push(data)
      })

      // Trigger connection open
      lastWebSocketInstance!.triggerOpen()

      // First message should be auth with token
      expect(sentMessages.length).toBeGreaterThan(0)
      const firstMessage = JSON.parse(sentMessages[0])
      expect(firstMessage).toEqual({
        type: 'auth',
        token: 'secret-auth-token-12345',
      })
    })

    it('should send auth token before any other messages', () => {
      const credentials = {
        token: 'secret-token',
        userId: 'user-123',
        email: 'test@example.com',
        clientId: 'test-client-id-123',
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

      const connection = new PlatformConnection('/test/dir', {}, 'https://api.test.com')
      connection.connect()

      const sentMessages: string[] = []
      lastWebSocketInstance!.on('send', (data: string) => {
        sentMessages.push(data)
      })

      lastWebSocketInstance!.triggerOpen()

      // Send a regular message
      connection.send({ type: 'test', data: 'hello' })

      // Auth message should be first, before any other messages
      expect(sentMessages.length).toBe(2)
      expect(JSON.parse(sentMessages[0]).type).toBe('auth')
      expect(JSON.parse(sentMessages[1]).type).toBe('test')
    })
  })

  describe('getMachineIdentifier', () => {
    it('should return correct format: "hostname @ node-vX.X.X os (arch)"', () => {
      mockOs.hostname.mockReturnValue('TestMachine')
      mockOs.type.mockReturnValue('Darwin')
      mockOs.arch.mockReturnValue('arm64')

      Object.defineProperty(process, 'version', {
        value: 'v22.1.0',
        writable: true,
        configurable: true,
      })

      const identifier = getMachineIdentifier()

      expect(identifier).toBe('TestMachine @ node-v22.1.0 darwin (arm64)')
    })

    it('should include actual hostname from os.hostname()', () => {
      mockOs.hostname.mockReturnValue('Jessica')
      mockOs.type.mockReturnValue('Linux')
      mockOs.arch.mockReturnValue('x64')

      const identifier = getMachineIdentifier()

      expect(identifier).toContain('Jessica @')
      expect(mockOs.hostname).toHaveBeenCalled()
    })

    it('should include Node.js version from process.version', () => {
      mockOs.hostname.mockReturnValue('test')
      mockOs.type.mockReturnValue('Linux')
      mockOs.arch.mockReturnValue('x64')

      Object.defineProperty(process, 'version', {
        value: 'v20.5.1',
        writable: true,
        configurable: true,
      })

      const identifier = getMachineIdentifier()

      expect(identifier).toContain('node-v20.5.1')
    })

    it('should include lowercased OS type', () => {
      mockOs.hostname.mockReturnValue('test')
      mockOs.type.mockReturnValue('DARWIN')
      mockOs.arch.mockReturnValue('x64')

      const identifier = getMachineIdentifier()

      expect(identifier).toContain('darwin')
      expect(identifier).not.toContain('DARWIN')
    })

    it('should include CPU architecture', () => {
      mockOs.hostname.mockReturnValue('test')
      mockOs.type.mockReturnValue('Linux')
      mockOs.arch.mockReturnValue('arm64')

      const identifier = getMachineIdentifier()

      expect(identifier).toContain('(arm64)')
    })
  })

  describe('Connection Lifecycle', () => {
    describe('connect()', () => {
      it('should read credentials from disk', () => {
        const credentials = {
          token: 'test-token',
          userId: 'user-123',
          email: 'test@example.com',
          clientId: 'client-123',
        }

        mockFs.existsSync.mockReturnValue(true)
        mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

        const connection = new PlatformConnection('/test/dir')
        connection.connect()

        expect(mockFs.existsSync).toHaveBeenCalledWith('/home/testuser/.mstro/credentials.json')
        expect(mockFs.readFileSync).toHaveBeenCalledWith(
          '/home/testuser/.mstro/credentials.json',
          'utf-8'
        )
      })

      it('should show error when credentials file does not exist', () => {
        mockFs.existsSync.mockReturnValue(false)

        const onError = vi.fn()
        const connection = new PlatformConnection('/test/dir', { onError })
        connection.connect()

        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Not logged in')
        )
        expect(onError).toHaveBeenCalledWith('Not logged in - run `mstro login` first')
        expect(WebSocketConstructor).not.toHaveBeenCalled()
      })

      it('should show error when credentials are invalid', () => {
        mockFs.existsSync.mockReturnValue(true)
        mockFs.readFileSync.mockReturnValue(JSON.stringify({ userId: 'user-123' })) // Missing token

        const onError = vi.fn()
        const connection = new PlatformConnection('/test/dir', { onError })
        connection.connect()

        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Not logged in')
        )
        expect(onError).toHaveBeenCalledWith('Not logged in - run `mstro login` first')
      })

      it('should include working directory name in connection params', () => {
        mockFs.existsSync.mockReturnValue(true)
        mockFs.readFileSync.mockReturnValue(
          JSON.stringify({
            token: 'test-token',
            userId: 'user-123',
            email: 'test@example.com',
            clientId: 'client-123',
          })
        )

        const connection = new PlatformConnection('/home/user/my-project')
        connection.connect()

        const wsUrl = WebSocketConstructor.mock.calls[0][0]
        expect(wsUrl).toContain('name=my-project')
        expect(wsUrl).toContain('workingDirectory=%2Fhome%2Fuser%2Fmy-project')
      })

      it('should include machine capabilities in connection params', () => {
        mockFs.existsSync.mockReturnValue(true)
        mockFs.readFileSync.mockReturnValue(
          JSON.stringify({
            token: 'test-token',
            userId: 'user-123',
            email: 'test@example.com',
            clientId: 'client-123',
          })
        )

        mockTmux.isTmuxAvailable.mockReturnValue(true)

        const connection = new PlatformConnection('/test/dir')
        connection.connect()

        const wsUrl = WebSocketConstructor.mock.calls[0][0]
        expect(wsUrl).toContain('capabilities=')
        expect(wsUrl).toContain('tmux')
      })

      it('should use custom platform URL when provided', () => {
        mockFs.existsSync.mockReturnValue(true)
        mockFs.readFileSync.mockReturnValue(
          JSON.stringify({
            token: 'test-token',
            userId: 'user-123',
            email: 'test@example.com',
            clientId: 'client-123',
          })
        )

        const connection = new PlatformConnection(
          '/test/dir',
          {},
          'https://custom.platform.com'
        )
        connection.connect()

        const wsUrl = WebSocketConstructor.mock.calls[0][0]
        expect(wsUrl).toContain('wss://custom.platform.com')
      })
    })

    describe('reconnection behavior', () => {
      beforeEach(() => {
        vi.useFakeTimers()
      })

      afterEach(() => {
        vi.useRealTimers()
      })

      it('should schedule reconnect on connection failure', () => {
        const credentials = {
          token: 'test-token',
          userId: 'user-123',
          email: 'test@example.com',
          clientId: 'client-123',
        }

        mockFs.existsSync.mockReturnValue(true)
        mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

        const connection = new PlatformConnection('/test/dir')
        connection.connect()

        lastWebSocketInstance!.triggerOpen()
        lastWebSocketInstance!.triggerMessage({ type: 'paired', connectionId: 'conn-123' })

        // Clear initial call
        WebSocketConstructor.mockClear()

        // Simulate unexpected disconnection
        lastWebSocketInstance!.triggerClose(1006, '')

        // Should schedule reconnect
        expect(WebSocketConstructor).not.toHaveBeenCalled()

        // Advance timers to trigger reconnect
        vi.advanceTimersByTime(1000)

        expect(WebSocketConstructor).toHaveBeenCalled()
      })

      it('should use exponential backoff for reconnection delays', () => {
        const credentials = {
          token: 'test-token',
          userId: 'user-123',
          email: 'test@example.com',
          clientId: 'client-123',
        }

        mockFs.existsSync.mockReturnValue(true)
        mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

        const connection = new PlatformConnection('/test/dir')
        connection.connect()

        lastWebSocketInstance!.triggerOpen()
        lastWebSocketInstance!.triggerMessage({ type: 'paired', connectionId: 'conn-123' })
        WebSocketConstructor.mockClear()

        // First reconnect attempt - delay should be 1000ms (2^0 * 1000)
        // Use code 1001 (going away) to avoid auth failure detection on 1006
        lastWebSocketInstance!.triggerClose(1001, '')
        expect(WebSocketConstructor).not.toHaveBeenCalled()
        vi.advanceTimersByTime(999)
        expect(WebSocketConstructor).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(WebSocketConstructor).toHaveBeenCalledTimes(1)

        // Don't triggerOpen to avoid resetting reconnectAttempts in onopen
        // Close immediately to trigger second backoff
        WebSocketConstructor.mockClear()
        lastWebSocketInstance!.triggerClose(1001, '')

        // Second reconnect attempt - delay should be 2000ms (2^1 * 1000)
        vi.advanceTimersByTime(1999)
        expect(WebSocketConstructor).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(WebSocketConstructor).toHaveBeenCalledTimes(1)
      })

      it('should stop reconnecting after max attempts', () => {
        const credentials = {
          token: 'test-token',
          userId: 'user-123',
          email: 'test@example.com',
          clientId: 'client-123',
        }

        mockFs.existsSync.mockReturnValue(true)
        mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

        const connection = new PlatformConnection('/test/dir')
        connection.connect()

        // Trigger 10 failed connection attempts
        // Don't triggerOpen to avoid resetting reconnectAttempts
        // Use code 1001 to avoid auth failure detection
        for (let i = 0; i < 10; i++) {
          if (lastWebSocketInstance) {
            lastWebSocketInstance.triggerClose(1001, '')
          }
          vi.advanceTimersByTime(60000)
        }

        WebSocketConstructor.mockClear()

        // 11th attempt should not happen
        vi.advanceTimersByTime(60000)
        expect(WebSocketConstructor).not.toHaveBeenCalled()
        expect(console.log).toHaveBeenCalledWith(
          expect.stringContaining('Max reconnection attempts reached')
        )
      })

      it('should reset reconnect attempts on successful connection', () => {
        const credentials = {
          token: 'test-token',
          userId: 'user-123',
          email: 'test@example.com',
          clientId: 'client-123',
        }

        mockFs.existsSync.mockReturnValue(true)
        mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

        const connection = new PlatformConnection('/test/dir')
        connection.connect()

        // First connection succeeds
        lastWebSocketInstance!.triggerOpen()
        lastWebSocketInstance!.triggerMessage({ type: 'paired', connectionId: 'conn-1' })
        WebSocketConstructor.mockClear()

        // Disconnect and reconnect
        lastWebSocketInstance!.triggerClose(1006, '')
        vi.advanceTimersByTime(1000)

        // Second connection succeeds - this should reset the counter
        lastWebSocketInstance!.triggerOpen()
        lastWebSocketInstance!.triggerMessage({ type: 'paired', connectionId: 'conn-2' })
        WebSocketConstructor.mockClear()

        // Next disconnect should use first-attempt delay again (1000ms)
        lastWebSocketInstance!.triggerClose(1006, '')
        vi.advanceTimersByTime(999)
        expect(WebSocketConstructor).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(WebSocketConstructor).toHaveBeenCalled()
      })

      it('should not reconnect on authentication failure', () => {
        const credentials = {
          token: 'test-token',
          userId: 'user-123',
          email: 'test@example.com',
          clientId: 'client-123',
        }

        mockFs.existsSync.mockReturnValue(true)
        mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

        const onError = vi.fn()
        const connection = new PlatformConnection('/test/dir', { onError })
        connection.connect()

        WebSocketConstructor.mockClear()

        // Auth failure (code 4001)
        lastWebSocketInstance!.triggerClose(4001, 'Unauthorized')

        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Authentication failed')
        )
        expect(onError).toHaveBeenCalledWith(
          'Authentication failed - run `mstro login --force`'
        )

        // Should not schedule reconnect
        vi.advanceTimersByTime(10000)
        expect(WebSocketConstructor).not.toHaveBeenCalled()
      })
    })

    describe('disconnect()', () => {
      beforeEach(() => {
        vi.useFakeTimers()
      })

      afterEach(() => {
        vi.useRealTimers()
      })

      it('should close WebSocket connection cleanly', () => {
        const credentials = {
          token: 'test-token',
          userId: 'user-123',
          email: 'test@example.com',
          clientId: 'client-123',
        }

        mockFs.existsSync.mockReturnValue(true)
        mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

        const connection = new PlatformConnection('/test/dir')
        connection.connect()

        lastWebSocketInstance!.triggerOpen()

        const closeSpy = vi.spyOn(lastWebSocketInstance!, 'close')
        connection.disconnect()

        expect(closeSpy).toHaveBeenCalled()
      })

      it('should not trigger reconnection after intentional disconnect', () => {
        const credentials = {
          token: 'test-token',
          userId: 'user-123',
          email: 'test@example.com',
          clientId: 'client-123',
        }

        mockFs.existsSync.mockReturnValue(true)
        mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

        const connection = new PlatformConnection('/test/dir')
        connection.connect()

        lastWebSocketInstance!.triggerOpen()
        WebSocketConstructor.mockClear()

        connection.disconnect()

        // Advance timers - should not reconnect
        vi.advanceTimersByTime(10000)
        expect(WebSocketConstructor).not.toHaveBeenCalled()
      })

      it('should clear reconnect timeout on disconnect', () => {
        const credentials = {
          token: 'test-token',
          userId: 'user-123',
          email: 'test@example.com',
          clientId: 'client-123',
        }

        mockFs.existsSync.mockReturnValue(true)
        mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

        const connection = new PlatformConnection('/test/dir')
        connection.connect()

        lastWebSocketInstance!.triggerOpen()

        // Trigger disconnection to schedule reconnect
        lastWebSocketInstance!.triggerClose(1006, '')

        // Now disconnect intentionally
        connection.disconnect()

        WebSocketConstructor.mockClear()

        // Advance timers - reconnect should be cancelled
        vi.advanceTimersByTime(60000)
        expect(WebSocketConstructor).not.toHaveBeenCalled()
      })

      it('should stop heartbeat on disconnect', () => {
        const credentials = {
          token: 'test-token',
          userId: 'user-123',
          email: 'test@example.com',
          clientId: 'client-123',
        }

        mockFs.existsSync.mockReturnValue(true)
        mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

        const connection = new PlatformConnection('/test/dir')
        connection.connect()

        lastWebSocketInstance!.triggerOpen()
        lastWebSocketInstance!.triggerMessage({ type: 'paired', connectionId: 'conn-123' })

        const sentMessages: string[] = []
        lastWebSocketInstance!.on('send', (data: string) => {
          sentMessages.push(data)
        })

        // Clear auth message
        sentMessages.length = 0

        // Advance time to trigger heartbeat
        vi.advanceTimersByTime(2 * 60 * 1000)
        expect(sentMessages.some((msg) => JSON.parse(msg).type === 'ping')).toBe(true)

        sentMessages.length = 0

        // Disconnect
        connection.disconnect()

        // Advance time - no more heartbeats
        vi.advanceTimersByTime(10 * 60 * 1000)
        expect(sentMessages.length).toBe(0)
      })
    })
  })

  describe('Message Handling', () => {
    beforeEach(() => {
      vi.useFakeTimers()

      const credentials = {
        token: 'test-token',
        userId: 'user-123',
        email: 'test@example.com',
        clientId: 'client-123',
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('should trigger onConnected callback on "paired" message', () => {
      const onConnected = vi.fn()
      const connection = new PlatformConnection('/test/dir', { onConnected })
      connection.connect()

      lastWebSocketInstance!.triggerOpen()
      lastWebSocketInstance!.triggerMessage({ type: 'paired', connectionId: 'conn-456' })

      expect(onConnected).toHaveBeenCalledWith('conn-456')
    })

    it('should start heartbeat after "paired" message', () => {
      const connection = new PlatformConnection('/test/dir')
      connection.connect()

      lastWebSocketInstance!.triggerOpen()

      const sentMessages: string[] = []
      lastWebSocketInstance!.on('send', (data: string) => {
        sentMessages.push(data)
      })

      // Clear auth message
      sentMessages.length = 0

      lastWebSocketInstance!.triggerMessage({ type: 'paired', connectionId: 'conn-123' })

      // No heartbeat yet
      expect(sentMessages.length).toBe(0)

      // Advance time to heartbeat interval (2 minutes)
      vi.advanceTimersByTime(2 * 60 * 1000)

      // Should have sent ping
      expect(sentMessages.length).toBe(1)
      expect(JSON.parse(sentMessages[0])).toEqual({ type: 'ping' })
    })

    it('should send heartbeat every 2 minutes', () => {
      const connection = new PlatformConnection('/test/dir')
      connection.connect()

      lastWebSocketInstance!.triggerOpen()

      const sentMessages: string[] = []
      lastWebSocketInstance!.on('send', (data: string) => {
        sentMessages.push(data)
      })

      lastWebSocketInstance!.triggerMessage({ type: 'paired', connectionId: 'conn-123' })

      // Clear auth message
      sentMessages.length = 0

      // First ping at 2 minutes
      vi.advanceTimersByTime(2 * 60 * 1000)
      expect(sentMessages.length).toBe(1)

      // Second ping at 4 minutes
      vi.advanceTimersByTime(2 * 60 * 1000)
      expect(sentMessages.length).toBe(2)

      // Third ping at 6 minutes
      vi.advanceTimersByTime(2 * 60 * 1000)
      expect(sentMessages.length).toBe(3)

      sentMessages.forEach((msg) => {
        expect(JSON.parse(msg)).toEqual({ type: 'ping' })
      })
    })

    it('should trigger onWebConnected callback on "web_connected" message', () => {
      const onWebConnected = vi.fn()
      const connection = new PlatformConnection('/test/dir', { onWebConnected })
      connection.connect()

      lastWebSocketInstance!.triggerOpen()
      lastWebSocketInstance!.triggerMessage({ type: 'web_connected' })

      expect(onWebConnected).toHaveBeenCalled()
    })

    it('should trigger onWebDisconnected callback on "web_disconnected" message', () => {
      const onWebDisconnected = vi.fn()
      const connection = new PlatformConnection('/test/dir', { onWebDisconnected })
      connection.connect()

      lastWebSocketInstance!.triggerOpen()
      lastWebSocketInstance!.triggerMessage({ type: 'web_disconnected' })

      expect(onWebDisconnected).toHaveBeenCalled()
    })

    it('should pass unknown messages to onRelayedMessage callback', () => {
      const onRelayedMessage = vi.fn()
      const connection = new PlatformConnection('/test/dir', { onRelayedMessage })
      connection.connect()

      lastWebSocketInstance!.triggerOpen()

      const customMessage = {
        type: 'custom_event',
        data: { foo: 'bar' },
      }

      lastWebSocketInstance!.triggerMessage(customMessage)

      expect(onRelayedMessage).toHaveBeenCalledWith(customMessage)
    })

    it('should relay "execute" messages to onRelayedMessage', () => {
      const onRelayedMessage = vi.fn()
      const connection = new PlatformConnection('/test/dir', { onRelayedMessage })
      connection.connect()

      lastWebSocketInstance!.triggerOpen()

      const executeMessage = {
        type: 'execute',
        command: 'ls -la',
        terminalId: 'term-1',
      }

      lastWebSocketInstance!.triggerMessage(executeMessage)

      expect(onRelayedMessage).toHaveBeenCalledWith(executeMessage)
    })

    it('should handle "pong" messages silently', () => {
      const onRelayedMessage = vi.fn()
      const connection = new PlatformConnection('/test/dir', { onRelayedMessage })
      connection.connect()

      lastWebSocketInstance!.triggerOpen()
      lastWebSocketInstance!.triggerMessage({ type: 'pong' })

      // Should not trigger any callback
      expect(onRelayedMessage).not.toHaveBeenCalled()
    })

    it('should handle malformed JSON messages gracefully', () => {
      const onRelayedMessage = vi.fn()
      const connection = new PlatformConnection('/test/dir', { onRelayedMessage })
      connection.connect()

      lastWebSocketInstance!.triggerOpen()

      // Manually trigger with invalid JSON
      if (lastWebSocketInstance!.onmessage) {
        lastWebSocketInstance!.onmessage({ data: 'invalid json {' } as any)
      }

      expect(console.error).toHaveBeenCalledWith(
        'Failed to parse platform message:',
        expect.any(Error)
      )
      expect(onRelayedMessage).not.toHaveBeenCalled()
    })
  })

  describe('Token Refresh', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('should check if token should be refreshed on connect', async () => {
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) // 31 days ago
      const credentials = {
        token: 'test-token',
        userId: 'user-123',
        email: 'test@example.com',
        clientId: 'client-123',
        lastRefreshedAt: oldDate.toISOString(),
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

      const mockFetch = global.fetch as any
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ accessToken: 'new-token-123' }),
      })

      const connection = new PlatformConnection('/test/dir', {}, 'https://api.test.com')
      connection.connect()

      lastWebSocketInstance!.triggerOpen()

      // Wait for async refresh to complete
      await vi.advanceTimersByTimeAsync(1)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.test.com/api/auth/device/refresh',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      )
    })

    it('should refresh token when lastRefreshedAt is older than 30 days', async () => {
      const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000) // 35 days ago
      const credentials = {
        token: 'old-token',
        userId: 'user-123',
        email: 'test@example.com',
        clientId: 'client-123',
        lastRefreshedAt: oldDate.toISOString(),
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

      const mockFetch = global.fetch as any
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ accessToken: 'refreshed-token-456' }),
      })

      const connection = new PlatformConnection('/test/dir', {}, 'https://api.test.com')
      connection.connect()

      lastWebSocketInstance!.triggerOpen()

      await vi.advanceTimersByTimeAsync(1)

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/home/testuser/.mstro/credentials.json',
        expect.stringContaining('refreshed-token-456'),
        expect.objectContaining({ mode: 0o600 })
      )

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/home/testuser/.mstro/credentials.json',
        expect.stringContaining('lastRefreshedAt'),
        expect.anything()
      )
    })

    it('should NOT refresh token when lastRefreshedAt is recent', async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) // 5 days ago
      const credentials = {
        token: 'recent-token',
        userId: 'user-123',
        email: 'test@example.com',
        clientId: 'client-123',
        lastRefreshedAt: recentDate.toISOString(),
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

      const connection = new PlatformConnection('/test/dir', {}, 'https://api.test.com')
      connection.connect()

      lastWebSocketInstance!.triggerOpen()

      await vi.advanceTimersByTimeAsync(1)

      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('should refresh token when lastRefreshedAt is missing', async () => {
      const credentials = {
        token: 'unrefreshed-token',
        userId: 'user-123',
        email: 'test@example.com',
        clientId: 'client-123',
        // No lastRefreshedAt field
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

      const mockFetch = global.fetch as any
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ accessToken: 'first-refresh-token' }),
      })

      const connection = new PlatformConnection('/test/dir', {}, 'https://api.test.com')
      connection.connect()

      lastWebSocketInstance!.triggerOpen()

      await vi.advanceTimersByTimeAsync(1)

      expect(global.fetch).toHaveBeenCalled()
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/home/testuser/.mstro/credentials.json',
        expect.stringContaining('first-refresh-token'),
        expect.anything()
      )
    })

    it('should handle token refresh failure gracefully', async () => {
      const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000)
      const credentials = {
        token: 'test-token',
        userId: 'user-123',
        email: 'test@example.com',
        clientId: 'client-123',
        lastRefreshedAt: oldDate.toISOString(),
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

      const mockFetch = global.fetch as any
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
      })

      const connection = new PlatformConnection('/test/dir', {}, 'https://api.test.com')
      connection.connect()

      lastWebSocketInstance!.triggerOpen()

      await vi.advanceTimersByTimeAsync(1)

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Token refresh failed')
      )

      // Should not update credentials on failure
      expect(mockFs.writeFileSync).not.toHaveBeenCalled()
    })

    it('should handle token refresh network error gracefully', async () => {
      const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000)
      const credentials = {
        token: 'test-token',
        userId: 'user-123',
        email: 'test@example.com',
        clientId: 'client-123',
        lastRefreshedAt: oldDate.toISOString(),
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

      const mockFetch = global.fetch as any
      mockFetch.mockRejectedValue(new Error('Network error'))

      const connection = new PlatformConnection('/test/dir', {}, 'https://api.test.com')
      connection.connect()

      lastWebSocketInstance!.triggerOpen()

      await vi.advanceTimersByTimeAsync(1)

      expect(console.warn).toHaveBeenCalledWith(
        '[Platform] Token refresh error:',
        expect.any(Error)
      )
    })

    it('should periodically check for token refresh every 24 hours', async () => {
      const credentials = {
        token: 'test-token',
        userId: 'user-123',
        email: 'test@example.com',
        clientId: 'client-123',
        lastRefreshedAt: new Date().toISOString(),
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))

      const connection = new PlatformConnection('/test/dir', {}, 'https://api.test.com')
      connection.connect()

      lastWebSocketInstance!.triggerOpen()

      const mockFetch = global.fetch as any
      mockFetch.mockClear()

      // Advance 23 hours - should not refresh
      vi.advanceTimersByTime(23 * 60 * 60 * 1000)
      await vi.advanceTimersByTimeAsync(1)
      expect(global.fetch).not.toHaveBeenCalled()

      // Advance 1 more hour - should trigger check
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          ...credentials,
          lastRefreshedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        })
      )

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ accessToken: 'periodic-refresh-token' }),
      })

      vi.advanceTimersByTime(1 * 60 * 60 * 1000)
      await vi.advanceTimersByTimeAsync(1)

      expect(global.fetch).toHaveBeenCalled()
    })
  })

  describe('Additional Connection Methods', () => {
    beforeEach(() => {
      const credentials = {
        token: 'test-token',
        userId: 'user-123',
        email: 'test@example.com',
        clientId: 'client-123',
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))
    })

    it('send() should send JSON message through WebSocket', () => {
      const connection = new PlatformConnection('/test/dir')
      connection.connect()

      lastWebSocketInstance!.triggerOpen()

      const sentMessages: string[] = []
      lastWebSocketInstance!.on('send', (data: string) => {
        sentMessages.push(data)
      })

      connection.send({ type: 'test', data: 'hello' })

      expect(sentMessages[sentMessages.length - 1]).toBe(
        JSON.stringify({ type: 'test', data: 'hello' })
      )
    })

    it('send() should not send if WebSocket is not open', () => {
      const connection = new PlatformConnection('/test/dir')
      connection.connect()

      // Don't trigger open
      const sentMessages: string[] = []
      lastWebSocketInstance!.on('send', (data: string) => {
        sentMessages.push(data)
      })

      connection.send({ type: 'test', data: 'hello' })

      // Should only have auth message from onopen, not our test message
      expect(sentMessages.length).toBe(0)
    })

    it('isConnectedToPlatform() should return true when connected and paired', () => {
      const connection = new PlatformConnection('/test/dir')
      connection.connect()

      expect(connection.isConnectedToPlatform()).toBe(false)

      lastWebSocketInstance!.triggerOpen()
      expect(connection.isConnectedToPlatform()).toBe(false)

      lastWebSocketInstance!.triggerMessage({ type: 'paired', connectionId: 'conn-123' })
      expect(connection.isConnectedToPlatform()).toBe(true)
    })

    it('isConnectedToPlatform() should return false after disconnection', () => {
      const connection = new PlatformConnection('/test/dir')
      connection.connect()

      lastWebSocketInstance!.triggerOpen()
      lastWebSocketInstance!.triggerMessage({ type: 'paired', connectionId: 'conn-123' })

      expect(connection.isConnectedToPlatform()).toBe(true)

      connection.disconnect()

      expect(connection.isConnectedToPlatform()).toBe(false)
    })
  })

  describe('Connection Timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers()

      const credentials = {
        token: 'test-token',
        userId: 'user-123',
        email: 'test@example.com',
        clientId: 'client-123',
      }

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(credentials))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('should show timeout error if connection takes longer than 10 seconds', () => {
      const onError = vi.fn()
      const connection = new PlatformConnection('/test/dir', { onError })
      connection.connect()

      // Don't trigger open - simulate hanging connection
      const closeSpy = vi.spyOn(lastWebSocketInstance!, 'close')

      // Advance time by 10 seconds
      vi.advanceTimersByTime(10000)

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Connection timeout')
      )
      expect(onError).toHaveBeenCalledWith(
        'Connection timeout - run `mstro login --force`'
      )
      expect(closeSpy).toHaveBeenCalled()
    })

    it('should not timeout if connection opens within 10 seconds', () => {
      const onError = vi.fn()
      const connection = new PlatformConnection('/test/dir', { onError })
      connection.connect()

      // Trigger open before timeout
      vi.advanceTimersByTime(5000)
      lastWebSocketInstance!.triggerOpen()

      // Advance past timeout threshold
      vi.advanceTimersByTime(6000)

      expect(onError).not.toHaveBeenCalledWith(
        expect.stringContaining('Connection timeout')
      )
    })
  })
})
