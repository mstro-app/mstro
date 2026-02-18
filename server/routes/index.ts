// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Routes Index
 *
 * Re-exports all route creators for easy importing.
 */

export { createFileRoutes } from './files.js'
export { createImproviseRoutes } from './improvise.js'
export { createInstanceRoutes, createShutdownRoute } from './instances.js'
export { createNotificationRoutes } from './notifications.js'
