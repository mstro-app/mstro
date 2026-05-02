/**
 * mstro login command
 *
 * Authenticates this device with the user's mstro.app account using device code flow.
 *
 * Flow:
 * 1. Request device code from platform
 * 2. Open browser to authorization URL
 * 3. Poll platform until user approves
 * 4. Save credentials locally
 */

import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, homedir, hostname, type } from 'node:os';
import { join } from 'node:path';

// Colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
};

function log(msg, color = '') {
  console.log(`${color}${msg}${colors.reset}`);
}

const MSTRO_DIR = join(homedir(), '.mstro');
const CLIENT_ID_FILE = join(MSTRO_DIR, 'client-id');
const PROD_PLATFORM_URL = 'https://api.mstro.app';
const STAGING_PLATFORM_URL = 'https://api.staging.mstro.app';
const DEV_PLATFORM_URL = 'http://localhost:4102';

function credentialsFile() {
  const env = process.env.MSTRO_ENV || 'production';
  if (env === 'staging') return join(MSTRO_DIR, 'credentials-staging.json');
  if (env === 'dev') return join(MSTRO_DIR, 'credentials-dev.json');
  return join(MSTRO_DIR, 'credentials.json');
}

/**
 * Get or create client ID
 */
function getClientId() {
  if (!existsSync(MSTRO_DIR)) {
    mkdirSync(MSTRO_DIR, { recursive: true, mode: 0o700 });
  }

  if (existsSync(CLIENT_ID_FILE)) {
    try {
      const id = readFileSync(CLIENT_ID_FILE, 'utf-8').trim();
      if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        return id;
      }
    } catch {
      // Generate new
    }
  }

  const newId = crypto.randomUUID();
  writeFileSync(CLIENT_ID_FILE, newId, 'utf-8');
  return newId;
}

/**
 * Check if already logged in
 */
