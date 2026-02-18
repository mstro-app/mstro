// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Credentials Service
 *
 * Manages persistent authentication credentials stored in ~/.mstro/credentials.json
 *
 * Structure:
 * {
 *   "token": "device-token-here",
 *   "userId": "user-uuid",
 *   "email": "user@example.com",
 *   "name": "User Name",
 *   "deviceId": "device-uuid",
 *   "clientId": "client-uuid",
 *   "createdAt": "2024-01-01T00:00:00.000Z",
 *   "lastRefreshedAt": "2024-01-01T00:00:00.000Z"
 * }
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MSTRO_DIR = join(homedir(), '.mstro')
const CREDENTIALS_FILE = join(MSTRO_DIR, 'credentials.json')

export interface Credentials {
  token: string
  userId: string
  email: string
  name?: string
  deviceId?: string
  clientId: string
  createdAt: string
  lastRefreshedAt?: string
}

/**
 * Ensure the ~/.mstro directory exists
 */
function ensureMstroDir(): void {
  if (!existsSync(MSTRO_DIR)) {
    mkdirSync(MSTRO_DIR, { recursive: true, mode: 0o700 })
  }
}

/**
 * Get stored credentials, or null if not logged in
 */
export function getCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_FILE)) {
    return null
  }

  try {
    const content = readFileSync(CREDENTIALS_FILE, 'utf-8')
    const credentials = JSON.parse(content) as Credentials

    // Validate required fields
    if (!credentials.token || !credentials.userId || !credentials.email || !credentials.clientId) {
      console.warn('Invalid credentials file, missing required fields')
      return null
    }

    return credentials
  } catch (err) {
    console.warn('Failed to read credentials file:', err)
    return null
  }
}

/**
 * Save credentials after successful login
 */
export function saveCredentials(credentials: Credentials): void {
  ensureMstroDir()
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), {
    mode: 0o600 // Read/write for owner only
  })
}

/**
 * Update the token (used during refresh)
 */
export function updateToken(newToken: string): void {
  const credentials = getCredentials()
  if (!credentials) {
    throw new Error('No credentials to update')
  }

  credentials.token = newToken
  credentials.lastRefreshedAt = new Date().toISOString()
  saveCredentials(credentials)
}

/**
 * Delete credentials (logout)
 */
export function deleteCredentials(): boolean {
  if (!existsSync(CREDENTIALS_FILE)) {
    return false
  }

  try {
    unlinkSync(CREDENTIALS_FILE)
    return true
  } catch (err) {
    console.error('Failed to delete credentials:', err)
    return false
  }
}

/**
 * Check if user is logged in
 */
export function isLoggedIn(): boolean {
  return getCredentials() !== null
}

/**
 * Get the credentials file path (for display)
 */
export function getCredentialsPath(): string {
  return CREDENTIALS_FILE
}

/**
 * Get the mstro directory path
 */
export function getMstroDir(): string {
  return MSTRO_DIR
}
