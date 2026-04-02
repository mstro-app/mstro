// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

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
const CREDENTIALS_FILE = join(MSTRO_DIR, 'credentials.json')

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
  if (!existsSync(CREDENTIALS_FILE)) {
    return null
  }
  try {
    const content = readFileSync(CREDENTIALS_FILE, 'utf-8')
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

  writeFileSync(CREDENTIALS_FILE, JSON.stringify({ ...creds, ...updates }, null, 2), {
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