function isLoggedIn() {
  if (!existsSync(credentialsFile())) {
    return false;
  }

  try {
    const creds = JSON.parse(readFileSync(credentialsFile(), 'utf-8'));
    return !!(creds.token && creds.userId && creds.email);
  } catch {
    return false;
  }
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
 * Save credentials
 */
function saveCredentials(creds) {
  if (!existsSync(MSTRO_DIR)) {
    mkdirSync(MSTRO_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(credentialsFile(), JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/**
 * Open URL in default browser
 */
function openBrowser(url) {
  // Validate URL to prevent command injection via malicious server responses
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    log(`\n  Invalid URL received. Please open this URL manually:`, colors.yellow);
    log(`  ${url}\n`, colors.cyan);
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    log(`\n  Unexpected URL protocol. Please open this URL manually:`, colors.yellow);
    log(`  ${url}\n`, colors.cyan);
    return;
  }

  const platform = process.platform;
  let cmd;

  if (platform === 'darwin') {
    cmd = `open "${parsed.href}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${parsed.href}"`;
  } else {
    cmd = `xdg-open "${parsed.href}"`;
  }

  exec(cmd, (err) => {
    if (err) {
      log(`\n  Could not open browser automatically.`, colors.yellow);
      log(`  Please open this URL manually:`, colors.dim);
      log(`  ${url}\n`, colors.cyan);
    }
  });
}

/**
 * Request device code from platform
 */
async function requestDeviceCode(clientId, platformUrl, force = false) {
  const machineHostname = hostname();
  const osType = type().toLowerCase();
  const cpuArch = arch();
  const nodeVersion = process.version;

  const response = await fetch(`${platformUrl}/api/auth/device/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      machineHostname,
      osType,
      cpuArch,
      nodeVersion,
      ...(force ? { force: true } : {}),
    }),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_e) {
    throw new Error(`Server returned invalid JSON (status ${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(data.error || data.message || 'Failed to request device code');
  }

  return data;
}

/**
 * Poll for authorization result
 */
async function pollForAuth(deviceCode, interval, platformUrl, maxAttempts = 180) {
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    attempts++;

    try {
      const response = await fetch(`${platformUrl}/api/auth/device/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_e) {
        throw new Error(`Server returned invalid JSON (status ${response.status}): ${text.slice(0, 200)}`);
      }

      if (response.ok) {
        // Success!
        return data;
      }

      // Handle specific error codes
      switch (data.error) {
        case 'authorization_pending':
          // Still waiting, continue polling
          process.stdout.write('.');
          break;

        case 'expired_token':
          throw new Error('Authorization request expired. Please try again.');

        case 'access_denied':
          throw new Error('Authorization denied by user.');

        default:
          throw new Error(data.error || 'Unknown error during authorization');
      }
    } catch (err) {
      if (err.message.includes('fetch')) {
        // Network error, retry
        process.stdout.write('x');
      } else {
        throw err;
      }
    }
  }

  throw new Error('Authorization timed out. Please try again.');
}

/**
 * Deregister old device before force re-auth
 */
async function deregisterOldDevice(platformUrl) {
  const existingCreds = getCredentials();
  if (!existingCreds?.token) return;
  try {
    await fetch(`${platformUrl}/api/auth/device/deregister`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${existingCreds.token}`,
      },
    });
  } catch {
    // Deregister failed (e.g. network issue), force flag on request will handle it
  }
}

/**
 * Run the device code authorization flow. Throws on failure.
 */
async function runDeviceCodeFlow(clientId, platformUrl, forceReauth) {
  const { deviceCode, userCode, verificationUrlComplete, interval } = await requestDeviceCode(clientId, platformUrl, forceReauth);

  log(`Your authorization code: ${userCode}`, colors.bold);
  log('');
  log('Opening browser to complete login...', colors.dim);
  log(` If browser doesn't open, visit: ${verificationUrlComplete}`, colors.dim);
  log('');

  openBrowser(verificationUrlComplete);

  log('  Waiting for authorization', colors.dim);
  process.stdout.write('  ');

  const result = await pollForAuth(deviceCode, interval, platformUrl);

  const credentials = {
    token: result.accessToken,
    userId: result.user.id,
    email: result.user.email,
    name: result.user.name,
    clientId,
    createdAt: new Date().toISOString(),
  };

  saveCredentials(credentials);
  return result;
}

/**
 * Main login command
 *
 * @param {string[]} args - CLI arguments
 * @param {object} options
 * @param {boolean} options.inline - When true, called from startServer() auto-login:
 *   skips "already logged in" check, omits post-login tips, and throws on failure
 *   instead of calling process.exit(1).
 */
export async function login(args = [], options = {}) {
  const { inline = false } = options;
  const forceReauth = args.includes('--force') || args.includes('-f');
  const devMode = args.includes('--dev');
  const stagingMode = args.includes('--staging');
  const platformUrl = devMode ? DEV_PLATFORM_URL : stagingMode ? STAGING_PLATFORM_URL : PROD_PLATFORM_URL;

  if (devMode) {
    log(`[DEV MODE] Using ${platformUrl}\n`, colors.yellow);
  } else if (stagingMode) {
    log(`[STAGING] Using ${platformUrl}\n`, colors.yellow);
  }

  // Check if already logged in (skip when called inline — caller already checked)
  if (!inline && isLoggedIn() && !forceReauth) {
    const creds = getCredentials();
    log(`  Already logged in as ${creds.email}`, colors.green);
    log(`  Use "mstro logout" to sign out, or "mstro login --force" to re-authenticate.\n`, colors.dim);
    return;
  }

  const clientId = getClientId();

  if (forceReauth) {
    await deregisterOldDevice(platformUrl);
  }

  log('Requesting authorization...', colors.dim);

  try {
    const result = await runDeviceCodeFlow(clientId, platformUrl, forceReauth);

    log('');
    log('');
    log(`  Logged in as ${result.user.email}`, colors.bold + colors.green);
    log('');

    if (!inline) {
      log('  Run "mstro" to start a machine.', colors.cyan);
      log('');

      // Check if node-pty is available, show tip if not
      try {
        await import('node-pty');
      } catch {
        log('  Tip: Terminal support requires native compilation.', colors.dim);
        log('  Run "mstro setup-terminal" to enable web terminal.\n', colors.dim);
      }
    }
  } catch (err) {
    if (inline) {
      throw err;
    }
    log('');
    log(`  Login failed: ${err.message}`, colors.red);
    log('');
    process.exit(1);
  }
}

export default login;
