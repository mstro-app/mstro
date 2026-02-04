// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Port Manager - Finds available ports for Mstro instances
 *
 * Handles port discovery when multiple Mstro instances run on the same machine.
 * Tries a range of ports starting from the default until an available one is found.
 */

import { createServer } from 'node:net'

const DEFAULT_PORT = 3001
const MAX_PORT_ATTEMPTS = 10

/**
 * Check if a port is available
 */
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()

    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false)
      } else {
        resolve(false)
      }
    })

    server.once('listening', () => {
      server.close()
      resolve(true)
    })

    server.listen(port)
  })
}

/**
 * Find an available port starting from the default port
 * Tries ports: 3001, 3002, 3003, ... up to 3010
 */
export async function findAvailablePort(startPort: number = DEFAULT_PORT): Promise<number> {
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const port = startPort + i
    const available = await isPortAvailable(port)

    if (available) {
      return port
    }

  }

  throw new Error(`Could not find available port after ${MAX_PORT_ATTEMPTS} attempts (tried ${startPort}-${startPort + MAX_PORT_ATTEMPTS - 1})`)
}

/**
 * Get the default port from environment or use 3001
 */
export function getDefaultPort(): number {
  const envPort = process.env.PORT
  if (envPort) {
    const parsed = parseInt(envPort, 10)
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed
    }
  }
  return DEFAULT_PORT
}
