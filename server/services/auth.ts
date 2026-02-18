// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Authentication Service
 *
 * Manages local session token for localhost API/WebSocket auth.
 * All mstro instances on a machine share a single token from ~/.mstro/session-token.
 * The token is created once (by `mstro login` or first server start) and reused.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SESSION_TOKEN_PATH = join(homedir(), '.mstro', 'session-token')

export class AuthService {
  private localToken: string

  constructor() {
    this.localToken = this.loadOrCreateToken()
  }

  /**
   * Load existing session token from disk, or create one if missing.
   * This ensures all mstro instances on the same machine share the same token.
   */
  private loadOrCreateToken(): string {
    const existing = AuthService.readLocalToken()
    if (existing) {
      return existing
    }

    const token = randomBytes(32).toString('hex')
    this.writeToken(token)
    return token
  }

  /**
   * Write session token to ~/.mstro/session-token
   */
  private writeToken(token: string): void {
    const dir = join(homedir(), '.mstro')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    writeFileSync(SESSION_TOKEN_PATH, token, { mode: 0o600 })
  }

  /**
   * Validate the local session token (used for localhost API/WS auth)
   */
  validateLocalToken(token: string): boolean {
    return token === this.localToken
  }

  /**
   * Get the local session token (for passing to child processes)
   */
  getLocalToken(): string {
    return this.localToken
  }

  /**
   * Read the local session token from disk (static utility for clients)
   */
  static readLocalToken(): string | null {
    try {
      if (existsSync(SESSION_TOKEN_PATH)) {
        const token = readFileSync(SESSION_TOKEN_PATH, 'utf-8').trim()
        if (token.length > 0) {
          return token
        }
      }
    } catch {}
    return null
  }
}
