/**
 * mstro status command
 *
 * Shows the status of the mstro CLI including:
 * - Login status
 * - Platform connection status
 * - Device information
 */

import { existsSync, readFileSync } from 'node:fs';
import { arch, homedir, hostname, type } from 'node:os';
import { join } from 'node:path';

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
const CREDENTIALS_FILE = join(MSTRO_DIR, 'credentials.json');
const CLIENT_ID_FILE = join(MSTRO_DIR, 'client-id');
const PLATFORM_URL = process.env.PLATFORM_URL || 'https://api.mstro.app';

/**
 * Get stored credentials
 */
function getCredentials() {
  if (!existsSync(CREDENTIALS_FILE)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Get client ID
 */
function getClientId() {
  if (!existsSync(CLIENT_ID_FILE)) {
    return null;
  }
  try {
    return readFileSync(CLIENT_ID_FILE, 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * Check platform health
 */
async function checkPlatform() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${PLATFORM_URL}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      return { online: true, data };
    }

    return { online: false, error: `HTTP ${response.status}` };
  } catch (err) {
    return { online: false, error: err.name === 'AbortError' ? 'Timeout' : err.message };
  }
}

/**
 * Verify token with platform
 */
async function verifyToken(token) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${PLATFORM_URL}/api/auth/device/verify`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const data = await response.json();
      return { valid: false, error: data.error };
    }

    return await response.json();
  } catch (err) {
    return { valid: false, error: err.name === 'AbortError' ? 'Timeout' : err.message };
  }
}

/**
 * Main status command
 */
export async function status() {
  log('\n  Mstro Status\n', colors.bold + colors.cyan);

  const creds = getCredentials();
  const clientId = getClientId();

  // Device info
  log('  Device', colors.bold);
  log(`    Hostname:   ${hostname()}`, colors.dim);
  log(`    OS:         ${type()} (${arch()})`, colors.dim);
  log(`    Node:       ${process.version}`, colors.dim);
  log(`    Client ID:  ${clientId ? `${clientId.slice(0, 8)}...` : 'Not set'}`, colors.dim);
  log('');

  // Platform status
  log('  Platform', colors.bold);
  log(`    URL:        ${PLATFORM_URL}`, colors.dim);

  process.stdout.write('    Status:     Checking...');

  const platformStatus = await checkPlatform();

  process.stdout.write('\r                              \r'); // Clear line

  if (platformStatus.online) {
    log(`    Status:     ${colors.green}Online${colors.reset}`, colors.dim);
    if (platformStatus.data?.relay) {
      const relay = platformStatus.data.relay;
      log(`    Orchestras: ${relay.pairedClients || 0} connected`, colors.dim);
    }
  } else {
    log(`    Status:     ${colors.red}Offline${colors.reset} (${platformStatus.error})`, colors.dim);
  }

  log('');

  // Auth status
  log('  Authentication', colors.bold);

  if (!creds) {
    log(`    Status:     ${colors.yellow}Not logged in${colors.reset}`, colors.dim);
    log('');
    log('  Run "mstro login" to authenticate this device.', colors.dim);
    log('');
    return;
  }

  log(`    Email:      ${creds.email}`, colors.dim);

  if (platformStatus.online) {
    process.stdout.write('    Session:    Verifying...');

    const tokenStatus = await verifyToken(creds.token);

    process.stdout.write('\r                              \r');

    if (tokenStatus.valid) {
      log(`    Session:    ${colors.green}Valid${colors.reset}`, colors.dim);
    } else {
      log(`    Session:    ${colors.red}Invalid${colors.reset} (${tokenStatus.error})`, colors.dim);
      log('');
      log('  Run "mstro login" to re-authenticate.', colors.dim);
    }
  } else {
    log(`    Session:    ${colors.yellow}Cannot verify (platform offline)${colors.reset}`, colors.dim);
  }

  log('');

  // Quick commands
  log('  Commands', colors.bold);
  log('    mstro           Start an orchestra', colors.dim);
  log('    mstro login     Sign in to your account', colors.dim);
  log('    mstro logout    Sign out', colors.dim);
  log('    mstro whoami    Show account details', colors.dim);
  log('');
}

export default status;
