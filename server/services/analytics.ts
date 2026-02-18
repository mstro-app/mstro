// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * PostHog Analytics Service for mstro CLI
 *
 * Provides analytics tracking for the mstro client.
 * Uses PostHog Node SDK for server-side event tracking.
 *
 * Config is fetched from platform server (not hardcoded) so the
 * PostHog key isn't exposed in the npm package.
 *
 * Telemetry is opt-out by default. Users can disable with:
 * - Command: mstro telemetry off
 * - Environment variable: MSTRO_TELEMETRY=0
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, homedir, platform } from 'node:os'
import { join } from 'node:path'
import { PostHog } from 'posthog-node'
import { getClientId } from './client-id.js'

const MSTRO_DIR = join(homedir(), '.mstro')
const CONFIG_FILE = join(MSTRO_DIR, 'config.json')
const PLATFORM_URL = process.env.PLATFORM_URL || 'https://api.mstro.app'

let client: PostHog | null = null
let telemetryEnabled: boolean | null = null
let analyticsConfig: { posthogKey: string; posthogHost: string } | null = null

interface MstroConfig {
  telemetry?: boolean
}

/**
 * Check if telemetry is enabled
 */
function isTelemetryEnabled(): boolean {
  if (telemetryEnabled !== null) {
    return telemetryEnabled
  }

  // Check environment variable first
  const envValue = process.env.MSTRO_TELEMETRY
  if (envValue === '0' || envValue === 'false') {
    telemetryEnabled = false
    return false
  }

  // Check config file
  if (existsSync(CONFIG_FILE)) {
    try {
      const config: MstroConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
      if (config.telemetry === false) {
        telemetryEnabled = false
        return false
      }
    } catch {
      // Ignore parse errors
    }
  }

  telemetryEnabled = true
  return true
}

/**
 * Fetch analytics config from platform server
 * This keeps the PostHog key out of the npm package
 */
async function fetchAnalyticsConfig(): Promise<{ posthogKey: string; posthogHost: string } | null> {
  try {
    const response = await fetch(`${PLATFORM_URL}/api/config/client`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })

    if (!response.ok) {
      return null
    }

    const data = await response.json() as { analytics?: { posthogKey?: string; posthogHost?: string } }
    return {
      posthogKey: data.analytics?.posthogKey || '',
      posthogHost: data.analytics?.posthogHost || 'https://eu.i.posthog.com',
    }
  } catch {
    // Network error, platform unavailable - silently disable analytics
    return null
  }
}

/**
 * Initialize PostHog client
 * Call this once at server startup
 */
export async function initAnalytics(): Promise<void> {
  if (!isTelemetryEnabled()) {
    return
  }

  // Fetch config from platform
  analyticsConfig = await fetchAnalyticsConfig()

  if (!analyticsConfig?.posthogKey) {
    // No key configured on platform, analytics disabled
    return
  }

  client = new PostHog(analyticsConfig.posthogKey, {
    host: analyticsConfig.posthogHost,
    // Flush events every 10 seconds or 20 events
    flushAt: 20,
    flushInterval: 10000,
  })
}

/**
 * Shutdown PostHog client gracefully
 * Call this before process exit
 */
export async function shutdownAnalytics(): Promise<void> {
  if (client) {
    await client.shutdown()
    client = null
  }
}

/**
 * Get the distinct ID for this client
 * Uses the persistent client ID from ~/.mstro/client-id
 */
function getDistinctId(): string {
  return getClientId()
}

/**
 * Get common properties included with all events
 */
function getCommonProperties(): Record<string, any> {
  return {
    os: platform(),
    arch: arch(),
    node_version: process.version,
    mstro_version: process.env.npm_package_version || 'unknown',
    source: 'client',
  }
}

/**
 * Track a custom event
 */
export function trackEvent(event: string, properties?: Record<string, any>): void {
  if (!client || !isTelemetryEnabled()) return

  client.capture({
    distinctId: getDistinctId(),
    event,
    properties: {
      ...getCommonProperties(),
      ...properties,
    },
  })
}

/**
 * Identify a user (call after login)
 */
export function identifyUser(userId: string, properties?: Record<string, any>): void {
  if (!client || !isTelemetryEnabled()) return

  // Link the client ID to the user ID
  client.alias({
    distinctId: userId,
    alias: getDistinctId(),
  })

  client.identify({
    distinctId: userId,
    properties: {
      ...getCommonProperties(),
      ...properties,
    },
  })
}

/**
 * Set telemetry preference in config file
 */
export function setTelemetryEnabled(enabled: boolean): void {
  let config: MstroConfig = {}

  if (existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
    } catch {
      // Start fresh if parse fails
    }
  }

  config.telemetry = enabled
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })

  // Update cached value
  telemetryEnabled = enabled
}

/**
 * Get current telemetry status
 */
export function getTelemetryStatus(): { enabled: boolean; reason: string } {
  const envValue = process.env.MSTRO_TELEMETRY
  if (envValue === '0' || envValue === 'false') {
    return { enabled: false, reason: 'Disabled via MSTRO_TELEMETRY environment variable' }
  }

  if (existsSync(CONFIG_FILE)) {
    try {
      const config: MstroConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
      if (config.telemetry === false) {
        return { enabled: false, reason: 'Disabled via ~/.mstro/config.json' }
      }
    } catch {
      // Ignore
    }
  }

  if (!analyticsConfig?.posthogKey) {
    return { enabled: false, reason: 'Analytics not configured on platform' }
  }

  return { enabled: true, reason: 'Enabled (opt-out with MSTRO_TELEMETRY=0)' }
}

// ===========================================
// Event Constants - Use these for consistency
// ===========================================

export const AnalyticsEvents = {
  // CLI events
  CLI_STARTED: 'cli_started',
  CLI_COMMAND: 'cli_command',
  CLI_LOGIN: 'cli_login',
  CLI_LOGOUT: 'cli_logout',
  CLI_ERROR: 'cli_error',

  // Server events
  SERVER_STARTED: 'server_started',
  SERVER_STOPPED: 'server_stopped',

  // Connection events
  PLATFORM_CONNECTED: 'platform_connected',
  PLATFORM_DISCONNECTED: 'platform_disconnected',
  WEB_CLIENT_CONNECTED: 'web_client_connected',
  WEB_CLIENT_DISCONNECTED: 'web_client_disconnected',

  // Improvise events
  IMPROVISE_SESSION_STARTED: 'improvise_session_started',
  IMPROVISE_PROMPT_RECEIVED: 'improvise_prompt_received',
  IMPROVISE_MOVEMENT_STARTED: 'improvise_movement_started',
  IMPROVISE_MOVEMENT_COMPLETED: 'improvise_movement_completed',
  IMPROVISE_MOVEMENT_ERROR: 'improvise_movement_error',
  IMPROVISE_SESSION_ENDED: 'improvise_session_ended',
  IMPROVISE_ABORTED: 'improvise_aborted',

  // Terminal events
  TERMINAL_SESSION_CREATED: 'terminal_session_created',
  TERMINAL_SESSION_CLOSED: 'terminal_session_closed',

  // MCP/Bouncer events
  BOUNCER_TOOL_ALLOWED: 'bouncer_tool_allowed',
  BOUNCER_TOOL_DENIED: 'bouncer_tool_denied',
  BOUNCER_HAIKU_REVIEW: 'bouncer_haiku_review',
} as const

export type AnalyticsEvent = typeof AnalyticsEvents[keyof typeof AnalyticsEvents]
