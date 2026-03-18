// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * PTY Manager - Manages pseudo-terminal sessions for shell access
 *
 * Provides terminal emulation for running shell commands on the local machine.
 * Each terminal session is managed independently with its own PTY process.
 *
 * Supports session persistence:
 * - Sessions survive WebSocket disconnections
 * - Scrollback buffer is maintained for replay on reconnect
 * - Sessions can be reattached without losing running processes
 *
 * NOTE: node-pty is an optional dependency requiring native compilation.
 * Terminal features gracefully degrade when node-pty is not available.
 */

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';
import { sanitizeEnvForSandbox } from '../sandbox-utils.js';

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
    // Clear any cached failure so require() retries the native load
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
    // Linux
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

// Import type separately for type-checking (doesn't require the module to load)
type IPty = import('node-pty').IPty;

export interface PTYSession {
  id: string;
  pty: IPty;
  shell: string;
  cwd: string;
  // Timestamp when session was created
  createdAt: number;
  // Last activity timestamp
  lastActivityAt: number;
  // Current dimensions
  cols: number;
  rows: number;
  // Output coalescing: buffer small chunks into fewer WS messages
  _outputBuffer: string;
  _outputTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Detect the user's default shell
 */
function detectShell(): string {
  const shell = process.env.SHELL;

  if (shell) {
    return shell;
  }

  // Platform-specific defaults
  if (platform() === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }

  return '/bin/bash';
}

/**
 * Get shell name from path
 */
function getShellName(shellPath: string): string {
  const parts = shellPath.split(/[/\\]/);
  return parts[parts.length - 1] || 'shell';
}

export class PTYManager extends EventEmitter {
  private terminals: Map<string, PTYSession> = new Map();

  constructor() {
    super();
    // Each terminal adds 3 listeners (output, exit, error) to this singleton.
    // With multiple terminals, the default limit of 10 is easily exceeded.
    this.setMaxListeners(50);
  }

  /**
   * Check if a terminal session exists and is still running
   */
  exists(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  /**
   * Get session info for reconnection
   * Returns null if session doesn't exist
   */
  getSessionInfo(terminalId: string): { shell: string; cwd: string; cols: number; rows: number } | null {
    const session = this.terminals.get(terminalId);
    if (!session) return null;
    return {
      shell: session.shell,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
    };
  }

  /**
   * Check if PTY functionality is available
   */
  isPtyAvailable(): boolean {
    return isPtyAvailable();
  }

  /**
   * Get installation instructions if PTY is not available
   */
  getPtyInstallInstructions(): string {
    return getPtyInstallInstructions();
  }

  /**
   * Create a new terminal session
   */
  create(
    terminalId: string,
    workingDir: string,
    cols: number = 80,
    rows: number = 24,
    requestedShell?: string,
    options?: { sandboxed?: boolean }
  ): { shell: string; cwd: string; isReconnect: boolean } {
    // Check if node-pty is available
    if (!pty) {
      throw new Error(`PTY_NOT_AVAILABLE:${getPtyInstallInstructions()}`);
    }

    // Check if session already exists - if so, this is a reconnection
    if (this.terminals.has(terminalId)) {
      const existingSession = this.terminals.get(terminalId)!;

      // Always resize on reconnect to trigger SIGWINCH, which causes the
      // shell to redraw its prompt line for the reconnected client
      existingSession.pty.resize(cols, rows);
      existingSession.cols = cols;
      existingSession.rows = rows;

      return {
        shell: existingSession.shell,
        cwd: existingSession.cwd,
        isReconnect: true,
      };
    }

    const shell = requestedShell || detectShell();
    const cwd = workingDir || homedir();


    try {
      // Build env: sandboxed sessions get stripped secrets and HOME=projectDir
      const baseEnv = options?.sandboxed
        ? sanitizeEnvForSandbox(process.env, cwd)
        : { ...process.env, HOME: homedir() };
      const env = {
        ...baseEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      };

      // Spawn the PTY process
      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      });

      const session: PTYSession = {
        id: terminalId,
        pty: ptyProcess,
        shell: getShellName(shell),
        cwd,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        cols,
        rows,
        _outputBuffer: '',
        _outputTimer: null,
      };
      this.terminals.set(terminalId, session);

      // Handle data output — coalesce small chunks to reduce WebSocket message count.
      // On macOS, node-pty emits many tiny chunks (sometimes single bytes) and zsh
      // wraps echoed chars in multi-part ANSI sequences (RPROMPT, syntax highlighting).
      // A longer window on macOS ensures these multi-part sequences arrive as one chunk,
      // which the browser's predictive echo can match correctly.
      const OUTPUT_COALESCE_MS = platform() === 'darwin' ? 24 : 8;
      // High-water mark: flush immediately when buffer exceeds this size
      // to prevent unbounded memory growth during high-output commands (e.g. `yes`)
      const OUTPUT_HIGH_WATER = 64 * 1024; // 64KB
      // Maximum chunk size per WebSocket message to prevent browser overload
      const OUTPUT_CHUNK_SIZE = 64 * 1024;

      const flushOutputBuffer = () => {
        if (session._outputTimer) {
          clearTimeout(session._outputTimer);
          session._outputTimer = null;
        }
        const buffered = session._outputBuffer;
        session._outputBuffer = '';
        // Chunk large output to prevent single massive WebSocket frames
        for (let i = 0; i < buffered.length; i += OUTPUT_CHUNK_SIZE) {
          this.emit('output', terminalId, buffered.slice(i, i + OUTPUT_CHUNK_SIZE));
        }
      };

      ptyProcess.onData((data: string) => {
        session.lastActivityAt = Date.now();
        session._outputBuffer += data;
        // Flush immediately if buffer exceeds high-water mark
        if (session._outputBuffer.length >= OUTPUT_HIGH_WATER) {
          flushOutputBuffer();
        } else if (!session._outputTimer) {
          session._outputTimer = setTimeout(flushOutputBuffer, OUTPUT_COALESCE_MS);
        }
      });

      // Handle exit — flush any buffered output first
      ptyProcess.onExit(({ exitCode }) => {
        if (session._outputBuffer) {
          flushOutputBuffer();
        } else if (session._outputTimer) {
          clearTimeout(session._outputTimer);
          session._outputTimer = null;
        }
        this.emit('exit', terminalId, exitCode);
        this.terminals.delete(terminalId);
      });

      return { shell: session.shell, cwd, isReconnect: false };
    } catch (error: unknown) {
      console.error(`[PTYManager] Failed to create terminal ${terminalId}:`, error);
      this.emit('error', terminalId, error instanceof Error ? error.message : 'Failed to create terminal');
      throw error;
    }
  }

