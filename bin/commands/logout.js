/**
 * mstro logout command
 *
 * Signs out of the current mstro.app account and removes local credentials.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROD_PLATFORM_URL = 'https://api.mstro.app';
const STAGING_PLATFORM_URL = 'https://api.staging.mstro.app';
const DEV_PLATFORM_URL = 'http://localhost:4102';

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

function credentialsFile() {
  const env = process.env.MSTRO_ENV || 'production';
  if (env === 'staging') return join(MSTRO_DIR, 'credentials-staging.json');
  if (env === 'dev') return join(MSTRO_DIR, 'credentials-dev.json');
  return join(MSTRO_DIR, 'credentials.json');
}

/**
 * Get stored credentials
 */
function getCredentials() {
  if (!existsSync(credentialsFile())) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(credentialsFile(), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Deregister device from the platform server
 */
async function deregisterDevice(token, platformUrl) {
  try {
    const response = await fetch(`${platformUrl}/api/auth/device/deregister`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      log(`  Warning: Could not deregister device from server: ${data.error || response.statusText}`, colors.yellow);
    }
  } catch {
    // Network error - proceed with local logout anyway
    log('  Warning: Could not reach server to deregister device. Local credentials will still be removed.', colors.yellow);
  }
}

/**
 * Main logout command
 */
export async function logout(args = []) {
  const devMode = Array.isArray(args) && args.includes('--dev');
  const stagingMode = Array.isArray(args) && args.includes('--staging');
  const platformUrl = devMode ? DEV_PLATFORM_URL : stagingMode ? STAGING_PLATFORM_URL : PROD_PLATFORM_URL;

  log('\n  Mstro Logout\n', colors.bold + colors.cyan);

  const creds = getCredentials();

  if (!creds) {
    log('  Not currently logged in.', colors.yellow);
    log('  Use "mstro login" to sign in.\n', colors.dim);
    return;
  }

  const email = creds.email;

  try {
    // Deregister device from server so it can be re-registered later
    if (creds.token) {
      await deregisterDevice(creds.token, platformUrl);
    }

    // Delete credentials file
    if (existsSync(credentialsFile())) {
      unlinkSync(credentialsFile());
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
