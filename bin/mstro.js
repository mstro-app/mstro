#!/usr/bin/env node
// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Mstro CLI
 *
 * Main entry point for the Mstro AI assistant.
 *
 * Usage:
 *   mstro                     # Start Mstro (auto-finds available port)
 *   mstro login               # Authenticate this device
 *   mstro logout              # Sign out
 *   mstro whoami              # Show current user
 *   mstro status              # Show connection status
 *   mstro setup-terminal      # Enable web terminal
 *   mstro -p 4105             # Start on specific port (overrides auto port)
 *   mstro configure-hooks     # Configure Claude Code security hooks
 *   mstro --help              # Show help
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import semverGt from 'semver/functions/gt.js';
import updateNotifier from 'update-notifier';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLIENT_ROOT = resolve(__dirname, '..');

// Read package.json for update-notifier
const pkg = JSON.parse(readFileSync(join(CLIENT_ROOT, 'package.json'), 'utf-8'));

// Check for updates (runs async in background, notifies on next run)
const notifier = updateNotifier({
  pkg,
  updateCheckInterval: 1000 * 60 * 60 * 24  // Check daily
});

// Capture the user's original working directory before any cwd changes
const USER_CWD = process.cwd();

// First-run detection paths
const MSTRO_CONFIG_DIR = join(homedir(), '.mstro');
const MSTRO_FIRST_RUN_FLAG = join(MSTRO_CONFIG_DIR, '.configured');
const MSTRO_TERMINAL_CHECKED_FLAG = join(MSTRO_CONFIG_DIR, '.terminal-checked');
const CLAUDE_SETTINGS_FILE = join(homedir(), '.claude', 'settings.json');
const CLAUDE_HOOKS_DIR = join(homedir(), '.claude', 'hooks');
const BOUNCER_HOOK_FILE = join(CLAUDE_HOOKS_DIR, 'bouncer.sh');

/**
 * Mark Mstro as configured by writing the first-run flag file
 */
function markConfigured() {
  try {
    mkdirSync(MSTRO_CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(MSTRO_FIRST_RUN_FLAG, new Date().toISOString());
  } catch (_) {
    // Ignore errors — non-critical
  }
}

/**
 * Set the terminal tab title
 * Format: "mstro: directory_name"
 * Uses ANSI escape sequence: ESC ] 0 ; title BEL
 */
function setTerminalTitle(directory) {
  const dirName = directory.split('/').pop() || directory;
  const title = `mstro: ${dirName}`;
  // ESC ] 0 ; title BEL - sets both window title and tab title
  process.stdout.write(`\x1b]0;${title}\x07`);
}

// Set terminal title on startup
setTerminalTitle(process.cwd());

// ANSI colors
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

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

/**
 * Check if bouncer hooks are properly configured
 * Returns true if both settings.json has the hook AND the hook file exists
 */
function isBouncerConfigured() {
  if (!existsSync(BOUNCER_HOOK_FILE) || !existsSync(CLAUDE_SETTINGS_FILE)) {
    return false;
  }

  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8'));
    const preToolUseHooks = settings.hooks?.PreToolUse;
    return Array.isArray(preToolUseHooks) &&
      preToolUseHooks.some(matcher =>
        Array.isArray(matcher.hooks) &&
        matcher.hooks.some(hook => hook.command?.includes('bouncer.sh'))
      );
  } catch {
    return false;
  }
}

/**
 * Check if user has dismissed the bouncer setup prompt
 */
function hasUserDismissedSetup() {
  return existsSync(MSTRO_FIRST_RUN_FLAG);
}

/**
 * Mark bouncer setup as dismissed by user
 */
