// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Engine factory — returns a concrete CodingAgentEngine for the requested
 * EngineId. Callers pass the value of `settings.engine` and the factory
 * dispatches to the matching implementation:
 *
 *   - 'claude-code' → ClaudeCodeEngine (headless runner, stdout JSON)
 *   - 'opencode'    → OpenCodeEngine   (OpenCode SDK + SSE)
 *
 * The OpenCode path is backed by a single process-lifetime
 * OpenCodeServerManager that owns the `opencode serve` subprocess. The
 * factory itself stays synchronous; manager startup is awaited inside
 * `startSession` via `LazyOpenCodeEngine` (below) so callers observe the
 * same lifecycle as ClaudeCodeEngine.
 */

import { isEngineSwapEnabled } from '../services/settings.js';
import { ClaudeCodeEngine } from './claude/ClaudeCodeEngine.js';
import { OpenCodeEngine } from './opencode/OpenCodeEngine.js';
import { OpenCodeServerManager } from './opencode/OpenCodeServerManager.js';
import type {
  CodingAgentEngine,
  EngineEvent,
  EngineId,
  EngineUsage,
  PromptAttachment,
  StartSessionOptions,
} from './types.js';

/**
 * Process-lifetime singleton for the `opencode serve` subprocess. Created
 * lazily on the first request for an opencode engine so Claude-only
 * deployments never spawn the binary. `registerProcessHandlers` is set so
 * the subprocess exits with the CLI — no orphan processes on SIGINT.
 */
let sharedOpenCodeManager: OpenCodeServerManager | null = null;

function getSharedOpenCodeServerManager(): OpenCodeServerManager {
  if (!sharedOpenCodeManager) {
    sharedOpenCodeManager = new OpenCodeServerManager({
      registerProcessHandlers: true,
    });
  }
  return sharedOpenCodeManager;
}

/**
 * Reset the cached OpenCode manager. Primarily for tests — never called
 * by production code. Does not shut down the previous manager; callers
 * that need a clean state should `shutdown()` first.
 */
export function __resetSharedOpenCodeServerManagerForTests(): void {
  sharedOpenCodeManager = null;
}

/**
 * Thin adapter that defers `OpenCodeEngine` construction until
 * `startSession` runs. The real engine requires an already-bound
 * `OpencodeClient`, but the underlying HTTP server is spawned
 * asynchronously by `OpenCodeServerManager`. `startSession` is the first
 * async call on the engine lifecycle, so we await `manager.start()`
 * there, then construct the inner engine once the client is available
 * and forward every subsequent call to it.
 *
 * The wrapper preserves the public `CodingAgentEngine` contract:
 *   - `engineId` is stable at `'opencode'` from construction.
 *   - Methods called before `startSession` resolve reject with the same
 *     error wording the inner engine would have produced.
 *   - `dispose()` is idempotent and tolerates the uninitialized case.
 */
class LazyOpenCodeEngine implements CodingAgentEngine {
  readonly engineId: EngineId = 'opencode';

  private inner: OpenCodeEngine | null = null;
  private started = false;
  private disposed = false;

  constructor(private readonly manager: OpenCodeServerManager) {}

  async startSession(options: StartSessionOptions): Promise<void> {
    if (this.disposed) {
      throw new Error('OpenCodeEngine: cannot start a disposed engine');
    }
    if (this.started) {
      throw new Error('OpenCodeEngine: startSession called more than once');
    }
    await this.manager.start();
    const client = this.manager.getClient();
    this.inner = new OpenCodeEngine({
      client,
      directory: options.workingDir,
    });
    await this.inner.startSession(options);
    this.started = true;
  }

  sendPrompt(
    prompt: string,
    attachments?: PromptAttachment[],
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new Error('OpenCodeEngine: sendPrompt called after dispose'),
      );
    }
    if (!this.inner) {
      return Promise.reject(
        new Error('OpenCodeEngine: sendPrompt called before startSession'),
      );
    }
    return this.inner.sendPrompt(prompt, attachments);
  }

  cancel(): Promise<void> {
    if (!this.inner) return Promise.resolve();
    return this.inner.cancel();
  }

  getUsage(): EngineUsage {
    if (!this.inner) {
      return { inputTokens: 0, outputTokens: 0, lastUpdatedAt: Date.now() };
    }
    return this.inner.getUsage();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.inner) {
      await this.inner.dispose();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    // The contract only allows iteration after `startSession` has resolved,
    // so `this.inner` is guaranteed to be set when consumers begin the
    // for-await loop. We delegate directly to the inner engine's iterator
    // to preserve its ordering and terminal-event semantics.
    if (!this.inner) {
      return {
        next: () => Promise.resolve({ value: undefined, done: true }),
      };
    }
    return this.inner[Symbol.asyncIterator]();
  }
}

/**
 * Construct a new engine instance for the given engine id. The returned
 * engine is uninitialized — the caller must call `startSession` before
 * any other method.
 *
 * Feature-flag gate: when `engineSwap` is disabled, this returns
 * `ClaudeCodeEngine` for every id. That guarantees the pre-OpenCode
 * behavior — in particular, `LazyOpenCodeEngine` is never constructed, so
 * the shared `OpenCodeServerManager` is never touched and no `opencode
 * serve` subprocess is spawned. The flag is checked on every call (rather
 * than cached) so runtime toggles take effect on the next session start.
 */
export function createEngine(engineId: EngineId): CodingAgentEngine {
  if (!isEngineSwapEnabled()) {
    return new ClaudeCodeEngine();
  }
  switch (engineId) {
    case 'claude-code':
      return new ClaudeCodeEngine();
    case 'opencode':
      return new LazyOpenCodeEngine(getSharedOpenCodeServerManager());
    default: {
      const exhaustive: never = engineId;
      throw new Error(`Unknown engine id: ${String(exhaustive)}`);
    }
  }
}
