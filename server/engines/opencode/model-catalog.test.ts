// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Unit tests for the OpenCode model catalog.
 *
 * Drives a hand-rolled mock `OpencodeClient` — no network, no subprocess.
 * Focuses on the three behaviors the catalog actually owns:
 *   1. flattening `config.providers()` into a `CatalogModel[]`,
 *   2. applying the `bouncerEligible` heuristic, and
 *   3. honoring the TTL cache.
 */

import type { Model, OpencodeClient, Provider } from '@opencode-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type CatalogModel,
  clearModelCatalogCache,
  isBouncerEligibleModel,
  listModels,
  MODEL_CATALOG_TTL_MS,
} from './model-catalog.js'

// ---------- mock client ----------

/**
 * Build a minimal `Model` with sensible defaults — tests override `id`,
 * `name`, and optionally `status`.
 */
function makeModel(id: string, name?: string, status?: Model['status']): Model {
  return {
    id,
    providerID: 'unused-filled-by-provider-wrap',
    api: { id, url: '', npm: '' },
    name: name ?? id,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 8_192 },
    status: status ?? 'active',
    options: {},
    headers: {},
  }
}

function makeProvider(
  id: string,
  name: string,
  models: Record<string, Model>,
): Provider {
  return {
    id,
    name,
    source: 'api',
    env: [],
    options: {},
    models,
  }
}

interface MockState {
  providersCalls: Array<{ directory?: string } | undefined>
  response: { providers: Provider[] }
}

function makeMockClient(state: MockState): OpencodeClient {
  return {
    config: {
      providers: vi.fn(
        async (opts?: { query?: { directory?: string } }) => {
          state.providersCalls.push(opts?.query)
          return { data: state.response }
        },
      ),
    },
  } as unknown as OpencodeClient
}