function markSetupDismissed() {
  if (!existsSync(MSTRO_CONFIG_DIR)) {
    mkdirSync(MSTRO_CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(MSTRO_FIRST_RUN_FLAG, new Date().toISOString());
}

/**
 * Show a one-line warning that bouncer is not configured
 */
function showBouncerWarning() {
  log('  Security Bouncer not configured. Run: mstro configure-hooks', colors.dim);
}

/**
 * Prompt user to configure hooks
 * Returns: 'configure' | 'skip' | 'never'
 */
async function promptBouncerSetup() {
  log('\n  Welcome to Mstro!\n', colors.bold + colors.cyan);
  log('  Mstro includes a Security Bouncer that automatically manages', colors.dim);
  log('  tool permissions for Claude Code - keeping you safe while you work.\n', colors.dim);

  log('  The Security Bouncer:', colors.bold);
  log('    - Blocks dangerous commands automatically', colors.dim);
  log('    - Allows normal development work without interruption', colors.dim);
  log('    - Uses AI to analyze ambiguous operations\n', colors.dim);

  const isInteractive = process.stdin.isTTY;

  if (!isInteractive) {
    log('  Non-interactive mode: skipping bouncer setup.', colors.yellow);
    log('  Run "mstro configure-hooks" to set up the Security Bouncer.\n', colors.dim);
    return 'skip';
  }

  log('  Configure Security Bouncer now?', colors.bold);
  log('    [Y] Yes, configure now', colors.dim);
  log('    [n] Not now (ask again next time)', colors.dim);
  log('    [d] Don\'t show this again\n', colors.dim);

  const answer = await prompt('  Your choice [Y/n/d]: ');
  const choice = answer.toLowerCase();

  if (choice === '' || choice === 'y' || choice === 'yes') {
    log('');
    return 'configure';
  } else if (choice === 'd' || choice === 'dont' || choice === "don't") {
    log('\n  Got it! You can configure later with: mstro configure-hooks\n', colors.dim);
    markSetupDismissed(); // Don't show full prompt again
    return 'never';
  } else {
    log('\n  Skipping for now. Will ask again next time.', colors.yellow);
    log('  You can also configure with: mstro configure-hooks\n', colors.dim);
    return 'skip';
  }
}

function showHelp() {
  log('\n  Mstro - No-code AI Workspace\n', colors.bold + colors.cyan);
  log('  Run Claude Code workflows from your laptop, cloud VM, or any machine.\n', colors.dim);
  log('  Usage:', colors.bold);
  log('    mstro                       Start Mstro (auto-finds available port)', colors.dim);
  log('    mstro login                 Authenticate this device with mstro.app', colors.dim);
  log('    mstro logout                Sign out of mstro.app', colors.dim);
  log('    mstro whoami                Show current user and device info', colors.dim);
  log('    mstro status                Show connection and auth status', colors.dim);
  log('    mstro telemetry [on|off]    Enable/disable anonymous telemetry', colors.dim);
  log('    mstro setup-terminal        Enable web terminal (compiles native module)', colors.dim);
  log('    mstro -p 4105               Start on specific port (overrides auto port)', colors.dim);
  log('    mstro configure-hooks       Configure Claude Code security hooks', colors.dim);
  log('    mstro --version             Show version number', colors.dim);
  log('    mstro --help                Show this help message', colors.dim);
  log('');
  log('  Options:', colors.bold);
  log('    --port, -p <port>           Override automatic port selection', colors.dim);
  log('    --working-dir, -w <dir>     Set working directory', colors.dim);
  log('    --verbose, -v               Enable verbose output', colors.dim);
  log('');
  log('  Authentication:', colors.bold);
  log('    Run "mstro login" to connect this device to your mstro.app account.', colors.dim);
  log('    Once logged in, orchestras sync automatically with your web dashboard.', colors.dim);
  log('');
  log('  Security:', colors.bold);
  log('    Mstro includes a Security Bouncer that automatically manages', colors.dim);
  log('    tool permissions for Claude Code. It blocks dangerous operations', colors.dim);
  log('    while allowing normal development work to proceed smoothly.', colors.dim);
  log('');
}

function runNpmScript(script, args = [], envOverrides = {}) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmCmd, ['run', script, ...args], {
    cwd: CLIENT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, MSTRO_WORKING_DIR: USER_CWD, ...envOverrides },
  });

  let isShuttingDown = false;

  // Handle Ctrl+C: kill child process and wait for it to exit
  process.on('SIGINT', () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    child.kill('SIGTERM');
    // Don't exit here - let the child's 'exit' event handle process.exit()
  });

  // Change the parent process's working directory back to where the user ran mstro.
  // This ensures that when the terminal opens a new tab based on the active process's
  // cwd, it opens in the user's original directory instead of the npm-linked mstro dir.
  try {
    process.chdir(USER_CWD);
  } catch (_e) {
    // Ignore if directory no longer exists
  }

  child.on('error', (err) => {
    log(`Error: ${err.message}`, colors.red);
    process.exit(1);
  });

  child.on('exit', (code) => {
    // Print a newline to ensure clean prompt after shutdown messages
    if (isShuttingDown) {
      process.stdout.write('\n');
    }
    process.exit(code || 0);
  });
}

