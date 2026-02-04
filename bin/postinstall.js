#!/usr/bin/env node

// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Postinstall script for Mstro
 *
 * Fixes permissions for native dependencies after npm install.
 */

import { chmodSync, existsSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MSTRO_ROOT = resolve(__dirname, '..');

/**
 * Ensures node-pty's spawn-helper binary has execute permission.
 * npm pack / monorepo extraction can strip the +x bit, causing
 * "posix_spawnp failed" at runtime.
 */
function fixNodePtyPermissions() {
  const os = platform();
  if (os === 'win32') return;

  const arch = process.arch; // 'arm64' or 'x64'
  const spawnHelper = join(
    MSTRO_ROOT, 'node_modules', 'node-pty', 'prebuilds',
    `darwin-${arch}`, 'spawn-helper'
  );

  if (existsSync(spawnHelper)) {
    try {
      chmodSync(spawnHelper, 0o755);
    } catch (_) {
      // Non-fatal — user may not have node-pty installed
    }
  }
}

fixNodePtyPermissions();
