// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as Sentry from '@sentry/node'

// Hardcoded DSN for production - this is safe to expose (can only send, not read)
// Override with SENTRY_DSN env var for development/testing
const SENTRY_DSN = process.env.SENTRY_DSN || 'https://2a8d2493e3ee5a7beec30f4518a5e24c@o4510824844820480.ingest.us.sentry.io/4510824923594752'

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
    dsn: SENTRY_DSN,
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

export function captureException(error: unknown, context?: Record<string, any>): void {
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
