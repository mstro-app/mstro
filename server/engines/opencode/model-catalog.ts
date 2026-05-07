// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * OpenCode model catalog.
 *
 * Thin wrapper over `OpencodeClient.config.providers()` that flattens the
 * nested `{provider -> {modelId -> Model}}` shape into a flat array of
 * `CatalogModel` records consumable by the Settings UI, and annotates each
 * entry with a `bouncerEligible` flag indicating whether the model is
 * suitable for Layer-2 Bouncer classification (see `isBouncerEligibleModel`
 * below).
 *
 * A per-directory TTL cache prevents every Settings render from hitting the
 * opencode server — providers and models rarely change during a session.
 */

import type { Model, OpencodeClient, Provider } from '@opencode-ai/sdk'

/** Default cache lifetime — 10 minutes as called out in the issue spec. */
export const MODEL_CATALOG_TTL_MS = 10 * 60 * 1000

/**
 * Augmented model record exposed to callers. The `id` is the canonical
 * `"providerID/modelID"` slug used elsewhere in the engines code (e.g. the
 * `model` field on `StartSessionOptions`).
 */
export interface CatalogModel {
  /** Canonical slug — `"providerID/modelID"`. Stable across fetches. */
  id: string
  /** Human-readable name for dropdowns. Falls back to `modelID` when blank. */
  label: string
  /** Provider display name for grouping/labelling. */
  provider: string
  /**
   * True when this model is small/fast enough to serve as the Layer-2
   * Bouncer classifier without meaningfully impacting tool latency. See
   * {@link isBouncerEligibleModel} for the exact heuristic.
   */
  bouncerEligible: boolean
}

/** Options for {@link listModels}. */
export interface ListModelsOptions {
  /**
   * Working directory forwarded as `?directory=` — OpenCode scopes provider
   * availability by directory (a project-level config may enable/disable
   * providers). Also used as the cache key.
   */
  directory?: string
  /** Skip the cache and force a fresh SDK call. Result is still cached. */
  forceRefresh?: boolean
  /** Override cache lifetime. Defaults to {@link MODEL_CATALOG_TTL_MS}. */
  ttlMs?: number
  /**
   * Clock source, injected for deterministic cache-expiry tests. Defaults
   * to `Date.now`.
   */
  now?: () => number
}

interface CacheEntry {
  expiresAt: number
  data: CatalogModel[]
}

/**
 * Cache keyed by `(client, directory)`. Using a `WeakMap<OpencodeClient, ...>`
 * as the outer layer means the cache is scoped to the live SDK client —
 * when the OpenCode server restarts and a new client is created, the stale
 * entry is garbage-collected rather than lingering.
 *
 * `let` (not `const`) so {@link clearModelCatalogCache} can atomically swap
 * the map — `WeakMap` has no `clear()` method.
 */
let cache: WeakMap<OpencodeClient, Map<string, CacheEntry>> = new WeakMap()

/**
 * Eligibility heuristic: does this model identify as a small/fast model
 * appropriate for Layer-2 Bouncer classification?
 *
 * Layer-2 runs on every ambiguous tool call, so speed is paramount. We only
 * mark models that are explicitly marketed as fast/small:
 *
 *   - `haiku`  — Anthropic Haiku family (Claude 3/3.5/4 Haiku).
 *   - `flash`  — Google Gemini Flash / Flash-Lite family.
 *   - `mini`   — OpenAI *-mini line (GPT-4o-mini, GPT-5-mini, o3-mini, ...).
 *   - `nano`   — OpenAI *-nano / Gemini Nano.
 *   - `small`  — Mistral Small, DeepSeek-Small, etc.
 *
 * Large, slow frontier models (Opus, Sonnet, GPT-4, GPT-5, Gemini Pro, Ultra,
 * Mistral Large) are explicitly rejected. Any model identifier that does not
 * match one of the small-class signals is left ineligible — the Bouncer
 * should never quietly fall back to an Opus-class model and tank latency.
 *
 * The heuristic is intentionally applied to the canonical slug
 * `providerID/modelID` lowercased. Provider display names are irrelevant.
 */
