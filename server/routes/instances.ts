// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Instance Management Routes
 *
 * Handles server instance discovery and management.
 */

import { Hono } from 'hono'
import { getClientId } from '../services/client-id.js'
import { InstanceRegistry } from '../services/instances.js'

export function createInstanceRoutes(instanceRegistry: InstanceRegistry) {
  const routes = new Hono()

  routes.get('/', (c) => {
    try {
      const instances = InstanceRegistry.getAllInstances()
      return c.json({ instances })
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500)
    }
  })

  routes.get('/current', (c) => {
    try {
      const instance = instanceRegistry.getCurrentInstance()
      return c.json({
        instance,
        clientId: getClientId()
      })
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500)
    }
  })

  return routes
}

export function createShutdownRoute(instanceRegistry: InstanceRegistry) {
  const routes = new Hono()

  routes.post('/', (c) => {
    setTimeout(() => {
      instanceRegistry.unregister()
      process.exit(0)
    }, 100)

    return c.json({ success: true, message: 'Shutting down...' })
  })

  return routes
}
