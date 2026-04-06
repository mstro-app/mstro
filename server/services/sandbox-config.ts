// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Sandbox Configuration
 *
 * Uses Anthropic's sandbox-runtime for OS-level isolation of sandboxed
 * Claude Code sessions. Cross-platform: bubblewrap on Linux, sandbox-exec on macOS.
 *
 * Filesystem model:
 *  - System dirs: read-only
 *  - Project directory: read-write
 *  - Home directory credentials: denied (SSH keys, API tokens, etc.)
 *  - Network: allows localhost (for auth proxy) and Anthropic API
 *
 * The auth proxy (auth-proxy.ts) handles credential injection separately —
 * sandbox-runtime handles OS-level isolation, auth proxy handles API auth.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── Credential Reading ───────────────────────────────────────

export interface ApiCredential {
  type: 'api-key' | 'oauth'
  value: string
}

/**
 * Read the machine owner's Anthropic API credential.
 * Tries (in order):
 *   1. ANTHROPIC_API_KEY env var (explicit API key)
 *   2. ~/.claude/.credentials.json (OAuth access token from Claude Code login)
 *
 * Returns null if no credential is available.
 * Reads from disk on every call to pick up token refreshes.
 */
/** Cached credential with TTL to avoid reading disk on every request */
let _cachedCredential: { value: ApiCredential | null; timestamp: number } | null = null
const CREDENTIAL_CACHE_TTL_MS = 5_000

export function readOwnerApiCredential(): ApiCredential | null {
  // Return cached value if fresh
  if (_cachedCredential && Date.now() - _cachedCredential.timestamp < CREDENTIAL_CACHE_TTL_MS) {
    return _cachedCredential.value
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey) {
    const result: ApiCredential = { type: 'api-key', value: apiKey }
    _cachedCredential = { value: result, timestamp: Date.now() }
    return result
  }

  const credPath = join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    '.credentials.json',
  )
  try {
    if (!existsSync(credPath)) {
      _cachedCredential = { value: null, timestamp: Date.now() }
      return null
    }
    const raw = readFileSync(credPath, 'utf-8')
    const data = JSON.parse(raw) as {
      claudeAiOauth?: {
        accessToken?: string
        expiresAt?: number
      }
    }
    const oauth = data.claudeAiOauth
    if (!oauth?.accessToken) {
      _cachedCredential = { value: null, timestamp: Date.now() }
      return null
    }

    // Reject tokens that expire within the next 60 seconds (safety buffer)
    if (oauth.expiresAt && oauth.expiresAt < Date.now() + 60_000) {
      _cachedCredential = { value: null, timestamp: Date.now() }
      return null
    }

    const result: ApiCredential = { type: 'oauth', value: oauth.accessToken }
    _cachedCredential = { value: result, timestamp: Date.now() }
    return result
  } catch (e) {
    console.warn('Failed to parse API credentials:', e)
    _cachedCredential = { value: null, timestamp: Date.now() }
    return null
  }
}

// ── Sandbox Runtime Integration ─────────────────────────────

// Cached module reference — loaded once via async import, reused by sync functions.
let _sandboxModule: typeof import('@anthropic-ai/sandbox-runtime') | null = null
let _sandboxAvailable: boolean | null = null
let _sandboxUnavailableReason: string | null = null
// Track which project directories have been initialized (idempotency guard)
const _initializedDirs = new Set<string>()

/** Load sandbox-runtime module once and cache it. */
async function getSandboxModule(): Promise<typeof import('@anthropic-ai/sandbox-runtime')> {
  if (!_sandboxModule) {
    _sandboxModule = await import('@anthropic-ai/sandbox-runtime')
  }
  return _sandboxModule
}

/**
 * Check if sandbox-runtime is available on this platform.
 * Cross-platform: works on Linux (bwrap) and macOS (sandbox-exec).
 * Caches the result after first check.
 *
 * NOTE: This is synchronous for use in capability reporting. It relies on
 * the module already being cached from a prior async import, or triggers
 * a synchronous check via the cached reference.
 */
