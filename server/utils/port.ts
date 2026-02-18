// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Port utilities for finding available ports
 *
 * Convention: Frontend uses EVEN ports (3000, 3002, 3004...)
 *             Backend uses ODD ports (3001, 3003, 3005...)
 * This ensures they never compete for the same port.
 */

import { createServer } from 'node:net'

/**
 * Check if a port is available by trying to bind to it
 * Uses '::' (IPv6 any) which also binds IPv4 on most systems,
 * ensuring we detect servers listening on any interface.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()

    server.once('error', () => {
      server.close()
      resolve(false) // Port is in use
    })

    server.once('listening', () => {
      server.close()
      resolve(true) // Port is available
    })

    // Use '::' to bind on all interfaces (IPv4 + IPv6)
    // This ensures we detect servers on any interface
    server.listen(port, '::')
  })
}

/**
 * Check multiple ports in parallel and return the first available one
 */
export async function findFirstAvailablePort(ports: number[]): Promise<number | null> {
  const results = await Promise.all(
    ports.map(async (port) => ({ port, available: await isPortAvailable(port) }))
  )
  const available = results.find(r => r.available)
  return available ? available.port : null
}

/**
 * Find an available port starting from startPort
 */
export async function findAvailablePort(startPort: number, maxTries: number = 20): Promise<number> {
  // Check all ports in parallel for speed
  const ports = Array.from({ length: maxTries }, (_, i) => startPort + i)
  const port = await findFirstAvailablePort(ports)
  if (port !== null) {
    return port
  }
  throw new Error(`No available ports found between ${startPort} and ${startPort + maxTries}`)
}

/**
 * Find an available port pair for frontend and backend
 * Frontend = EVEN port (3000, 3002, 3004...)
 * Backend = ODD port (3001, 3003, 3005...)
 *
 * Checks all candidate ports in parallel for fast detection.
 */
export async function findAvailablePortPair(startPort: number = 3000, maxPairs: number = 20): Promise<{ frontend: number; backend: number }> {
  // Ensure startPort is even
  const basePort = startPort % 2 === 0 ? startPort : startPort + 1

  // Generate all candidate pairs
  const pairs: { frontend: number; backend: number }[] = []
  for (let i = 0; i < maxPairs; i++) {
    pairs.push({
      frontend: basePort + (i * 2),      // 3000, 3002, 3004...
      backend: basePort + (i * 2) + 1    // 3001, 3003, 3005...
    })
  }

  // Check all ports in parallel (both frontend and backend ports)
  const allPorts = pairs.flatMap(p => [p.frontend, p.backend])
  const results = await Promise.all(
    allPorts.map(async (port) => ({ port, available: await isPortAvailable(port) }))
  )

  // Build a set of available ports for O(1) lookup
  const availablePorts = new Set(
    results.filter(r => r.available).map(r => r.port)
  )

  // Find first pair where both ports are available
  for (const pair of pairs) {
    if (availablePorts.has(pair.frontend) && availablePorts.has(pair.backend)) {
      return pair
    }
  }

  throw new Error(`No available port pairs found starting from ${startPort}`)
}
