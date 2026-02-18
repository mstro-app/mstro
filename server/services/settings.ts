// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Settings Service
 *
 * Manages persistent machine-wide settings stored in ~/.mstro/settings.json
 *
 * Structure:
 * {
 *   "model": "opus"
 * }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MSTRO_DIR = join(homedir(), '.mstro')
const SETTINGS_FILE = join(MSTRO_DIR, 'settings.json')

export interface MstroSettings {
  /**
   * Claude model to use for main execution.
   * - 'default' means don't pass --model (let Claude Code decide)
   * - Any other string is passed as --model <value>
   */
  model: string
}

const DEFAULT_SETTINGS: MstroSettings = {
  model: 'opus'
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
 * Get current settings, merged with defaults for any missing fields
 */
export function getSettings(): MstroSettings {
  if (!existsSync(SETTINGS_FILE)) {
    return { ...DEFAULT_SETTINGS }
  }

  try {
    const content = readFileSync(SETTINGS_FILE, 'utf-8')
    const stored = JSON.parse(content)
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
    }
  } catch (err) {
    console.warn('Failed to read settings file, using defaults:', err)
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * Save full settings to disk
 */
export function saveSettings(settings: MstroSettings): void {
  ensureMstroDir()
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), {
    mode: 0o600
  })
}

/**
 * Get the current model setting
 */
export function getModel(): string {
  return getSettings().model
}

/**
 * Update just the model setting
 */
export function setModel(model: string): void {
  const settings = getSettings()
  settings.model = model
  saveSettings(settings)
}