beforeEach(() => {
  clearModelCatalogCache()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------- eligibility heuristic ----------

describe('isBouncerEligibleModel', () => {
  it.each<[string, boolean]>([
    // Small/fast — eligible
    ['anthropic/claude-3-5-haiku-20241022', true],
    ['anthropic/claude-haiku-4-5', true],
    ['google/gemini-2.5-flash', true],
    ['google/gemini-1.5-flash-8b', true],
    ['openai/gpt-4o-mini', true],
    ['openai/gpt-5-mini', true],
    ['openai/o3-mini', true],
    ['openai/gpt-5-nano', true],
    ['mistral/mistral-small-latest', true],

    // Large/frontier — ineligible
    ['anthropic/claude-opus-4-7', false],
    ['anthropic/claude-3-5-sonnet-20241022', false],
    ['anthropic/claude-sonnet-4-6', false],
    ['openai/gpt-4o', false],
    ['openai/gpt-5', false],
    ['google/gemini-2.5-pro', false],
    ['google/gemini-1.5-ultra', false],
    ['mistral/mistral-large-latest', false],

    // Large-class override beats small-class signal
    ['anthropic/claude-opus-4-mini', false],
    ['openai/gpt-5-sonnet-mini', false],

    // Unknown — conservatively ineligible
    ['unknown/mystery-model', false],
    ['custom/my-finetune', false],
  ])('%s => %s', (slug, expected) => {
    expect(isBouncerEligibleModel(slug)).toBe(expected)
  })
})

// ---------- listModels: flatten + augment ----------

describe('listModels', () => {
  it('flattens providers into CatalogModel[] with correct bouncerEligible flags', async () => {
    const state: MockState = {
      providersCalls: [],
      response: {
        providers: [
          makeProvider('anthropic', 'Anthropic', {
            'claude-opus-4-7': makeModel('claude-opus-4-7', 'Claude Opus 4.7'),
            'claude-haiku-4-5': makeModel(
              'claude-haiku-4-5',
              'Claude Haiku 4.5',
            ),
          }),
          makeProvider('openai', 'OpenAI', {
            'gpt-4o': makeModel('gpt-4o', 'GPT-4o'),
            'gpt-4o-mini': makeModel('gpt-4o-mini', 'GPT-4o Mini'),
          }),
          makeProvider('google', 'Google', {
            'gemini-2.5-flash': makeModel(
              'gemini-2.5-flash',
              'Gemini 2.5 Flash',
            ),
          }),
        ],
      },
    }
    const client = makeMockClient(state)

    const models = await listModels(client)

    expect(models).toEqual<CatalogModel[]>([
      {
        id: 'anthropic/claude-opus-4-7',
        label: 'Claude Opus 4.7',
        provider: 'Anthropic',
        bouncerEligible: false,
      },
      {
        id: 'anthropic/claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        provider: 'Anthropic',
        bouncerEligible: true,
      },
      {
        id: 'openai/gpt-4o',
        label: 'GPT-4o',
        provider: 'OpenAI',
        bouncerEligible: false,
      },
      {
        id: 'openai/gpt-4o-mini',
        label: 'GPT-4o Mini',
        provider: 'OpenAI',
        bouncerEligible: true,
      },
      {
        id: 'google/gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        provider: 'Google',
        bouncerEligible: true,
      },
    ])
  })

  it('filters out deprecated models', async () => {
    const state: MockState = {
      providersCalls: [],
      response: {
        providers: [
          makeProvider('anthropic', 'Anthropic', {
            'claude-3-haiku': makeModel(
              'claude-3-haiku',
              'Claude 3 Haiku',
              'deprecated',
            ),
            'claude-haiku-4-5': makeModel(
              'claude-haiku-4-5',
              'Claude Haiku 4.5',
              'active',
            ),
          }),
        ],
      },
    }

    const models = await listModels(makeMockClient(state))
    expect(models).toHaveLength(1)
    expect(models[0].id).toBe('anthropic/claude-haiku-4-5')
  })

  it('falls back to modelId when name is empty', async () => {
    const state: MockState = {
      providersCalls: [],
      response: {
        providers: [
          makeProvider('x', 'X', {
            'm-1': { ...makeModel('m-1'), name: '' },
          }),
        ],
      },
    }
    const [model] = await listModels(makeMockClient(state))
    expect(model.label).toBe('m-1')
  })

  it('forwards directory to the SDK query', async () => {
    const state: MockState = {
      providersCalls: [],
      response: { providers: [] },
    }
    const client = makeMockClient(state)
    await listModels(client, { directory: '/work/proj' })

    expect(state.providersCalls).toEqual([{ directory: '/work/proj' }])
  })
})

// ---------- TTL cache ----------

describe('listModels TTL cache', () => {
  it('returns cached result on subsequent calls within TTL', async () => {
    const state: MockState = {
      providersCalls: [],
      response: {
        providers: [
          makeProvider('anthropic', 'Anthropic', {
            'claude-haiku-4-5': makeModel('claude-haiku-4-5'),
          }),
        ],
      },
    }
    const client = makeMockClient(state)
    const providersSpy = client.config.providers as unknown as ReturnType<
      typeof vi.fn
    >

    let fakeNow = 1_000_000
    const now = (): number => fakeNow

    const first = await listModels(client, { now })
    fakeNow += 60_000 // +1 min, well inside the 10-min TTL
    const second = await listModels(client, { now })

    expect(providersSpy).toHaveBeenCalledTimes(1)
    expect(second).toBe(first) // same reference — served from cache
  })

  it('refetches after TTL expiry', async () => {
    const state: MockState = {
      providersCalls: [],
      response: {
        providers: [
          makeProvider('anthropic', 'Anthropic', {
            'claude-haiku-4-5': makeModel('claude-haiku-4-5'),
          }),
        ],
      },
    }
    const client = makeMockClient(state)
    const providersSpy = client.config.providers as unknown as ReturnType<
      typeof vi.fn
    >

    let fakeNow = 1_000_000
    const now = (): number => fakeNow

    await listModels(client, { now })
    fakeNow += MODEL_CATALOG_TTL_MS + 1
    await listModels(client, { now })

    expect(providersSpy).toHaveBeenCalledTimes(2)
  })

  it('forceRefresh bypasses the cache', async () => {
    const state: MockState = {
      providersCalls: [],
      response: { providers: [] },
    }
    const client = makeMockClient(state)
    const providersSpy = client.config.providers as unknown as ReturnType<
      typeof vi.fn
    >

    await listModels(client)
    await listModels(client, { forceRefresh: true })

    expect(providersSpy).toHaveBeenCalledTimes(2)
  })

  it('caches per directory independently', async () => {
    const state: MockState = {
      providersCalls: [],
      response: { providers: [] },
    }
    const client = makeMockClient(state)
    const providersSpy = client.config.providers as unknown as ReturnType<
      typeof vi.fn
    >

    await listModels(client, { directory: '/a' })
    await listModels(client, { directory: '/b' })
    await listModels(client, { directory: '/a' }) // cache hit

    expect(providersSpy).toHaveBeenCalledTimes(2)
  })

  it('clearModelCatalogCache forces the next call to refetch', async () => {
    const state: MockState = {
      providersCalls: [],
      response: { providers: [] },
    }
    const client = makeMockClient(state)
    const providersSpy = client.config.providers as unknown as ReturnType<
      typeof vi.fn
    >

    await listModels(client)
    clearModelCatalogCache()
    await listModels(client)

    expect(providersSpy).toHaveBeenCalledTimes(2)
  })
})
