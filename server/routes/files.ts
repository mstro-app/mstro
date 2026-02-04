// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * File Routes
 *
 * Handles file listing and autocomplete.
 */

import { Hono } from 'hono'
import type { FileService } from '../services/files.js'

export function createFileRoutes(fileService: FileService) {
  const routes = new Hono()

  routes.get('/', (c) => {
    try {
      const filter = c.req.query('filter') || ''
      const baseDir = (c.req.query('baseDir') || 'scores') as 'working' | 'scores'

      const files = fileService.getAllFiles(baseDir, filter)
      return c.json({ files })
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500)
    }
  })

  return routes
}
