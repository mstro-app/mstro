// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * mstro telemetry command
 *
 * Enable or disable anonymous telemetry (error reporting and usage analytics).
 *
 * Usage:
 *   mstro telemetry           Show current status
 *   mstro telemetry on        Enable telemetry
 *   mstro telemetry off       Disable telemetry
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
};

function log(msg, color = '') {
  console.log(`${color}${msg}${colors.reset}`);
}

const MSTRO_DIR = join(homedir(), '.mstro');
const CONFIG_FILE = join(MSTRO_DIR, 'config.json');

/**
 * Read current config
 */
function readConfig() {
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Write config
 */
function writeConfig(config) {
  if (!existsSync(MSTRO_DIR)) {
    mkdirSync(MSTRO_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Parse on/off value
 */
function parseOnOff(value) {
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'on' || lower === 'yes' || lower === 'enable') {
    return true;
  }
  if (lower === 'false' || lower === '0' || lower === 'off' || lower === 'no' || lower === 'disable') {
    return false;
  }
  return null;
}

function showStatus() {
  const config = readConfig();
  const envDisabled = process.env.MSTRO_TELEMETRY === '0' || process.env.MSTRO_TELEMETRY === 'false';
  const configEnabled = config.telemetry !== false;

  log('\n  Telemetry Status\n', colors.bold + colors.cyan);

  if (envDisabled) {
    log('  Status: disabled (via MSTRO_TELEMETRY env var)', colors.yellow);
  } else if (!configEnabled) {
    log('  Status: disabled', colors.yellow);
  } else {
    log('  Status: enabled', colors.green);
  }

  log('');
  log('  Mstro collects anonymous error reports and usage data', colors.dim);
  log('  to improve the software. No personal data or code is collected.', colors.dim);
  log('');
  log('  Usage:', colors.bold);
  log('    mstro telemetry on     Enable telemetry', colors.dim);
  log('    mstro telemetry off    Disable telemetry', colors.dim);
  log('');
  log('  Privacy policy: https://github.com/mstro-app/mstro/blob/main/cli/PRIVACY.md', colors.dim);
  log('');
}

function setTelemetry(enabled) {
  const config = readConfig();
  config.telemetry = enabled;
  writeConfig(config);

  if (enabled) {
    log('\n  Telemetry enabled', colors.green);
    log('  Thank you for helping improve mstro!\n', colors.dim);
  } else {
    log('\n  Telemetry disabled', colors.yellow);
    log('  No data will be sent.\n', colors.dim);
  }
}

/**
 * Main telemetry command
 */
export async function telemetry(args = []) {
  const action = args[0];

  if (!action) {
    showStatus();
    return;
  }

  if (action === '--help' || action === '-h') {
    showStatus();
    return;
  }

  const value = parseOnOff(action);
  if (value === null) {
    log(`\n  Unknown option: ${action}`, colors.red);
    log('  Usage: mstro telemetry [on|off]\n', colors.dim);
    process.exit(1);
  }

  setTelemetry(value);
}

// Keep 'config' as alias for backwards compatibility
export { telemetry as config };

export default telemetry;
