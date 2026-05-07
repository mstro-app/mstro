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
import type { EngineId } from '../engines/types.js'

const MSTRO_DIR = join(homedir(), '.mstro')
const SETTINGS_FILE = join(MSTRO_DIR, 'settings.json')

/**
 * Configuration for the Layer-2 Bouncer classifier (the AI model that runs
 * for every ambiguous tool call). The model MUST be flagged
 * `bouncerEligible` in the engine's model catalogue — frontier models
 * (Opus, GPT-4o, …) are deliberately disallowed because they slow the
 * classifier path and degrade the whole security layer.
 */
export interface BouncerClassifierConfig {
  engine: EngineId
  /** Engine-specific model id, e.g. 'haiku', 'sonnet', 'openai/gpt-5-mini'. */
  model: string
}

/**
 * Canonical list of bouncer-eligible models per engine. Mirrors
 * `web/src/components/views/SettingsView/constants.ts` — keep the two in
 * sync. Only cheap/fast models appear here; if you need to add a model,
 * check p50 latency < ~1s and JSON-mode capability first.
 */
export const BOUNCER_ELIGIBLE_MODELS: Record<EngineId, readonly string[]> = {
  'claude-code': ['haiku', 'sonnet'],
  opencode: [
    'openai/gpt-5-mini',
    'openai/gpt-5-nano',
    'google/gemini-2.5-flash',
    'ollama/llama3.1:8b',
  ],
}

/** Default classifier — Claude Haiku. Matches the pre-feature-flag behavior. */
export const DEFAULT_BOUNCER_CLASSIFIER: BouncerClassifierConfig = {
  engine: 'claude-code',
  model: 'haiku',
}

/**
 * Validate a `BouncerClassifierConfig`. Rejects with a thrown `Error` when
 * the model is not flagged `bouncerEligible` under the requested engine —
 * e.g. attempting to use Opus as a classifier, or a frontier OpenCode
 * model. The WebSocket settings handler uses this to reject crafted
 * payloads from the web client.
 */
export function validateBouncerClassifier(config: unknown): BouncerClassifierConfig {
  if (config === null || typeof config !== 'object') {
    throw new Error('bouncerClassifier must be an object with { engine, model }')
  }
  const { engine, model } = config as { engine?: unknown; model?: unknown }
  if (engine !== 'claude-code' && engine !== 'opencode') {
    throw new Error(`bouncerClassifier.engine must be 'claude-code' or 'opencode' (got ${String(engine)})`)
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('bouncerClassifier.model must be a non-empty string')
  }
  const eligible = BOUNCER_ELIGIBLE_MODELS[engine]
  if (!eligible.includes(model)) {
    throw new Error(
      `Model '${model}' is not bouncer-eligible for engine '${engine}'. ` +
        `Eligible models: ${eligible.join(', ')}. ` +
        `Frontier models (Opus, GPT-4o, etc.) are deliberately excluded to keep the classifier fast.`,
    )
  }
  return { engine, model }
}

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
  /**
   * Feature flag gating all OpenCode code paths (engine factory, classifier
   * factory, and UI). When `false`, the system behaves byte-identically to
   * pre-OpenCode main: no `opencode serve` subprocess, no classifier picker,
   * no EngineSection/EnginePicker in the web UI. Resolution order in
   * `isEngineSwapEnabled()`: env var → stored setting → NODE_ENV default.
   */
  engineSwap?: boolean
  /**
   * Which engine + model backs the Layer-2 Bouncer classifier. Defaults to
   * `{ engine: 'claude-code', model: 'haiku' }`. Only models flagged
   * `bouncerEligible` are accepted — see {@link validateBouncerClassifier}.
   */
  bouncerClassifier?: BouncerClassifierConfig
}

