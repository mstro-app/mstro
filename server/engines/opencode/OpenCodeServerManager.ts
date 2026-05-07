// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * OpenCodeServerManager — lifecycle owner for a single `opencode serve`
 * subprocess per CLI instance.
 *
 * Responsibilities:
 * - Lazy start: the subprocess is spawned on the first `start()` call.
 * - Idempotent start: concurrent callers share a single subprocess and a
 *   single in-flight start Promise.
 * - Health-gated readiness: `start()` resolves only after the subprocess has
 *   both (a) printed its listening URL and (b) responded to an HTTP probe.
 * - Crash detection with exponential backoff: an unexpected process exit
 *   triggers automatic restart; after `maxRestartAttempts` failures the
 *   manager transitions to a terminal `failed` state and further calls
 *   reject.
 * - Clean shutdown: `shutdown()` kills the subprocess, prevents further
 *   restarts, and (when registerProcessHandlers is set) is wired to CLI
 *   exit signals so no orphan process survives the parent.
 *
 * Callers obtain a typed `OpencodeClient` via `getClient()`. The client is
 * stable across restarts — its baseUrl is updated in place when the
 * subprocess is restarted on the same hostname/port.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

import {
  createOpencodeClient,
  type OpencodeClient,
} from '@opencode-ai/sdk'

/** Spawn signature accepted by the manager — matches node's `child_process.spawn`. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

/** Events emitted by the manager for observability and tests. */
export type OpenCodeServerEvent =
  | { kind: 'starting'; attempt: number }
  | { kind: 'ready'; url: string; pid: number | undefined }
  | { kind: 'crash'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'restart-scheduled'; attempt: number; delayMs: number }
  | { kind: 'failed'; error: Error }
  | { kind: 'shutdown' }

/** Construction options for {@link OpenCodeServerManager}. */
export interface OpenCodeServerManagerOptions {
  /** Host the opencode server binds to. Defaults to `127.0.0.1`. */
  hostname?: string
  /** Port the opencode server binds to. Defaults to `4096`. */
  port?: number
  /** Binary to invoke. Defaults to `opencode`. Tests override with a shim. */
  command?: string
  /**
   * Extra args appended to the spawned command. The manager always passes
   * `serve --hostname=<h> --port=<p>` first; overrides may supply the
   * entire arg list by setting `overrideArgs`.
   */
  extraArgs?: string[]
  /**
   * If set, the manager uses exactly these args instead of the default
   * `serve --hostname --port` trio. Tests use this to drive shims that
   * don't implement the opencode CLI.
   */
  overrideArgs?: string[]
  /** Additional env vars merged into the subprocess environment. */
  env?: Record<string, string>
  /**
   * Milliseconds to wait for the subprocess to emit its readiness line
   * before giving up on an attempt. Defaults to 10_000.
   */
  startTimeoutMs?: number
  /**
   * Milliseconds between HTTP readiness probes after the readiness line
   * has been seen. Defaults to 50.
   */
  healthPollIntervalMs?: number
  /**
   * Overall budget for the HTTP readiness probe phase. Defaults to
   * 5_000.
   */
  healthTimeoutMs?: number
  /**
   * Path used for the HTTP readiness probe. Defaults to `/config`.
   */
  healthPath?: string
  /** Cap on restart attempts before the manager transitions to `failed`. */
  maxRestartAttempts?: number
  /** Base backoff for restarts. Doubles each attempt. Defaults to 500ms. */
  initialBackoffMs?: number
  /** Ceiling for exponential backoff. Defaults to 10_000ms. */
  maxBackoffMs?: number
  /**
   * If true, the manager registers SIGINT/SIGTERM/exit handlers on the
   * parent process and calls `shutdown()` when they fire. Defaults to
   * false (opt-in at the call site that owns the process-level policy).
   */
  registerProcessHandlers?: boolean
  /** Inject a fake spawn function for tests. Defaults to node's spawn. */
  spawnFn?: SpawnFn
  /**
   * Inject a fake fetch for HTTP readiness probes. Defaults to global
   * `fetch`. Primarily used to decouple tests from network timing.
   */
  fetchFn?: typeof fetch
}

/** Lifecycle state for the manager. */
export type OpenCodeServerStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'failed'
  | 'shutdown'

