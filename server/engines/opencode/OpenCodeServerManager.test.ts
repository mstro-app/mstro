// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawn as realSpawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findAvailablePort } from '../../utils/port.js'

import {
  type OpenCodeServerEvent,
  OpenCodeServerManager,
  OpenCodeServerManagerClosedError,
  type SpawnFn,
} from './OpenCodeServerManager.js'

// A small Node.js HTTP server that mimics the opencode subprocess for
// test purposes. It announces readiness on stdout in the exact format the
// real binary uses, then responds 200 on any path. Env vars control
// failure modes so individual tests can exercise crashes and retries
// without needing the real `opencode` binary installed.
const shimSource = `
const http = require('node:http');
const fs = require('node:fs');

const port = parseInt(process.env.SHIM_PORT, 10);
const stateFile = process.env.SHIM_STATE_FILE || '';
const crashBeforeReady = process.env.SHIM_CRASH_BEFORE_READY === '1';
const crashAfterReadyMs = parseInt(process.env.SHIM_CRASH_AFTER_READY_MS || '0', 10);
const failAfterFirstRun = process.env.SHIM_FAIL_AFTER_FIRST_RUN === '1';
const healthStatus = parseInt(process.env.SHIM_HEALTH_STATUS || '200', 10);

let runNumber = 1;
if (stateFile) {
  try {
    runNumber = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) + 1;
  } catch { runNumber = 1; }
  fs.writeFileSync(stateFile, String(runNumber));
}

if (crashBeforeReady) {
  process.stderr.write('shim: crashing before readiness\\n');
  process.exit(7);
}
if (failAfterFirstRun && runNumber > 1) {
  process.stderr.write('shim: permanent failure on run ' + runNumber + '\\n');
  process.exit(8);
}

const server = http.createServer((req, res) => {
  res.statusCode = healthStatus;
  res.setHeader('content-type', 'application/json');
  res.end('{}');
});

server.on('error', (err) => {
  process.stderr.write('shim: listen error: ' + err.message + '\\n');
  process.exit(9);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('opencode server listening on http://127.0.0.1:' + port + '\\n');
  if (crashAfterReadyMs > 0) {
    setTimeout(() => { process.exit(3); }, crashAfterReadyMs);
  }
});

const graceful = (sig) => () => {
  server.close();
  process.exit(0);
};
process.on('SIGTERM', graceful('SIGTERM'));
process.on('SIGINT', graceful('SIGINT'));
`

function makeShimSpawn(extraEnv: Record<string, string>): SpawnFn {
  return (
    _command: string,
    _args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess => {
    return realSpawn('node', ['-e', shimSource], {
      ...options,
      env: { ...options.env, ...extraEnv },
    })
  }
}

function countingSpawn(inner: SpawnFn): { fn: SpawnFn; count: () => number } {
  let n = 0
  const fn: SpawnFn = (command, args, options) => {
    n += 1
    return inner(command, args, options)
  }
  return { fn, count: () => n }
}

function waitForEvent(
  mgr: OpenCodeServerManager,
  kind: OpenCodeServerEvent['kind'],
  timeoutMs = 5_000,
): Promise<OpenCodeServerEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      mgr.off('event', listener)
      reject(new Error(`Timed out waiting for ${kind} event`))
    }, timeoutMs)
    const listener = (event: OpenCodeServerEvent): void => {
      if (event.kind === kind) {
        clearTimeout(t)
        mgr.off('event', listener)
        resolve(event)
      }
    }
    mgr.on('event', listener)
  })
}

function isPidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    // Signal 0 is a no-op existence check.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitUntil timeout after ${timeoutMs}ms`)
}

