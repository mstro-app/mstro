// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Platform Credentials — Token management for device authentication.
 *
 * Reads/writes credentials from ~/.mstro/credentials.json and handles
 * periodic token refresh with the platform server.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MSTRO_ROOT } from '../utils/paths.js'

// Read CLI version from package.json once at import time
export const CLI_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(MSTRO_ROOT, 'package.json'), 'utf-8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const MSTRO_DIR = join(homedir(), '.mstro')

function credentialsFile(): string {
  const env = process.env.MSTRO_ENV || 'production'
  if (env === 'staging') return join(MSTRO_DIR, 'credentials-staging.json')
  if (env === 'dev') return join(MSTRO_DIR, 'credentials-dev.json')
  return join(MSTRO_DIR, 'credentials.json')
}

/** Refresh token every 30 days */
export const TOKEN_REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000

export interface StoredCredentials {
  token: string
  userId: string
  email: string
  name?: string
  clientId: string
  lastRefreshedAt?: string
}

/**
 * Get stored credentials from ~/.mstro/credentials.json
 */
export function getCredentials(): StoredCredentials | null {
  if (!existsSync(credentialsFile())) {
    return null
  }
  try {
    const content = readFileSync(credentialsFile(), 'utf-8')
    const creds = JSON.parse(content)
    if (creds.token && creds.userId && creds.email) {
      return creds
    }
    return null
  } catch {
    return null
  }
}

/**
 * Update stored credentials (for token refresh)
 */
export function updateCredentials(updates: Partial<StoredCredentials>): void {
  const creds = getCredentials()
  if (!creds) return

  writeFileSync(credentialsFile(), JSON.stringify({ ...creds, ...updates }, null, 2), {
    mode: 0o600
  })
}

/**
 * Check if token should be refreshed
 */
export function shouldRefreshToken(creds: StoredCredentials): boolean {
  if (!creds.lastRefreshedAt) {
    return true
  }

  const lastRefreshed = new Date(creds.lastRefreshedAt).getTime()
  const now = Date.now()
  return now - lastRefreshed > TOKEN_REFRESH_INTERVAL_MS
}
