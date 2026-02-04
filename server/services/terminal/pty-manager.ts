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
 * Also supports tmux-backed persistence for sessions that survive server restarts.
 *
 * NOTE: node-pty is an optional dependency requiring native compilation.
 * Terminal features gracefully degrade when node-pty is not available.
 */

import { EventEmitter } from 'node:events';
import { homedir, platform } from 'node:os';
import { getTmuxManager, isTmuxAvailable, type TmuxSession } from './tmux-manager.js';

// Try to load node-pty (optional native dependency)
let pty: typeof import('node-pty') | null = null;
let _ptyLoadError: string | null = null;

try {
  pty = await import('node-pty');
} catch (error: any) {
  _ptyLoadError = error.message || 'Failed to load node-pty';
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

// Maximum lines to store in scrollback buffer per terminal
const MAX_SCROLLBACK_LINES = 5000;
// Maximum characters per line to prevent memory bloat
const MAX_LINE_LENGTH = 2000;

// Import type separately for type-checking (doesn't require the module to load)
type IPty = import('node-pty').IPty;

export interface PTYSession {
  id: string;
  pty: IPty;
  shell: string;
  cwd: string;
  // Scrollback buffer for replay on reconnect
  scrollback: string[];
  // Timestamp when session was created
  createdAt: number;
  // Last activity timestamp
  lastActivityAt: number;
  // Current dimensions
  cols: number;
  rows: number;
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
   * Get scrollback buffer for replay on reconnect
   * Returns the stored output history
   */
  getScrollback(terminalId: string): string[] {
    const session = this.terminals.get(terminalId);
    if (!session) return [];
    return [...session.scrollback];
  }

  /**
   * Add data to scrollback buffer
   * Maintains a rolling buffer of recent terminal output
   */
  private addToScrollback(session: PTYSession, data: string): void {
    // Split data into lines
    const lines = data.split(/\r?\n/);

    for (const line of lines) {
      // Truncate very long lines to prevent memory issues
      const truncatedLine = line.length > MAX_LINE_LENGTH
        ? `${line.slice(0, MAX_LINE_LENGTH)}...`
        : line;

      session.scrollback.push(truncatedLine);
    }

    // Trim buffer if it exceeds max size
    if (session.scrollback.length > MAX_SCROLLBACK_LINES) {
      session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK_LINES);
    }

    session.lastActivityAt = Date.now();
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
    requestedShell?: string
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
      // Spawn the PTY process
      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          // Ensure home directory is set
          HOME: homedir(),
        },
      });

      // Store the session with scrollback buffer
      const session: PTYSession = {
        id: terminalId,
        pty: ptyProcess,
        shell: getShellName(shell),
        cwd,
        scrollback: [],
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        cols,
        rows,
      };
      this.terminals.set(terminalId, session);

      // Handle data output - store in scrollback and emit
      ptyProcess.onData((data: string) => {
        this.addToScrollback(session, data);
        this.emit('output', terminalId, data);
      });

      // Handle exit
      ptyProcess.onExit(({ exitCode }) => {
        this.emit('exit', terminalId, exitCode);
        this.terminals.delete(terminalId);
      });

      return { shell: session.shell, cwd, isReconnect: false };
    } catch (error: any) {
      console.error(`[PTYManager] Failed to create terminal ${terminalId}:`, error);
      this.emit('error', terminalId, error.message || 'Failed to create terminal');
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
    } catch (error: any) {
      console.error(`[PTYManager] Error writing to terminal ${terminalId}:`, error);
      this.emit('error', terminalId, error.message || 'Write failed');
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
    } catch (error: any) {
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
      session.pty.kill();
      this.terminals.delete(terminalId);
      return true;
    } catch (error: any) {
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

  /**
   * Check if tmux persistence is available
   */
  isTmuxAvailable(): boolean {
    return isTmuxAvailable();
  }

  /**
   * Get list of persistent tmux sessions that can be restored
   * These are sessions that survived a server restart
   */
  getPersistentSessions(): TmuxSession[] {
    const tmux = getTmuxManager();
    return tmux.getActiveSessions();
  }

  /**
   * Create a persistent (tmux-backed) terminal session
   * These sessions survive server restarts
   */
  createPersistent(
    terminalId: string,
    workingDir: string,
    cols: number = 80,
    rows: number = 24,
    requestedShell?: string
  ): { shell: string; cwd: string; isReconnect: boolean; persistent: true } {
    const tmux = getTmuxManager();

    if (!tmux.isAvailable()) {
      throw new Error('tmux is not available for persistent sessions');
    }

    const result = tmux.create(terminalId, workingDir, cols, rows, requestedShell);
    return { ...result, persistent: true };
  }

  /**
   * Attach to a persistent (tmux) session
   * Returns handlers for write, resize, and detach
   */
  attachPersistent(
    terminalId: string,
    onOutput: (data: string) => void,
    onExit: (code: number) => void
  ): { write: (data: string) => void; resize: (cols: number, rows: number) => void; detach: () => void } | null {
    const tmux = getTmuxManager();

    if (!tmux.exists(terminalId)) {
      return null;
    }

    return tmux.attach(terminalId, onOutput, onExit);
  }

  /**
   * Get scrollback from a persistent (tmux) session
   */
  getPersistentScrollback(terminalId: string): string[] {
    const tmux = getTmuxManager();
    return tmux.getScrollback(terminalId);
  }

  /**
   * Close a persistent (tmux) session
   */
  closePersistent(terminalId: string): boolean {
    const tmux = getTmuxManager();
    return tmux.close(terminalId);
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