const DEFAULTS = {
  hostname: '127.0.0.1',
  port: 4096,
  command: 'opencode',
  startTimeoutMs: 10_000,
  healthPollIntervalMs: 50,
  healthTimeoutMs: 5_000,
  healthPath: '/config',
  maxRestartAttempts: 5,
  initialBackoffMs: 500,
  maxBackoffMs: 10_000,
}

/**
 * Thrown when the manager has been shut down or has exceeded its restart
 * budget. Callers should construct a new manager to retry.
 */
export class OpenCodeServerManagerClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenCodeServerManagerClosedError'
  }
}

export class OpenCodeServerManager extends EventEmitter {
  private readonly opts: Required<
    Omit<
      OpenCodeServerManagerOptions,
      'extraArgs' | 'overrideArgs' | 'env' | 'spawnFn' | 'fetchFn'
    >
  > & {
    extraArgs: string[]
    overrideArgs: string[] | undefined
    env: Record<string, string>
    spawnFn: SpawnFn
    fetchFn: typeof fetch
  }

  private status: OpenCodeServerStatus = 'idle'
  private proc: ChildProcess | null = null
  private url: string | null = null
  private startPromise: Promise<void> | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private restartAttempts = 0
  private failureReason: Error | null = null
  /** Intentional shutdown flag — prevents crash handler from restarting. */
  private isShuttingDown = false
  /** Cached SDK client; its baseUrl is rotated on each successful start. */
  private cachedClient: OpencodeClient | null = null
  private lastBaseUrl: string | null = null
  private processHandlersRegistered = false
  private readonly boundProcessHandler: () => void

  constructor(options: OpenCodeServerManagerOptions = {}) {
    super()
    this.opts = OpenCodeServerManager.resolveOptions(options)

    this.boundProcessHandler = () => {
      void this.shutdown().catch(() => {})
    }

    if (this.opts.registerProcessHandlers) {
      this.attachProcessHandlers()
    }
  }

  private static resolveOptions(
    options: OpenCodeServerManagerOptions,
  ): OpenCodeServerManager['opts'] {
    return {
      hostname: options.hostname ?? DEFAULTS.hostname,
      port: options.port ?? DEFAULTS.port,
      command: options.command ?? DEFAULTS.command,
      extraArgs: options.extraArgs ?? [],
      overrideArgs: options.overrideArgs,
      env: options.env ?? {},
      startTimeoutMs: options.startTimeoutMs ?? DEFAULTS.startTimeoutMs,
      healthPollIntervalMs:
        options.healthPollIntervalMs ?? DEFAULTS.healthPollIntervalMs,
      healthTimeoutMs: options.healthTimeoutMs ?? DEFAULTS.healthTimeoutMs,
      healthPath: options.healthPath ?? DEFAULTS.healthPath,
      maxRestartAttempts:
        options.maxRestartAttempts ?? DEFAULTS.maxRestartAttempts,
      initialBackoffMs: options.initialBackoffMs ?? DEFAULTS.initialBackoffMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
      registerProcessHandlers: options.registerProcessHandlers ?? false,
      spawnFn: options.spawnFn ?? (nodeSpawn as unknown as SpawnFn),
      fetchFn: options.fetchFn ?? fetch,
    }
  }

  /** Current lifecycle state. */
  getStatus(): OpenCodeServerStatus {
    return this.status
  }

  /** URL of the running subprocess, or `null` if not ready. */
  getUrl(): string | null {
    return this.url
  }

  /** True once `start()` has resolved and the subprocess is alive. */
  isRunning(): boolean {
    return this.status === 'ready' && this.proc !== null
  }

  /**
   * Return a typed SDK client bound to the currently running server.
   * Throws if the manager has not been started or has entered a terminal
   * state.
   */
  getClient(): OpencodeClient {
    if (this.status === 'shutdown' || this.status === 'failed') {
      throw new OpenCodeServerManagerClosedError(
        `OpenCodeServerManager is ${this.status}` +
          (this.failureReason ? `: ${this.failureReason.message}` : ''),
      )
    }
    if (!this.url) {
      throw new OpenCodeServerManagerClosedError(
        'OpenCodeServerManager.start() has not completed; no client available',
      )
    }
    if (!this.cachedClient || this.lastBaseUrl !== this.url) {
      this.cachedClient = createOpencodeClient({ baseUrl: this.url })
      this.lastBaseUrl = this.url
    }
    return this.cachedClient
  }