  /**
   * Write input data to terminal
   */
  write(terminalId: string, data: string): boolean {
    const session = this.terminals.get(terminalId);
    if (!session) {
      console.warn(`[PTYManager] Terminal ${terminalId} not found for write`);
      return false;
    }

    try {
      session.pty.write(data);
      return true;
    } catch (error: unknown) {
      console.error(`[PTYManager] Error writing to terminal ${terminalId}:`, error);
      this.emit('error', terminalId, error instanceof Error ? error.message : 'Write failed');
      return false;
    }
  }

  /**
   * Resize terminal
   */
  resize(terminalId: string, cols: number, rows: number): boolean {
    const session = this.terminals.get(terminalId);
    if (!session) {
      console.warn(`[PTYManager] Terminal ${terminalId} not found for resize`);
      return false;
    }

    try {
      session.pty.resize(cols, rows);
      return true;
    } catch (error: unknown) {
      console.error(`[PTYManager] Error resizing terminal ${terminalId}:`, error);
      return false;
    }
  }

  /**
   * Close terminal session
   */
  close(terminalId: string): boolean {
    const session = this.terminals.get(terminalId);
    if (!session) {
      return false;
    }


    try {
      // Flush any coalesced output before closing
      if (session._outputTimer) {
        clearTimeout(session._outputTimer);
        if (session._outputBuffer) {
          this.emit('output', terminalId, session._outputBuffer);
          session._outputBuffer = '';
        }
        session._outputTimer = null;
      }
      session.pty.kill();
      this.terminals.delete(terminalId);
      return true;
    } catch (error: unknown) {
      console.error(`[PTYManager] Error closing terminal ${terminalId}:`, error);
      this.terminals.delete(terminalId);
      return false;
    }
  }

  /**
   * Get terminal session info
   */
  getSession(terminalId: string): PTYSession | undefined {
    return this.terminals.get(terminalId);
  }

  /**
   * Check if terminal exists
   */
  has(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  /**
   * Get all active terminal IDs
   */
  getActiveTerminals(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Close all terminals
   */
  closeAll(): void {
    for (const terminalId of this.terminals.keys()) {
      this.close(terminalId);
    }
  }

}

// Singleton instance
let ptyManagerInstance: PTYManager | null = null;

export function getPTYManager(): PTYManager {
  if (!ptyManagerInstance) {
    ptyManagerInstance = new PTYManager();
  }
  return ptyManagerInstance;
}
