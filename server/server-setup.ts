// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Server Setup Utilities — Helpers for the main server entry point.
 *
 * - ensureClaudeSettings: Ensures .claude/settings.json has recommended defaults
 * - wrapWebSocket / createPlatformRelayContext: WSContext adapters
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { WebSocket as NodeWebSocket } from 'ws'
import type { WSContext } from './services/websocket/types.js'

/**
 * Set the terminal tab title
 * Format: "mstro: directory_name"
 */
export function setTerminalTitle(directory: string): void {
  const dirName = basename(directory) || directory
  const title = `mstro: ${dirName}`
  process.stdout.write(`\x1b]0;${title}\x07`)
}

/**
 * Ensure .claude/settings.json exists with recommended settings
 * for optimal Claude Code performance with Mstro
 */
export function ensureClaudeSettings(workingDir: string): void {
  const claudeDir = join(workingDir, '.claude')
  const settingsPath = join(claudeDir, 'settings.json')

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true })
  }

  const recommendedSettings = {
    env: {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
      DISABLE_NONESSENTIAL_TRAFFIC: "1"
    }
  }

  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, JSON.stringify(recommendedSettings, null, 2))
    console.log(`📝 Created .claude/settings.json with recommended settings`)
  } else {
    try {
      const existingSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      let updated = false

      if (!existingSettings.env) {
        existingSettings.env = {}
        updated = true
      }

      if (!existingSettings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
        existingSettings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "64000"
        updated = true
      }
      if (!existingSettings.env.DISABLE_NONESSENTIAL_TRAFFIC) {
        existingSettings.env.DISABLE_NONESSENTIAL_TRAFFIC = "1"
        updated = true
      }

      if (updated) {
        writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2))
        console.log(`📝 Updated .claude/settings.json with recommended env settings`)
      }
    } catch (_e) {
      console.warn(`⚠️ Could not parse existing .claude/settings.json, skipping update`)
    }
  }
}

/**
 * Wrap a ws WebSocket to match our WSContext interface
 */
export function wrapWebSocket(ws: NodeWebSocket, workingDir: string): WSContext {
  return {
    send: (data: string | Buffer) => ws.send(data),
    close: () => ws.close(),
    readyState: ws.readyState,
    _workingDir: workingDir,
    _ws: ws
  } as WSContext
}

/**
 * Create a virtual WebSocket context that sends responses through the platform relay.
 * This allows messages from the web (via platform) to be handled by the same wsHandler.
 */
export function createPlatformRelayContext(
  platformSend: (message: unknown) => void,
  workingDir: string
): WSContext {
  return {
    send: (data: string | Buffer) => {
      try {
        const response = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString())
        platformSend(response)
      } catch (e) {
        console.error('[PlatformRelay] Failed to parse response:', e)
      }
    },
    close: () => {
      // No-op for platform relay
    },
    readyState: 1, // WebSocket.OPEN
    _workingDir: workingDir,
    _isPlatformRelay: true
  } as WSContext
}
