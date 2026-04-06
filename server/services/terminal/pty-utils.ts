// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * PTY Utilities — node-pty loading, shell detection, scrollback buffer, and types.
 *
 * Separated from pty-manager.ts so the PTYManager class stays focused
 * on session lifecycle orchestration.
 */

import { execSync } from 'node:child_process';
import { accessSync, constants as fsConstants, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { platform } from 'node:os';

// ── node-pty loading ──────────────────────────────────────────

// Try to load node-pty (optional native dependency)
let pty: typeof import('node-pty') | null = null;
let _ptyLoadError: string | null = null;

try {
  pty = await import('node-pty');
} catch (error: unknown) {
  _ptyLoadError = error instanceof Error ? error.message : 'Failed to load node-pty';
  console.warn('[PTYManager] node-pty not available - terminal features disabled');
  console.warn('[PTYManager] To enable terminals, run: mstro setup-terminal');
}

export function getPty(): typeof import('node-pty') | null {
  return pty;
}

/**
 * Check if node-pty is available
 */
export function isPtyAvailable(): boolean {
  return pty !== null;
}

/**
 * Re-attempt loading node-pty at runtime.
 * Called after `mstro setup-terminal` compiles the native module
 * so the running server can pick it up without a restart.
 *
 * Uses createRequire (CJS) to bypass ESM's module cache — a failed
 * ESM import is permanently cached, but CJS require cache entries
 * can be deleted and re-required.
 */
export async function reloadPty(): Promise<boolean> {
  if (pty) return true;
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('node-pty');
    delete require.cache[resolved];
    pty = require('node-pty');
    _ptyLoadError = null;
    console.log('[PTYManager] node-pty loaded successfully after reload');
    return true;
  } catch (error: unknown) {
    _ptyLoadError = error instanceof Error ? error.message : 'Failed to load node-pty';
    return false;
  }
}

/**
 * Get installation instructions for node-pty based on platform
 */
export function getPtyInstallInstructions(): string {
  const os = platform();

  let instructions = `Terminal feature requires native compilation of node-pty.\n\n`;
  instructions += `To enable this feature:\n\n`;

  if (os === 'darwin') {
    instructions += `1. Install Xcode Command Line Tools:\n`;
    instructions += `   xcode-select --install\n\n`;
  } else if (os === 'win32') {
    instructions += `1. Install Windows Build Tools:\n`;
    instructions += `   npm install -g windows-build-tools\n\n`;
  } else {
    instructions += `1. Install build tools:\n`;
    instructions += `   # Debian/Ubuntu:\n`;
    instructions += `   sudo apt install build-essential python3\n\n`;
    instructions += `   # Fedora/RHEL:\n`;
    instructions += `   sudo dnf install gcc-c++ make python3\n\n`;
    instructions += `   # Arch:\n`;
    instructions += `   sudo pacman -S base-devel python\n\n`;
  }

  instructions += `2. Rebuild native modules:\n`;
  instructions += `   npm rebuild node-pty\n\n`;
  instructions += `3. Restart mstro\n`;

  return instructions;
}

// ── Shell detection ───────────────────────────────────────────

/**
 * Detect the user's default shell
 */
export function detectShell(): string {
  const shell = process.env.SHELL;
  if (shell) return shell;
  if (platform() === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return '/bin/bash';
}

/**
 * Get shell name from path
 */
export function getShellName(shellPath: string): string {
  const parts = shellPath.split(/[/\\]/);
  return parts[parts.length - 1] || 'shell';
}

// ── Bubblewrap (bwrap) sandbox detection ─────────────────────

let _bwrapAvailable: boolean | null = null;

/**
 * Check if bubblewrap (bwrap) is available for filesystem sandboxing.
 * Required for sandboxed terminal sessions (shared "can control" users).
 * Caches the result after first check.
 */
export function isBwrapAvailable(): boolean {
  if (_bwrapAvailable !== null) return _bwrapAvailable;

  if (platform() !== 'linux') {
    _bwrapAvailable = false;
    return false;
  }

  try {
    accessSync('/usr/bin/bwrap', fsConstants.X_OK);
    execSync('bwrap --ro-bind / / -- /bin/true', { timeout: 5000, stdio: 'ignore' });
    _bwrapAvailable = true;
  } catch {
    _bwrapAvailable = false;
  }
  return _bwrapAvailable;
}

/**
 * Build bwrap arguments to sandbox a shell to a specific directory.
 * Provides read-only access to system directories, read-write to the project dir only.
 */
export function buildBwrapArgs(cwd: string, shell: string): string[] {
  const mergedUsr = (() => {
    try { return lstatSync('/bin').isSymbolicLink(); }
    catch { return false; }
  })();

  const args: string[] = [
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/etc', '/etc',
    // Hide sensitive /etc files by binding /dev/null over them
    '--ro-bind', '/dev/null', '/etc/shadow',
    '--ro-bind', '/dev/null', '/etc/gshadow',
  ];

  if (mergedUsr) {
    // Merged-usr distros (Fedora, Ubuntu 20.04+, Arch, Debian 12+)
    args.push('--symlink', 'usr/bin', '/bin');
    args.push('--symlink', 'usr/sbin', '/sbin');
    args.push('--symlink', 'usr/lib', '/lib');
    try { lstatSync('/lib64'); args.push('--symlink', 'usr/lib64', '/lib64'); } catch { /* skip */ }
  } else {
    args.push('--ro-bind', '/bin', '/bin');
    args.push('--ro-bind', '/sbin', '/sbin');
    args.push('--ro-bind', '/lib', '/lib');
    try { lstatSync('/lib64'); args.push('--ro-bind', '/lib64', '/lib64'); } catch { /* skip */ }
  }

  args.push(
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/run',
    // Read-write access to the project directory only
    '--bind', cwd, cwd,
    '--unshare-pid',
    '--unshare-ipc',
    '--die-with-parent',
    '--chdir', cwd,
    '--',
    shell,
  );

  return args;
}

// ── Scrollback buffer ─────────────────────────────────────────

export const SCROLLBACK_MAX_BYTES = 256 * 1024; // 256KB

/**
 * Fixed-size buffer that retains the most recent PTY output for replay on reconnect.
 * Stores raw string chunks and evicts oldest data when the total exceeds maxBytes.
 */
export class ScrollbackBuffer {
  private chunks: string[] = [];
  private totalLength = 0;
  private maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  append(data: string): void {
    this.chunks.push(data);
    this.totalLength += data.length;
    while (this.totalLength > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.totalLength -= removed.length;
    }
    if (this.totalLength > this.maxBytes && this.chunks.length === 1) {
      const excess = this.totalLength - this.maxBytes;
      this.chunks[0] = this.chunks[0].slice(excess);
      this.totalLength = this.chunks[0].length;
    }
  }

  getContents(): string {
    return this.chunks.join('');
  }

  clear(): void {
    this.chunks = [];
    this.totalLength = 0;
  }
}

// ── Types ─────────────────────────────────────────────────────

// Import type separately for type-checking (doesn't require the module to load)
type IPty = import('node-pty').IPty;

export interface PTYSession {
  id: string;
  pty: IPty;
  shell: string;
  cwd: string;
  createdAt: number;
  lastActivityAt: number;
  cols: number;
  rows: number;
  _outputBuffer: string;
  _outputTimer: ReturnType<typeof setTimeout> | null;
  scrollback: ScrollbackBuffer;
}
