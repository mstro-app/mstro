// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Session Registry — Persistent tab-to-session mapping
 *
 * Survives WebSocket disconnections and reconnections. When a web client
 * refreshes or a new client connects, the registry allows the handler to
 * reattach tabs to their existing in-memory sessions (or resume from disk).
 *
 * Backed by .mstro/session-registry.json in the working directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RegisteredTab {
  sessionId: string
  tabName: string
  createdAt: string
  lastActivityAt: string
  order: number
  hasUnviewedCompletion: boolean
}

interface RegistryData {
  tabs: Record<string, RegisteredTab>
}

export class SessionRegistry {
  private registryPath: string
  private data: RegistryData

  constructor(workingDir: string) {
    const mstroDir = join(workingDir, '.mstro')
    if (!existsSync(mstroDir)) {
      mkdirSync(mstroDir, { recursive: true })
    }
    this.registryPath = join(mstroDir, 'session-registry.json')
    this.data = this.load()
  }

  private load(): RegistryData {
    try {
      if (existsSync(this.registryPath)) {
        const raw: RegistryData = JSON.parse(readFileSync(this.registryPath, 'utf-8'))
        // Backfill `order` for legacy data that lacks it
        const needsOrder = Object.values(raw.tabs).some((t) => t.order === undefined)
        if (needsOrder) {
          const sorted = Object.entries(raw.tabs).sort(([, a], [, b]) =>
            (a.createdAt || '').localeCompare(b.createdAt || '')
          )
          sorted.forEach(([, tab], i) => {
            if (tab.order === undefined) tab.order = i
          })
        }
        // Backfill `hasUnviewedCompletion` for legacy data
        for (const tab of Object.values(raw.tabs)) {
          if (tab.hasUnviewedCompletion === undefined) tab.hasUnviewedCompletion = false
        }
        return raw
      }
    } catch (error) {
      console.error('[SessionRegistry] Error loading registry:', error)
    }
    return { tabs: {} }
  }

  private save(): void {
    try {
      writeFileSync(this.registryPath, JSON.stringify(this.data, null, 2))
    } catch (error) {
      console.error('[SessionRegistry] Error saving registry:', error)
    }
  }

  private getNextOrder(): number {
    let max = -1
    for (const tab of Object.values(this.data.tabs)) {
      if (tab.order > max) max = tab.order
    }
    return max + 1
  }

  registerTab(tabId: string, sessionId: string, tabName?: string): void {
    const now = new Date().toISOString()
    this.data.tabs[tabId] = {
      sessionId,
      tabName: tabName || `Chat ${this.getNextChatNumber()}`,
      createdAt: this.data.tabs[tabId]?.createdAt || now,
      lastActivityAt: now,
      order: this.data.tabs[tabId]?.order ?? this.getNextOrder(),
      hasUnviewedCompletion: this.data.tabs[tabId]?.hasUnviewedCompletion ?? false,
    }
    this.save()
  }

  /**
   * Find the next available "Chat N" number by scanning existing tab names.
   */
  private getNextChatNumber(): number {
    const usedNumbers = new Set<number>()
    for (const tab of Object.values(this.data.tabs)) {
      const match = tab.tabName.match(/^Chat (\d+)$/)
      if (match) {
        usedNumbers.add(parseInt(match[1], 10))
      }
    }
    let n = 1
    while (usedNumbers.has(n)) n++
    return n
  }

  unregisterTab(tabId: string): void {
    delete this.data.tabs[tabId]
    this.save()
  }

  getTabSession(tabId: string): string | undefined {
    return this.data.tabs[tabId]?.sessionId
  }

  getTab(tabId: string): RegisteredTab | undefined {
    return this.data.tabs[tabId]
  }

  getAllTabs(): Record<string, RegisteredTab> {
    return { ...this.data.tabs }
  }

  updateTabName(tabId: string, name: string): void {
    if (this.data.tabs[tabId]) {
      this.data.tabs[tabId].tabName = name
      this.save()
    }
  }

  touchTab(tabId: string): void {
    if (this.data.tabs[tabId]) {
      this.data.tabs[tabId].lastActivityAt = new Date().toISOString()
      this.save()
    }
  }

  /**
   * Update session ID for a tab (e.g., when "new session" is started)
   */
  updateTabSession(tabId: string, sessionId: string): void {
    if (this.data.tabs[tabId]) {
      this.data.tabs[tabId].sessionId = sessionId
      this.data.tabs[tabId].lastActivityAt = new Date().toISOString()
      this.save()
    }
  }

  markTabViewed(tabId: string): void {
    if (this.data.tabs[tabId]) {
      this.data.tabs[tabId].hasUnviewedCompletion = false
      this.save()
    }
  }

  markTabUnviewed(tabId: string): void {
    if (this.data.tabs[tabId]) {
      this.data.tabs[tabId].hasUnviewedCompletion = true
      this.save()
    }
  }

  /**
   * Reorder tabs. Accepts an ordered array of tabIds and reassigns order values.
   */
  reorderTabs(tabOrder: string[]): void {
    for (let i = 0; i < tabOrder.length; i++) {
      const tab = this.data.tabs[tabOrder[i]]
      if (tab) tab.order = i
    }
    this.save()
  }
}
