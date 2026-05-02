// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Settings Service
 *
 * Manages persistent machine-wide settings stored in ~/.mstro/settings.json
 *
 * Structure:
 * {
 *   "model": "opus",
 *   "effortLevel": "auto"
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
  /**
   * Effort level for main execution, passed to Claude Code as --effort.
   * - 'auto' means don't pass --effort (let Claude Code use its per-model default:
   *   xhigh on Opus 4.7, high on Sonnet 4.6).
   * - Any other string is passed as --effort <value>. Claude Code silently falls
   *   back to the highest supported level when a model doesn't support the value
   *   (e.g. xhigh → high on Sonnet 4.6). Haiku ignores it entirely.
   */
  effortLevel: string
  /** Per-repo preferred PR base branch, keyed by normalized remote URL */
  prBaseBranches?: Record<string, string>
}

const DEFAULT_SETTINGS: MstroSettings = {
  model: 'opus',
  effortLevel: 'auto'
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

/**
 * Get the current effort level setting
 */
export function getEffortLevel(): string {
  return getSettings().effortLevel
}

/**
 * Update just the effort level setting
 */
export function setEffortLevel(effortLevel: string): void {
  const settings = getSettings()
  settings.effortLevel = effortLevel
  saveSettings(settings)
}

/** Normalize a remote URL into a stable key (e.g. "github.com/owner/repo") */
function normalizeRemoteUrl(remoteUrl: string): string {
  return remoteUrl
    .replace(/^(https?:\/\/|git@)/, '')
    .replace(/\.git$/, '')
    .replace(/:/, '/')
}

/** Get the preferred PR base branch for a repo */
export function getPrBaseBranch(remoteUrl: string): string | null {
  const settings = getSettings()
  const key = normalizeRemoteUrl(remoteUrl)
  return settings.prBaseBranches?.[key] ?? null
}

/** Save the preferred PR base branch for a repo */
export function setPrBaseBranch(remoteUrl: string, branch: string): void {
  const settings = getSettings()
  if (!settings.prBaseBranches) settings.prBaseBranches = {}
  settings.prBaseBranches[normalizeRemoteUrl(remoteUrl)] = branch
  saveSettings(settings)
}