function runConfigureHooks(andThenStart = false) {
  const configScript = join(__dirname, 'configure-claude.js');
  const child = spawn('node', [configScript, ...process.argv.slice(3)], {
    cwd: CLIENT_ROOT,
    stdio: 'inherit',
  });

  // Handle Ctrl+C: kill child process and exit immediately
  process.on('SIGINT', () => {
    child.kill('SIGTERM');
    process.exit(0);
  });

  child.on('error', (err) => {
    log(`Error: ${err.message}`, colors.red);
    process.exit(1);
  });

  child.on('exit', (code) => {
    if (code === 0) {
      markConfigured();
      if (andThenStart) {
        // After configuring, start the server
        log('\nStarting Mstro client...', colors.bold + colors.cyan);
        const requestedPort = parsePort(process.argv.slice(2));
        const envOverrides = requestedPort ? { PORT: String(requestedPort) } : {};
        runNpmScript('start', [], envOverrides);
      } else {
        process.exit(0);
      }
    } else {
      process.exit(code || 0);
    }
  });
}

// Parse arguments
const args = process.argv.slice(2);

// Extract --port / -p value
function parsePort(args) {
  const portIndex = args.findIndex(a => a === '--port' || a === '-p');
  if (portIndex !== -1 && args[portIndex + 1]) {
    const port = parseInt(args[portIndex + 1], 10);
    if (!Number.isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
    log(`Invalid port: ${args[portIndex + 1]}`, colors.red);
    process.exit(1);
  }
  return null;
}

/**
 * Show update notification if available
 */
function showUpdateNotification() {
  if (notifier.update && semverGt(notifier.update.latest, notifier.update.current)) {
    const { current, latest, type } = notifier.update;
    const updateCmd = 'npm i -g mstro@latest';

    log('');
    log(`  ${colors.yellow}Update available:${colors.reset} ${colors.dim}${current}${colors.reset} → ${colors.green}${latest}${colors.reset} ${colors.dim}(${type})${colors.reset}`);
    log(`  Run: ${colors.cyan}${updateCmd}${colors.reset}`);
    log('');
  }
}

/**
 * Check if user is logged in
 */
function isLoggedIn() {
  const credentialsFile = join(MSTRO_CONFIG_DIR, 'credentials.json');
  if (!existsSync(credentialsFile)) {
    return false;
  }
  try {
    const creds = JSON.parse(readFileSync(credentialsFile, 'utf-8'));
    return !!(creds.token && creds.userId && creds.email);
  } catch {
    return false;
  }
}

/**
 * Show login required message
 */
function showLoginRequired() {
  log('\n  Authentication required', colors.bold + colors.yellow);
  log('');
  log('  You must be logged in to use mstro.', colors.dim);
  log('  Run "mstro login" to authenticate this device.', colors.dim);
  log('');
}

/**
 * Check if node-pty is loadable (native module compiled correctly)
 */
async function isNodePtyAvailable() {
  try {
    const pty = await import('node-pty');
    // Verify the native module actually works, not just that it imports
    const test = pty.spawn('/bin/echo', ['test'], { name: 'xterm', cols: 80, rows: 24 });
    test.kill();
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to rebuild node-pty silently. Returns true on success.
 */
function tryRebuildNodePty() {
  try {
    execSync('npm rebuild node-pty', { cwd: CLIENT_ROOT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get platform-specific build tool install instructions
 */
function getBuildToolInstructions() {
  const os = osPlatform();
  if (os === 'darwin') {
    return '    xcode-select --install';
  } else if (os === 'win32') {
    return '    npm install -g windows-build-tools';
  } else {
    return '    sudo apt install build-essential python3    # Debian/Ubuntu\n    sudo dnf install gcc-c++ make python3       # Fedora/RHEL';
  }
}

/**
 * First-run terminal setup check (runs after bouncer setup).
 * Tries to rebuild node-pty automatically. If that fails, shows instructions.
 */
async function checkTerminalSetup() {
  if (await isNodePtyAvailable()) {
    return; // Already working
  }

  log('\n  Web Terminal', colors.bold + colors.cyan);
  log('  mstro includes a browser-based terminal (optional).\n', colors.dim);
  log('  Attempting to compile native module...', colors.dim);

  if (tryRebuildNodePty()) {
    log('  Terminal support enabled!\n', colors.green);
    return;
  }

  log('  Could not compile terminal module.\n', colors.yellow);
  log('  To enable the web terminal later:', colors.dim);
  log('  1. Install build tools:', colors.dim);
  log(getBuildToolInstructions(), colors.dim);
  log('  2. Run:', colors.dim);
  log('    mstro setup-terminal\n', colors.dim);
}

/**
 * Explicit setup-terminal command
 */
async function setupTerminal() {
  log('\n  Setting up terminal support...\n', colors.bold + colors.cyan);

  if (await isNodePtyAvailable()) {
    log('  Terminal support is already enabled.\n', colors.green);
    return;
  }

  log('  Rebuilding node-pty native module...', colors.dim);

  if (tryRebuildNodePty()) {
    log('\n  Terminal support enabled! Restart mstro to use it.\n', colors.green + colors.bold);
    return;
  }

  log('\n  Failed to build node-pty.\n', colors.red);
  log('  Install build tools first:', colors.dim);
  log(getBuildToolInstructions(), colors.dim);
  log('\n  Then re-run: mstro setup-terminal\n', colors.dim);
  process.exit(1);
}

async function startServer(envOverrides) {
  if (!isLoggedIn()) {
    showLoginRequired();
    process.exit(1);
  }

  if (!isBouncerConfigured()) {
    if (hasUserDismissedSetup()) {
      showBouncerWarning();
    } else {
      const choice = await promptBouncerSetup();
      if (choice === 'configure') {
        runConfigureHooks(true);
        return;
      }
    }
  }

  if (!existsSync(MSTRO_TERMINAL_CHECKED_FLAG)) {
    await checkTerminalSetup();
    if (!existsSync(MSTRO_CONFIG_DIR)) {
      mkdirSync(MSTRO_CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    writeFileSync(MSTRO_TERMINAL_CHECKED_FLAG, new Date().toISOString());
  }

  showUpdateNotification();
  log('\nStarting Mstro client...', colors.bold + colors.cyan);
  runNpmScript('start', [], envOverrides);
}

async function main() {
  const requestedPort = parsePort(args);
  const isDevMode = args.includes('--dev');
  const envOverrides = {
    ...(requestedPort ? { PORT: String(requestedPort) } : {}),
    ...(isDevMode ? { PLATFORM_URL: 'http://localhost:4102' } : {}),
  };

  const subcommand = args.find(arg => !arg.startsWith('-') && !arg.startsWith('--'));

  // Command dispatch table
  const commands = new Map([
    ['login', async () => {
      const { login } = await import('./commands/login.js');
      await login(args.slice(args.indexOf('login') + 1));
    }],
    ['logout', async () => {
      const { logout } = await import('./commands/logout.js');
      await logout();
    }],
    ['whoami', async () => {
      const { whoami } = await import('./commands/whoami.js');
      await whoami(args.slice(args.indexOf('whoami') + 1));
    }],
    ['status', async () => {
      const { status } = await import('./commands/status.js');
      await status();
    }],
    ['telemetry', async () => {
      const { telemetry } = await import('./commands/config.js');
      await telemetry(args.slice(args.indexOf('telemetry') + 1));
    }],
    ['setup-terminal', () => setupTerminal()],
    ['configure-hooks', () => runConfigureHooks(false)],
  ]);

  // Flag-based commands
  if (args.includes('--version') || args.includes('-V')) {
    log(`mstro v${pkg.version}`);
    showUpdateNotification();
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    showUpdateNotification();
    return;
  }

  if (args.includes('--configure-hooks') || args.includes('-c')) {
    runConfigureHooks(false);
    return;
  }

  // Subcommand dispatch
  const handler = subcommand ? commands.get(subcommand) : undefined;
  if (handler) {
    await handler();
    return;
  }

  // Default: start server
  await startServer(envOverrides);
}

main();