describe('OpenCodeServerManager', () => {
  let tmpDir: string
  let managers: OpenCodeServerManager[] = []

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'opencode-mgr-test-'))
    managers = []
  })

  afterEach(async () => {
    for (const m of managers) {
      try {
        await m.shutdown()
      } catch {
        // ignore
      }
    }
    managers = []
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  const track = (m: OpenCodeServerManager): OpenCodeServerManager => {
    managers.push(m)
    return m
  }

  it('exposes a typed SDK client after start', async () => {
    const port = await findAvailablePort(45100)
    const { fn } = countingSpawn(makeShimSpawn({ SHIM_PORT: String(port) }))
    const mgr = track(
      new OpenCodeServerManager({
        port,
        spawnFn: fn,
        overrideArgs: ['-e', 'placeholder'],
      }),
    )

    await mgr.start()

    expect(mgr.getStatus()).toBe('ready')
    expect(mgr.getUrl()).toBe(`http://127.0.0.1:${port}`)

    const client = mgr.getClient()
    expect(client).toBeDefined()
    expect(typeof (client as unknown as { app: unknown }).app).toBe('object')
    // Returning the same client on subsequent reads (no URL change).
    expect(mgr.getClient()).toBe(client)
  })

  it('is idempotent: concurrent start() callers share a single subprocess', async () => {
    const port = await findAvailablePort(45110)
    const { fn, count } = countingSpawn(
      makeShimSpawn({ SHIM_PORT: String(port) }),
    )
    const mgr = track(
      new OpenCodeServerManager({
        port,
        spawnFn: fn,
        overrideArgs: ['-e', 'placeholder'],
      }),
    )

    const results = await Promise.all([mgr.start(), mgr.start(), mgr.start()])
    expect(results).toEqual([undefined, undefined, undefined])
    expect(count()).toBe(1)

    // A post-ready start is a no-op.
    await mgr.start()
    expect(count()).toBe(1)
  })

  it('polls the health endpoint and fails start if it never succeeds', async () => {
    const port = await findAvailablePort(45120)
    // Shim returns 503 on every health request.
    const { fn } = countingSpawn(
      makeShimSpawn({
        SHIM_PORT: String(port),
        SHIM_HEALTH_STATUS: '503',
      }),
    )
    const mgr = track(
      new OpenCodeServerManager({
        port,
        spawnFn: fn,
        overrideArgs: ['-e', 'placeholder'],
        healthTimeoutMs: 400,
        healthPollIntervalMs: 40,
        // Disable restart so the test completes deterministically once
        // the first spawn's health probe exhausts its budget.
        maxRestartAttempts: 0,
      }),
    )

    await expect(mgr.start()).rejects.toThrow(/health check/i)
  })

  it('restarts after an unexpected crash and resumes serving', async () => {
    const port = await findAvailablePort(45130)
    const stateFile = join(tmpDir, 'state.txt')
    const { fn, count } = countingSpawn(
      makeShimSpawn({
        SHIM_PORT: String(port),
        SHIM_STATE_FILE: stateFile,
      }),
    )
    const readyPids: Array<number | undefined> = []
    const mgr = track(
      new OpenCodeServerManager({
        port,
        spawnFn: fn,
        overrideArgs: ['-e', 'placeholder'],
        initialBackoffMs: 50,
        maxBackoffMs: 100,
        maxRestartAttempts: 3,
      }),
    )
    mgr.on('event', (e: OpenCodeServerEvent) => {
      if (e.kind === 'ready') readyPids.push(e.pid)
    })

    await mgr.start()
    expect(count()).toBe(1)
    const firstPid = readyPids[0]
    expect(firstPid).toBeDefined()

    // Kill the live subprocess to simulate a crash.
    process.kill(firstPid!, 'SIGKILL')

    await waitForEvent(mgr, 'crash', 3_000)
    await waitForEvent(mgr, 'ready', 5_000)
    expect(mgr.getStatus()).toBe('ready')
    expect(count()).toBe(2)
    const secondPid = readyPids[1]
    expect(secondPid).toBeDefined()
    expect(secondPid).not.toBe(firstPid)
    expect(isPidAlive(secondPid)).toBe(true)
  })

  it('uses exponential backoff and transitions to failed after max retries', async () => {
    const port = await findAvailablePort(45140)
    const stateFile = join(tmpDir, 'state.txt')
    const { fn } = countingSpawn(
      makeShimSpawn({
        SHIM_PORT: String(port),
        SHIM_STATE_FILE: stateFile,
        SHIM_FAIL_AFTER_FIRST_RUN: '1',
      }),
    )
    const delays: number[] = []
    const mgr = track(
      new OpenCodeServerManager({
        port,
        spawnFn: fn,
        overrideArgs: ['-e', 'placeholder'],
        initialBackoffMs: 40,
        maxBackoffMs: 200,
        maxRestartAttempts: 3,
      }),
    )
    mgr.on('event', (e: OpenCodeServerEvent) => {
      if (e.kind === 'restart-scheduled') delays.push(e.delayMs)
    })

    let firstPid: number | undefined
    mgr.on('event', (e: OpenCodeServerEvent) => {
      if (e.kind === 'ready' && firstPid === undefined) firstPid = e.pid
    })
    await mgr.start()
    // Kill first proc so the restart loop starts; subsequent shim runs
    // exit before readiness, exhausting the restart budget.
    expect(firstPid).toBeDefined()
    process.kill(firstPid!, 'SIGKILL')

    const failed = await waitForEvent(mgr, 'failed', 10_000)
    expect(failed.kind).toBe('failed')
    expect(mgr.getStatus()).toBe('failed')
    expect(delays.length).toBeGreaterThanOrEqual(3)
    // Exponential growth: each delay is >= previous (until cap).
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1])
    }

    // Post-failure: start rejects, client is unavailable.
    await expect(mgr.start()).rejects.toBeInstanceOf(
      OpenCodeServerManagerClosedError,
    )
    expect(() => mgr.getClient()).toThrow(OpenCodeServerManagerClosedError)
  })

  it('shutdown kills the subprocess so no orphan remains', async () => {
    const port = await findAvailablePort(45150)
    const { fn } = countingSpawn(makeShimSpawn({ SHIM_PORT: String(port) }))
    const mgr = track(
      new OpenCodeServerManager({
        port,
        spawnFn: fn,
        overrideArgs: ['-e', 'placeholder'],
      }),
    )

    let pid: number | undefined
    mgr.on('event', (e: OpenCodeServerEvent) => {
      if (e.kind === 'ready') pid = e.pid
    })
    await mgr.start()
    expect(pid).toBeDefined()
    expect(isPidAlive(pid)).toBe(true)

    await mgr.shutdown()

    await waitUntil(() => !isPidAlive(pid), 2_000)
    expect(isPidAlive(pid)).toBe(false)
    expect(mgr.getStatus()).toBe('shutdown')
    expect(mgr.getUrl()).toBeNull()
    expect(() => mgr.getClient()).toThrow(OpenCodeServerManagerClosedError)
    await expect(mgr.start()).rejects.toBeInstanceOf(
      OpenCodeServerManagerClosedError,
    )

    // Shutdown is idempotent — a second call must not throw.
    await mgr.shutdown()
  })

  it('rejects start when the subprocess exits before readiness', async () => {
    const port = await findAvailablePort(45160)
    const { fn } = countingSpawn(
      makeShimSpawn({
        SHIM_PORT: String(port),
        SHIM_CRASH_BEFORE_READY: '1',
      }),
    )
    const mgr = track(
      new OpenCodeServerManager({
        port,
        spawnFn: fn,
        overrideArgs: ['-e', 'placeholder'],
        maxRestartAttempts: 0,
        startTimeoutMs: 2_000,
      }),
    )
    await expect(mgr.start()).rejects.toThrow(/exited before readiness/i)
  })
})
