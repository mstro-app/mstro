// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as Sentry from '@sentry/node'

// Sentry DSN lives on the platform server. The CLI sends envelopes
// to the server's /sentry-tunnel endpoint which proxies to Sentry.
// A placeholder DSN is needed so the Sentry SDK initializes its
// transport — the real DSN is injected server-side before forwarding.
const SENTRY_TUNNEL_DSN = 'https://tunnel@sentry.io/0'
const PLATFORM_URL = process.env.PLATFORM_URL || 'https://api.mstro.app'

const CONFIG_FILE = join(homedir(), '.mstro', 'config.json')

let initialized = false

interface MstroConfig {
  telemetry?: boolean
}

/**
 * Check if telemetry/error reporting is enabled
 * Respects the same config as analytics (unified telemetry setting)
 */
function isTelemetryEnabled(): boolean {
  // Check environment variable first
  const envValue = process.env.MSTRO_TELEMETRY
  if (envValue === '0' || envValue === 'false') {
    return false
  }

  // Check config file
  if (existsSync(CONFIG_FILE)) {
    try {
      const config: MstroConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
      if (config.telemetry === false) {
        return false
      }
    } catch {
      // Ignore parse errors
    }
  }

  return true
}

export function initSentry(): void {
  if (initialized) return
  if (!isTelemetryEnabled()) return

  initialized = true

  Sentry.init({
    dsn: SENTRY_TUNNEL_DSN,
    tunnel: `${PLATFORM_URL}/sentry-tunnel`,
    environment: process.env.NODE_ENV || 'development',
    release: `mstro-cli@${process.env.npm_package_version || '0.0.0'}`,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      // Strip PII from error events
      if (event.user) {
        delete event.user.ip_address
      }
      return event
    },
  })
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return
  Sentry.captureException(error, context ? { extra: context } : undefined)
}

export function captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  if (!initialized) return
  Sentry.captureMessage(message, level)
}

export async function flushSentry(timeout = 2000): Promise<void> {
  if (!initialized) return
  await Sentry.flush(timeout)
}
