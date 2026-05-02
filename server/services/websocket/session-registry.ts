// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

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
  /**
   * True once the session's history file has existed on disk (first prompt
   * ran, or the tab was resumed from an existing file). Guards `sweepGhostTabs`
   * so brand-new tabs that haven't had a first prompt are not confused with
   * tabs whose history file was deleted.
   */
  hasPersistedHistory?: boolean
  worktreePath?: string
  worktreeBranch?: string
}

interface RegistryData {
  tabs: Record<string, RegisteredTab>
}

export class SessionRegistry {
  private registryPath: string
  private historyDir: string
  private data: RegistryData

  constructor(workingDir: string) {
    const mstroDir = join(workingDir, '.mstro')
    if (!existsSync(mstroDir)) {
      mkdirSync(mstroDir, { recursive: true })
    }
    this.registryPath = join(mstroDir, 'session-registry.json')
    this.historyDir = join(mstroDir, 'history')
    this.data = this.load()
    this.sweepGhostTabs()
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

  /**
   * Drop registry entries whose backing history file no longer exists.
   *
   * The history file may have been deleted via `clearHistory`, pruned by the
   * user, or lost on disk. Without a sweep, `getActiveTabs` returns the tab
   * to the web, the web tries to `initTab` it, `resumeFromHistory` throws,
   * and the tab re-creates as an empty new session — confusing the user with
   * a "restored" tab that lost its content.
   *
   * Only sweeps tabs that were previously persisted (`hasPersistedHistory`).
   * Tabs that have never had a first prompt have no file on disk by design;
   * removing them here would wipe a freshly opened tab after a CLI restart.
   */
  private sweepGhostTabs(): void {
    const removed: string[] = []
    for (const [tabId, tab] of Object.entries(this.data.tabs)) {
      if (tab.hasPersistedHistory !== true) continue
      const timestamp = tab.sessionId.replace('improv-', '')
      const historyPath = join(this.historyDir, `${timestamp}.json`)
      if (!existsSync(historyPath)) {
        removed.push(tabId)
        delete this.data.tabs[tabId]
      }
    }
    if (removed.length > 0) {
      console.log(`[SessionRegistry] Swept ${removed.length} ghost tab(s) whose history file was missing`)
      this.save()
    }
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
    const existing = this.data.tabs[tabId]
    const sessionChanged = existing?.sessionId !== sessionId
    this.data.tabs[tabId] = {
      sessionId,
      tabName: tabName || `Chat ${this.getNextChatNumber()}`,
      createdAt: existing?.createdAt || now,
      lastActivityAt: now,
      order: existing?.order ?? this.getNextOrder(),
      hasUnviewedCompletion: existing?.hasUnviewedCompletion ?? false,
      hasPersistedHistory: sessionChanged ? false : existing?.hasPersistedHistory,
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
   * Update session ID for a tab (e.g., when "new session" is started).
   * Resets `hasPersistedHistory` since the new session has no file on disk yet.
   */
  updateTabSession(tabId: string, sessionId: string): void {
    if (this.data.tabs[tabId]) {
      this.data.tabs[tabId].sessionId = sessionId
      this.data.tabs[tabId].lastActivityAt = new Date().toISOString()
      this.data.tabs[tabId].hasPersistedHistory = false
      this.save()
    }
  }

  /**
   * Mark a tab as having persisted its history to disk. Called after the
   * first `persistHistory` or when an existing file is resumed.
   */
  markTabPersisted(tabId: string): void {
    const tab = this.data.tabs[tabId]
    if (tab && !tab.hasPersistedHistory) {
      tab.hasPersistedHistory = true
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
   * Update worktree assignment for a tab. Pass null to clear.
   */
  updateTabWorktree(tabId: string, worktreePath: string | null, worktreeBranch: string | null): void {
    if (this.data.tabs[tabId]) {
      if (worktreePath) {
        this.data.tabs[tabId].worktreePath = worktreePath
        this.data.tabs[tabId].worktreeBranch = worktreeBranch || undefined
      } else {
        delete this.data.tabs[tabId].worktreePath
        delete this.data.tabs[tabId].worktreeBranch
      }
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