export function isSandboxAvailable(): boolean {
  if (_sandboxAvailable !== null) return _sandboxAvailable

  // If the module hasn't been loaded yet, try a synchronous probe.
  // In ESM this will only work if the module was previously imported.
  if (!_sandboxModule) {
    try {
      // Trigger a background load for future calls
      void getSandboxModule()
    } catch {
      // ignore
    }
    // Cannot determine synchronously on first call — return false but don't cache.
    // The async prober (probeSandboxAvailability) will set the real value at startup.
    return false
  }

  return _checkAvailability(_sandboxModule)
}

/**
 * Async probe for sandbox availability. Call once at startup so the
 * synchronous isSandboxAvailable() has a cached result.
 */
export async function probeSandboxAvailability(): Promise<boolean> {
  if (_sandboxAvailable !== null) return _sandboxAvailable
  try {
    const mod = await getSandboxModule()
    return _checkAvailability(mod)
  } catch (e) {
    console.warn('Sandbox availability probe failed:', e)
    _sandboxAvailable = false
    _sandboxUnavailableReason = 'sandbox-runtime not available'
    return false
  }
}

function _checkAvailability(mod: typeof import('@anthropic-ai/sandbox-runtime')): boolean {
  if (!mod.SandboxManager.isSupportedPlatform()) {
    _sandboxAvailable = false
    _sandboxUnavailableReason = 'Platform not supported (sandbox-runtime requires Linux or macOS)'
    return false
  }

  const deps = mod.SandboxManager.checkDependencies()
  if (deps.errors.length > 0) {
    _sandboxAvailable = false
    _sandboxUnavailableReason = `Missing dependencies: ${deps.errors.join(', ')}`
    return false
  }

  _sandboxAvailable = true
  _sandboxUnavailableReason = null
  return true
}

/**
 * Get a human-readable reason why the sandbox is not available.
 * Returns null if the sandbox IS available.
 */
export function getSandboxUnavailableReason(): string | null {
  if (_sandboxAvailable === null) isSandboxAvailable()
  return _sandboxUnavailableReason
}

/**
 * Initialize the sandbox-runtime SandboxManager for a project directory.
 * Idempotent — skips re-initialization if the same directory was already set up.
 *
 * Configures:
 *  - Filesystem: project dir is writable, credentials are denied
 *  - Network: localhost allowed (for auth proxy), API domains allowed
 */
export async function initializeSandbox(projectDir: string): Promise<void> {
  if (_initializedDirs.has(projectDir)) return

  const mod = await getSandboxModule()
  const home = homedir()

  await mod.SandboxManager.initialize({
    network: {
      allowedDomains: [
        'api.anthropic.com',
        '*.anthropic.com',
        '*.sentry.io',
      ],
      deniedDomains: [],
      allowLocalBinding: true,
    },
    filesystem: {
      allowWrite: [projectDir],
      denyWrite: [
        '/etc',
        '/usr',
        '/var',
      ],
      denyRead: [
        join(home, '.ssh'),
        join(home, '.aws'),
        join(home, '.gnupg'),
        join(home, '.claude', '.credentials.json'),
        join(home, '.mstro', 'credentials.json'),
        '/etc/shadow',
        '/etc/gshadow',
      ],
      allowGitConfig: true,
    },
    allowPty: true,
  })

  _initializedDirs.add(projectDir)
}

/**
 * Wrap a command string for sandboxed execution via sandbox-runtime.
 * Returns the wrapped command that should be passed to execSync/spawn.
 *
 * The sandbox-runtime handles the platform-specific wrapping:
 *  - Linux: bubblewrap (bwrap) with namespace isolation
 *  - macOS: sandbox-exec with Seatbelt profile
 */
export async function wrapCommandForSandbox(command: string): Promise<string> {
  const mod = await getSandboxModule()
  return mod.SandboxManager.wrapWithSandbox(command)
}

/**
 * Clean up sandbox state after a command completes.
 */
export async function cleanupSandboxCommand(): Promise<void> {
  try {
    const mod = await getSandboxModule()
    mod.SandboxManager.cleanupAfterCommand()
  } catch {
    // Ignore — sandbox may not be initialized
  }
}

/**
 * Reset the sandbox-runtime (full cleanup). Call on shutdown.
 * Clears the initialization tracking so re-init is possible after restart.
 */
export async function resetSandbox(): Promise<void> {
  try {
    const mod = await getSandboxModule()
    await mod.SandboxManager.reset()
  } catch {
    // Ignore — sandbox may not be initialized
  }
  _initializedDirs.clear()
}
