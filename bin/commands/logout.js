/**
 * mstro logout command
 *
 * Signs out of the current mstro.app account and removes local credentials.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
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
 * Main logout command
 */
export async function logout() {
  log('\n  Mstro Logout\n', colors.bold + colors.cyan);

  const creds = getCredentials();

  if (!creds) {
    log('  Not currently logged in.', colors.yellow);
    log('  Use "mstro login" to sign in.\n', colors.dim);
    return;
  }

  const email = creds.email;

  try {
    // Delete credentials file
    if (existsSync(CREDENTIALS_FILE)) {
      unlinkSync(CREDENTIALS_FILE);
    }

    log(`  Logged out from ${email}`, colors.green);
    log('');
    log('  Your device credentials have been removed.', colors.dim);
    log('  Use "mstro login" to sign in again.\n', colors.dim);
  } catch (err) {
    log(`  Failed to logout: ${err.message}`, colors.red);
    log('');
    process.exit(1);
  }
}

export default logout;
