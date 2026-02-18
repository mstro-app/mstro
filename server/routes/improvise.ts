// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Improvise History Routes
 *
 * Handles improvise session history retrieval.
 */

import { join } from 'node:path'
import { Hono } from 'hono'

export function createImproviseRoutes(workingDir: string) {
  const routes = new Hono()

  routes.get('/sessions', async (c) => {
    try {
      const sessionsDir = join(workingDir, '.mstro', 'improvise')
      const { readdirSync, existsSync, readFileSync } = await import('node:fs')

      if (!existsSync(sessionsDir)) {
        return c.json({ sessions: [] })
      }

      // Look for history-*.json files in the improvise directory
      const historyFiles = readdirSync(sessionsDir)
        .filter((name: string) => name.startsWith('history-') && name.endsWith('.json'))
        .sort((a: string, b: string) => {
          // Sort by timestamp in filename (newer first)
          const timestampA = parseInt(a.replace('history-', '').replace('.json', ''), 10)
          const timestampB = parseInt(b.replace('history-', '').replace('.json', ''), 10)
          return timestampB - timestampA
        })

      const sessions = historyFiles.map((filename: string) => {
        const historyPath = join(sessionsDir, filename)

        try {
          const historyData = JSON.parse(readFileSync(historyPath, 'utf-8'))
          const firstPrompt = historyData.movements?.[0]?.userPrompt || ''

          return {
            sessionId: historyData.sessionId,
            startedAt: historyData.startedAt,
            lastActivityAt: historyData.lastActivityAt,
            totalTokens: historyData.totalTokens,
            movementCount: historyData.movements?.length || 0,
            title: firstPrompt.slice(0, 80) + (firstPrompt.length > 80 ? '...' : ''),
            movements: historyData.movements || []
          }
        } catch {
          return null
        }
      }).filter(Boolean)

      return c.json({ sessions })
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500)
    }
  })

  routes.get('/sessions/:sessionId', async (c) => {
    try {
      const { sessionId } = c.req.param()
      // Extract timestamp from sessionId (e.g., "improv-1234567890" -> "1234567890")
      const timestamp = sessionId.replace('improv-', '')
      const historyPath = join(workingDir, '.mstro', 'improvise', `history-${timestamp}.json`)
      const { existsSync, readFileSync } = await import('node:fs')

      if (!existsSync(historyPath)) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const historyData = JSON.parse(readFileSync(historyPath, 'utf-8'))
      return c.json(historyData)
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500)
    }
  })

  return routes
}
