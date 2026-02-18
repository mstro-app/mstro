// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Client ID Service
 *
 * Generates and persists a unique client identifier that survives server restarts.
 * This ID is used to distinguish between different user home directories on different machines.
 *
 * Storage: ~/.mstro/client-id
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MSTRO_DIR = join(homedir(), '.mstro')
const CLIENT_ID_FILE = join(MSTRO_DIR, 'client-id')

/**
 * Generate a new UUID v4
 */
function generateUUID(): string {
  return crypto.randomUUID()
}

/**
 * Get the persistent client ID, creating one if it doesn't exist.
 * This ID is unique to this machine's ~/.mstro directory.
 */
export function getClientId(): string {
  // Ensure ~/.mstro directory exists
  if (!existsSync(MSTRO_DIR)) {
    mkdirSync(MSTRO_DIR, { recursive: true, mode: 0o700 })
  }

  // Try to read existing client ID
  if (existsSync(CLIENT_ID_FILE)) {
    try {
      const id = readFileSync(CLIENT_ID_FILE, 'utf-8').trim()
      if (id && isValidUUID(id)) {
        return id
      }
    } catch {
      // File exists but couldn't be read, generate new one
    }
  }

  // Generate and persist a new client ID
  const newId = generateUUID()
  writeFileSync(CLIENT_ID_FILE, newId, 'utf-8')
  return newId
}

/**
 * Validate UUID format
 */
function isValidUUID(id: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  return uuidRegex.test(id)
}

/**
 * Get the client ID file path (for debugging/display)
 */
export function getClientIdPath(): string {
  return CLIENT_ID_FILE
}