  /**
   * Idempotent: first call spawns the subprocess; concurrent calls share
   * the same in-flight Promise. Returns after the subprocess is both
   * listening (stdout readiness line seen) and answering HTTP probes.
   */
  start(): Promise<void> {
    if (this.status === 'shutdown' || this.status === 'failed') {
      return Promise.reject(
        new OpenCodeServerManagerClosedError(
          `OpenCodeServerManager is ${this.status}` +
            (this.failureReason ? `: ${this.failureReason.message}` : ''),
        ),
      )
    }
    if (this.status === 'ready' && this.proc) {
      return Promise.resolve()
    }
    if (this.startPromise) {
      return this.startPromise
    }
    this.startPromise = this.spawnOnce(1)
      .then(() => {
        this.startPromise = null
      })
      .catch((err) => {
        this.startPromise = null
        throw err
      })
    return this.startPromise
  }

  /**
   * Terminate the subprocess, cancel any pending restart, and move the
   * manager to the terminal `shutdown` state. Idempotent.
   */
  async shutdown(): Promise<void> {
    if (this.status === 'shutdown') return
    this.isShuttingDown = true
    this.status = 'shutdown'
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const proc = this.proc
    this.proc = null
    this.url = null
    this.cachedClient = null
    this.lastBaseUrl = null
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      await killAndWait(proc)
    }
    this.detachProcessHandlers()
    this.emitEvent({ kind: 'shutdown' })
  }

  private emitEvent(event: OpenCodeServerEvent): void {
    this.emit('event', event)
    this.emit(event.kind, event)
  }

  private buildArgs(): string[] {
    if (this.opts.overrideArgs) return [...this.opts.overrideArgs]
    return [
      'serve',
      `--hostname=${this.opts.hostname}`,
      `--port=${this.opts.port}`,
      ...this.opts.extraArgs,
    ]
  }

  private async spawnOnce(attempt: number): Promise<void> {
    if (this.isShuttingDown || this.status === 'shutdown') {
      throw new OpenCodeServerManagerClosedError(
        'OpenCodeServerManager is shutdown',
      )
    }
    this.status = attempt === 1 ? 'starting' : 'restarting'
    this.emitEvent({ kind: 'starting', attempt })

    const args = this.buildArgs()
    const proc = this.opts.spawnFn(this.opts.command, args, {
      env: { ...process.env, ...this.opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.proc = proc

    const readinessUrl = await this.runStartupPhase(proc, () =>
      this.awaitReadinessLine(proc),
    )
    await this.runStartupPhase(proc, () => this.awaitHealthy(readinessUrl))

    this.url = readinessUrl
    this.status = 'ready'
    this.restartAttempts = 0
    this.wireCrashHandler(proc)
    this.emitEvent({ kind: 'ready', url: readinessUrl, pid: proc.pid })
  }

  private async runStartupPhase<T>(
    proc: ChildProcess,
    phase: () => Promise<T>,
  ): Promise<T> {
    try {
      return await phase()
    } catch (err) {
      // Make sure the subprocess is not left dangling if a phase failed.
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill()
        } catch {
          // ignore
        }
      }
      this.proc = null
      throw err
    }
  }

  private awaitReadinessLine(proc: ChildProcess): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let buffered = ''
      let settled = false

      const onStdout = (chunk: Buffer | string) => {
        if (settled) return
        buffered += chunk.toString()
        const lines = buffered.split('\n')
        for (const line of lines) {
          if (line.startsWith('opencode server listening')) {
            const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
            if (!match) {
              finish(
                reject,
                new Error(
                  `Failed to parse opencode readiness line: ${line}`,
                ),
              )
              return
            }
            finish(resolve, match[1])
            return
          }
        }
      }
      const onStderr = (chunk: Buffer | string) => {
        buffered += chunk.toString()
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const tail = buffered.trim()
        finish(
          reject,
          new Error(
            `opencode subprocess exited before readiness (code=${code}, signal=${signal})` +
              (tail ? `\nOutput: ${tail}` : ''),
          ),
        )
      }
      const onError = (err: Error) => finish(reject, err)
      const onTimeout = () => {
        finish(
          reject,
          new Error(
            `Timed out after ${this.opts.startTimeoutMs}ms waiting for opencode to announce readiness`,
          ),
        )
      }

      const timer = setTimeout(onTimeout, this.opts.startTimeoutMs)

      function finish(
        cb: (value: never) => void,
        value: unknown,
      ): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        proc.stdout?.off('data', onStdout)
        proc.stderr?.off('data', onStderr)
        proc.off('exit', onExit)
        proc.off('error', onError)
        ;(cb as (v: unknown) => void)(value)
      }

      proc.stdout?.on('data', onStdout)
      proc.stderr?.on('data', onStderr)
      proc.on('exit', onExit)
      proc.on('error', onError)
    })
  }

  private async awaitHealthy(baseUrl: string): Promise<void> {
    const url = baseUrl.replace(/\/$/, '') + this.opts.healthPath
    const deadline = Date.now() + this.opts.healthTimeoutMs
    let lastError: unknown = null
    while (Date.now() < deadline) {
      try {
        const res = await this.opts.fetchFn(url, { method: 'GET' })
        // Any 2xx/3xx/4xx response means the server is up and routing;
        // only network failures / 5xx indicate it is not yet ready.
        if (res.status < 500) return
        lastError = new Error(`Health probe status ${res.status}`)
      } catch (err) {
        lastError = err
      }
      await sleep(this.opts.healthPollIntervalMs)
    }
    throw new Error(
      `opencode server did not pass health check at ${url} within ` +
        `${this.opts.healthTimeoutMs}ms` +
        (lastError instanceof Error ? `: ${lastError.message}` : ''),
    )
  }

  private wireCrashHandler(proc: ChildProcess): void {
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (this.proc !== proc) return
      if (this.isShuttingDown || this.status === 'shutdown') return
      this.proc = null
      this.url = null
      this.cachedClient = null
      this.lastBaseUrl = null
      this.emitEvent({ kind: 'crash', code, signal })
      this.scheduleRestart()
    }
    proc.once('exit', onExit)
  }

  private scheduleRestart(): void {
    if (this.isShuttingDown || this.status === 'shutdown') return
    this.restartAttempts += 1
    if (this.restartAttempts > this.opts.maxRestartAttempts) {
      const err = new Error(
        `opencode subprocess exceeded ${this.opts.maxRestartAttempts} restart attempts`,
      )
      this.failureReason = err
      this.status = 'failed'
      this.emitEvent({ kind: 'failed', error: err })
      return
    }
    const delay = Math.min(
      this.opts.initialBackoffMs * 2 ** (this.restartAttempts - 1),
      this.opts.maxBackoffMs,
    )
    this.status = 'restarting'
    this.emitEvent({
      kind: 'restart-scheduled',
      attempt: this.restartAttempts,
      delayMs: delay,
    })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.isShuttingDown || this.status === 'shutdown') return
      const attempt = this.restartAttempts + 1
      // spawnOnce uses `attempt` purely for events; we pass the 1-based
      // restart attempt so observers can correlate.
      this.startPromise = this.spawnOnce(attempt)
        .then(() => {
          this.startPromise = null
        })
        .catch((err) => {
          this.startPromise = null
          if (this.isShuttingDown || this.status === 'shutdown') return
          this.emitEvent({
            kind: 'crash',
            code: null,
            signal: null,
          })
          // A failure to spawn counts the same as a crash — reschedule.
          this.scheduleRestart()
          // Surface the immediate error via the failed handler chain
          // when we eventually give up in scheduleRestart above.
          this.failureReason = err instanceof Error ? err : new Error(String(err))
        })
    }, delay)
  }

  private attachProcessHandlers(): void {
    if (this.processHandlersRegistered) return
    this.processHandlersRegistered = true
    process.on('SIGINT', this.boundProcessHandler)
    process.on('SIGTERM', this.boundProcessHandler)
    process.on('beforeExit', this.boundProcessHandler)
  }

  private detachProcessHandlers(): void {
    if (!this.processHandlersRegistered) return
    this.processHandlersRegistered = false
    process.off('SIGINT', this.boundProcessHandler)
    process.off('SIGTERM', this.boundProcessHandler)
    process.off('beforeExit', this.boundProcessHandler)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function killAndWait(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve())
  })
  try {
    proc.kill('SIGTERM')
  } catch {
    // already exited or permission denied — fall through
  }
  const timer = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
  }, 1_000)
  try {
    await exited
  } finally {
    clearTimeout(timer)
  }
}
