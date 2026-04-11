// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Path Utilities for Mstro Package
 *
 * Provides consistent path resolution for installed npm package.
 * Works correctly whether running from source or installed globally.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ES module equivalent of __dirname for this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Root directory of the mstro package installation.
 * This is the directory containing package.json.
 *
 * Structure: /path/to/mstro/server/utils/paths.ts
 * So we go up 2 levels: utils -> server -> mstro root
 */
export const MSTRO_ROOT = resolve(__dirname, '../..');

/**
 * Path to the MCP bouncer server script
 */
export const MCP_SERVER_PATH = resolve(MSTRO_ROOT, 'server/mcp/server.ts');

/**
 * Walk up from startDir looking for `.claude/skills/`. Returns the path if found, null otherwise.
 */
export function findSkillsDir(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, '.claude', 'skills');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