export function isBouncerEligibleModel(modelSlug: string): boolean {
  const id = modelSlug.toLowerCase()

  // Fast-reject large/frontier models. These terms override any later
  // small-class match — e.g., a hypothetical "opus-mini" still fails the
  // large-class guard and is ineligible.
  if (/\bopus\b/.test(id)) return false
  if (/\bsonnet\b/.test(id)) return false
  if (/\bultra\b/.test(id)) return false
  if (/\blarge\b/.test(id)) return false

  // Eligible when the slug contains any small/fast class signal.
  if (/\bhaiku\b/.test(id)) return true
  if (/\bflash\b/.test(id)) return true
  if (/\bmini\b/.test(id)) return true
  if (/\bnano\b/.test(id)) return true
  if (/\bsmall\b/.test(id)) return true

  return false
}

/**
 * Fetch the model catalog from OpenCode, flatten + augment, and cache.
 *
 * The SDK returns `{providers: Provider[]}` where each `Provider.models` is
 * a map keyed by model id. We iterate providers deterministically and emit
 * one `CatalogModel` per entry. Deprecated models are filtered out — they
 * shouldn't be surfaced as selectable options.
 */
export async function listModels(
  client: OpencodeClient,
  options: ListModelsOptions = {},
): Promise<CatalogModel[]> {
  const directory = options.directory
  const ttl = options.ttlMs ?? MODEL_CATALOG_TTL_MS
  const now = options.now ?? Date.now
  const key = directory ?? '__default__'

  if (!options.forceRefresh) {
    const cached = readCache(client, key, now())
    if (cached) return cached
  }

  const response = await client.config.providers({
    query: directory ? { directory } : undefined,
  })
  const payload = extractProvidersPayload(response)
  const catalog = flattenProviders(payload?.providers ?? [])
  writeCache(client, key, catalog, now() + ttl)
  return catalog
}

function readCache(
  client: OpencodeClient,
  key: string,
  currentTime: number,
): CatalogModel[] | undefined {
  const hit = cache.get(client)?.get(key)
  return hit && hit.expiresAt > currentTime ? hit.data : undefined
}

function writeCache(
  client: OpencodeClient,
  key: string,
  data: CatalogModel[],
  expiresAt: number,
): void {
  let byDir = cache.get(client)
  if (!byDir) {
    byDir = new Map()
    cache.set(client, byDir)
  }
  byDir.set(key, { data, expiresAt })
}

function flattenProviders(providers: Provider[]): CatalogModel[] {
  const catalog: CatalogModel[] = []
  for (const provider of providers) {
    const models = provider.models ?? {}
    for (const modelId of Object.keys(models)) {
      const model: Model = models[modelId]
      if (model.status === 'deprecated') continue
      const slug = `${provider.id}/${modelId}`
      catalog.push({
        id: slug,
        label: model.name || modelId,
        provider: provider.name || provider.id,
        bouncerEligible: isBouncerEligibleModel(slug),
      })
    }
  }
  return catalog
}

/**
 * Drop every cache entry. Intended for tests and for the case where the
 * OpenCode server is intentionally restarted and callers want the next
 * `listModels()` call to see a fresh picture immediately.
 *
 * `WeakMap` has no `clear()` method, so we swap the map — the old map
 * becomes eligible for GC.
 */
export function clearModelCatalogCache(): void {
  cache = new WeakMap()
}

/**
 * Narrow SDK response envelope — the default `createOpencodeClient`
 * wraps results as `{ data, error, response }`. A ThrowOnError client
 * returns the payload directly. Handle both.
 */
function extractProvidersPayload(
  result: unknown,
): { providers: Provider[] } | undefined {
  if (result && typeof result === 'object' && 'data' in result) {
    return (result as { data?: { providers: Provider[] } }).data
  }
  return result as { providers: Provider[] } | undefined
}
