// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Instance Registry Service
 *
 * Manages multiple Mstro server instances
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function clearStaleLock(lockPath: string): void {
  if (!existsSync(lockPath)) return
  try {
    const lockTime = parseInt(readFileSync(lockPath, 'utf-8'), 10)
    if (Date.now() - lockTime > 10000) {
      try { unlinkSync(lockPath) } catch {}
    }
  } catch {}
}

function tryCreateLock(lockPath: string): boolean {
  try {
    writeFileSync(lockPath, Date.now().toString(), { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

function busyWait(): void {
  const endTime = Date.now() + Math.random() * 50 + 10
  while (Date.now() < endTime) { /* busy wait */ }
}

function acquireLock(lockPath: string, timeout = 5000): boolean {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    clearStaleLock(lockPath)
    if (tryCreateLock(lockPath)) return true
    busyWait()
  }
  return false
}

function releaseLock(lockPath: string) {
  try {
    unlinkSync(lockPath)
  } catch {
    // Ignore errors when releasing lock
  }
}

export interface MstroInstance {
  id: string
  port: number
  url: string
  workingDirectory: string
  startedAt: number
  lastHeartbeat: number
  pid: number
}

export class InstanceRegistry {
  private registryPath: string
  private currentInstance: MstroInstance | null = null
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    const mstroDir = join(homedir(), '.mstro')
    if (!existsSync(mstroDir)) {
      mkdirSync(mstroDir, { recursive: true, mode: 0o700 })
    }
    this.registryPath = join(mstroDir, 'instances.json')
  }

  /**
   * Register current instance
   */
  register(port: number, workingDirectory: string): MstroInstance {
    const instance: MstroInstance = {
      id: `mstro-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      port,
      url: `http://localhost:${port}`,
      workingDirectory,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      pid: process.pid
    }

    this.currentInstance = instance
    this.saveInstance(instance)
    this.startHeartbeat()

    return instance
  }

  /**
   * Unregister current instance
   */
  unregister() {
    if (this.currentInstance) {
      this.removeInstance(this.currentInstance.id)
      this.currentInstance = null
    }
    this.stopHeartbeat()
  }

  /**
   * Get current instance info
   */
  getCurrentInstance(): MstroInstance | null {
    return this.currentInstance
  }

  /**
   * Get all instances (with file locking to prevent race conditions)
   */
  static getAllInstances(): MstroInstance[] {
    const mstroDir = join(homedir(), '.mstro')
    const registryPath = join(mstroDir, 'instances.json')
    const lockPath = join(mstroDir, 'instances.lock')

    if (!existsSync(registryPath)) {
      return []
    }

    const locked = acquireLock(lockPath, 3000)
    try {
      const data = readFileSync(registryPath, 'utf-8')

      // Handle empty or whitespace-only content
      if (!data || !data.trim()) {
        return []
      }

      const parsed = JSON.parse(data)

      // Ensure we have an array
      const instances: MstroInstance[] = Array.isArray(parsed) ? parsed : []

      // Filter out stale instances (no heartbeat in last 2 minutes)
      const now = Date.now()
      const maxAge = 2 * 60 * 1000 // 2 minutes

      return instances.filter(instance =>
        now - instance.lastHeartbeat < maxAge
      )
    } catch (error) {
      // If JSON is corrupted, log but don't spam - return empty and let next write fix it
      if (error instanceof SyntaxError) {
        console.warn('[InstanceRegistry] Registry file corrupted, will be recreated on next write')
      } else {
        console.error('[InstanceRegistry] Failed to read instances registry:', error)
      }
      return []
    } finally {
      if (locked) {
        releaseLock(lockPath)
      }
    }
  }

  /**
   * Get instance by ID
   */
  static getInstance(id: string): MstroInstance | null {
    const instances = InstanceRegistry.getAllInstances()
    return instances.find(i => i.id === id) || null
  }

  /**
   * Save instance to registry (with file locking)
   */
  private saveInstance(instance: MstroInstance) {
    const lockPath = join(homedir(), '.mstro', 'instances.lock')
    const locked = acquireLock(lockPath, 5000)

    try {
      // Read current instances directly (without calling getAllInstances to avoid double-locking)
      let instances: MstroInstance[] = []
      if (existsSync(this.registryPath)) {
        try {
          const data = readFileSync(this.registryPath, 'utf-8')
          if (data?.trim()) {
            const parsed = JSON.parse(data)
            instances = Array.isArray(parsed) ? parsed : []
          }
        } catch {
          // If file is corrupted, start fresh
          instances = []
        }
      }

      // Filter out stale instances while we're at it
      const now = Date.now()
      const maxAge = 2 * 60 * 1000
      instances = instances.filter(i =>
        i.id !== instance.id && now - i.lastHeartbeat < maxAge
      )

      // Add new/updated instance
      instances.push(instance)

      // Write atomically by writing to temp file first then renaming
      const tempPath = `${this.registryPath}.tmp`
      writeFileSync(tempPath, JSON.stringify(instances, null, 2), 'utf-8')

      // Rename is atomic on most filesystems
      renameSync(tempPath, this.registryPath)
    } finally {
      if (locked) {
        releaseLock(lockPath)
      }
    }
  }

  /**
   * Remove instance from registry (with file locking)
   */
  private removeInstance(id: string) {
    const lockPath = join(homedir(), '.mstro', 'instances.lock')
    const locked = acquireLock(lockPath, 5000)

    try {
      let instances: MstroInstance[] = []
      if (existsSync(this.registryPath)) {
        try {
          const data = readFileSync(this.registryPath, 'utf-8')
          if (data?.trim()) {
            const parsed = JSON.parse(data)
            instances = Array.isArray(parsed) ? parsed : []
          }
        } catch {
          instances = []
        }
      }

      instances = instances.filter(i => i.id !== id)

      const tempPath = `${this.registryPath}.tmp`
      writeFileSync(tempPath, JSON.stringify(instances, null, 2), 'utf-8')

      renameSync(tempPath, this.registryPath)
    } finally {
      if (locked) {
        releaseLock(lockPath)
      }
    }
  }

  /**
   * Start heartbeat to keep instance alive
   */
  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.currentInstance) {
        this.currentInstance.lastHeartbeat = Date.now()
        this.saveInstance(this.currentInstance)
      }
    }, 30000) // Every 30 seconds
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }
}