const DEFAULT_SETTINGS: MstroSettings = {
  model: 'opus',
  effortLevel: 'auto',
  bouncerClassifier: { ...DEFAULT_BOUNCER_CLASSIFIER },
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
 * Get current settings, merged with defaults for any missing fields. A
 * persisted `bouncerClassifier` that is no longer bouncer-eligible (e.g. a
 * catalogue change removed the model) is dropped in favor of the default
 * and a warning is logged — the Bouncer must never silently run a
 * non-eligible model just because someone edited settings.json by hand.
 */
export function getSettings(): MstroSettings {
  if (!existsSync(SETTINGS_FILE)) {
    return { ...DEFAULT_SETTINGS }
  }

  try {
    const content = readFileSync(SETTINGS_FILE, 'utf-8')
    const stored = JSON.parse(content)
    const merged: MstroSettings = {
      ...DEFAULT_SETTINGS,
      ...stored,
    }
    if (stored && typeof stored === 'object' && 'bouncerClassifier' in stored) {
      try {
        merged.bouncerClassifier = validateBouncerClassifier(stored.bouncerClassifier)
      } catch (err) {
        console.warn(
          '[settings] Stored bouncerClassifier is not bouncer-eligible, falling back to default:',
          err instanceof Error ? err.message : String(err),
        )
        merged.bouncerClassifier = { ...DEFAULT_BOUNCER_CLASSIFIER }
      }
    }
    return merged
  } catch (err) {
    console.warn('Failed to read settings file, using defaults:', err)
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * Save full settings to disk. Rejects if `bouncerClassifier` is present but
 * its model is not flagged `bouncerEligible` — this is the save-time half
 * of the guard; `getSettings` enforces the read-time half. Together they
 * ensure the Bouncer is never configured with a frontier model (Opus,
 * GPT-4o, …) regardless of whether the mutation came from the web UI or a
 * direct edit of settings.json.
 */
export function saveSettings(settings: MstroSettings): void {
  if (settings.bouncerClassifier !== undefined) {
    // Throws on non-eligible model — callers must surface the error.
    validateBouncerClassifier(settings.bouncerClassifier)
  }
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

/**
 * Get the current Bouncer classifier configuration. Returns the default
 * `{ engine: 'claude-code', model: 'haiku' }` when nothing is persisted.
 */
export function getBouncerClassifier(): BouncerClassifierConfig {
  const settings = getSettings()
  if (settings.bouncerClassifier) {
    try {
      return validateBouncerClassifier(settings.bouncerClassifier)
    } catch {
      // Stored config is no longer eligible (e.g. model removed from the
      // catalogue). Fall back to the safe default rather than crashing.
      return { ...DEFAULT_BOUNCER_CLASSIFIER }
    }
  }
  return { ...DEFAULT_BOUNCER_CLASSIFIER }
}

/**
 * Persist a new Bouncer classifier config. Throws if the model is not
 * flagged `bouncerEligible` under the requested engine — callers should
 * surface the error to the UI so the user sees a clear rejection reason.
 */
export function setBouncerClassifier(config: unknown): BouncerClassifierConfig {
  const validated = validateBouncerClassifier(config)
  const settings = getSettings()
  settings.bouncerClassifier = validated
  saveSettings(settings)
  return validated
}

/**
 * Resolve the engineSwap feature flag. Precedence:
 *   1. `MSTRO_ENABLE_ENGINE_SWAP` env var ('true'|'1' → on, 'false'|'0' → off).
 *   2. `engineSwap` field in `~/.mstro/settings.json`.
 *   3. NODE_ENV default — off in production, on otherwise (dev/staging/test).
 *
 * Callers who need a single boolean should use this helper rather than
 * reading the field directly, so the precedence stays in one place.
 */
export function isEngineSwapEnabled(): boolean {
  const envFlag = process.env.MSTRO_ENABLE_ENGINE_SWAP
  if (envFlag !== undefined) {
    const normalized = envFlag.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
  }
  const stored = getSettings().engineSwap
  if (typeof stored === 'boolean') return stored
  return process.env.NODE_ENV !== 'production'
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
