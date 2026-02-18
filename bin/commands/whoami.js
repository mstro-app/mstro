/**
 * mstro whoami command
 *
 * Shows the currently logged in user and device information.
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
 * Verify token with platform and get fresh user info
 */
async function verifyToken(token) {
  try {
    const response = await fetch(`${PLATFORM_URL}/api/auth/device/verify`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const data = await response.json();
      return { valid: false, error: data.error };
    }

    return await response.json();
  } catch (_err) {
    return { valid: false, error: 'Network error' };
  }
}

/**
 * Format date nicely
 */
function formatDate(dateStr) {
  if (!dateStr) return 'Unknown';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Main whoami command
 */
export async function whoami(args = []) {
  const verbose = args.includes('--verbose') || args.includes('-v');

  log('\n  Mstro Account\n', colors.bold + colors.cyan);

  const creds = getCredentials();
  const clientId = getClientId();

  if (!creds) {
    log('  Not logged in.', colors.yellow);
    log('  Use "mstro login" to sign in.\n', colors.dim);
    process.exit(1);
  }

  // Verify with platform (unless --offline flag)
  const offline = args.includes('--offline');
  let verified = null;

  if (!offline) {
    process.stdout.write('  Verifying with server...');
    verified = await verifyToken(creds.token);

    if (!verified.valid) {
      console.log('');
      log('');
      log(`  Session invalid: ${verified.error}`, colors.red);
      log('  Use "mstro login" to re-authenticate.\n', colors.dim);
      process.exit(1);
    }

    process.stdout.write('\r                            \r'); // Clear the line
  }

  // Display user info
  const user = verified?.user || creds;

  log(`  Email:    ${user.email}`, colors.bold);
  if (user.name) {
    log(`  Name:     ${user.name}`, colors.dim);
  }

  log('');
  log('  Device Information', colors.bold);
  log(`  Hostname: ${hostname()}`, colors.dim);
  log(`  OS:       ${type()} (${arch()})`, colors.dim);
  log(`  Node:     ${process.version}`, colors.dim);

  if (verbose) {
    log('');
    log('  Credentials', colors.bold);
    log(`  Client ID:  ${clientId || 'Not set'}`, colors.dim);
    log(`  Logged in:  ${formatDate(creds.createdAt)}`, colors.dim);
    if (creds.lastRefreshedAt) {
      log(`  Refreshed:  ${formatDate(creds.lastRefreshedAt)}`, colors.dim);
    }
    log(`  Creds file: ${CREDENTIALS_FILE}`, colors.dim);
  }

  log('');
}

export default whoami;
