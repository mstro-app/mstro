// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * PTY Manager - Manages pseudo-terminal sessions for shell access.
 *
 * Utilities (node-pty loading, shell detection, ScrollbackBuffer, types)
 * live in pty-utils.ts. This file owns session lifecycle orchestration.
 */

import { EventEmitter } from 'node:events';
import { homedir, platform } from 'node:os';
import { sanitizeEnvForSandbox } from '../sandbox-utils.js';
import type { PTYSession } from './pty-utils.js';
import {
  detectShell,
  getPty,
  getPtyInstallInstructions,
  getShellName,
  isPtyAvailable,
  SCROLLBACK_MAX_BYTES,
  ScrollbackBuffer,
} from './pty-utils.js';

export type { PTYSession } from './pty-utils.js';
// Re-export public API for backward compatibility
export { isPtyAvailable, reloadPty } from './pty-utils.js';

export class PTYManager extends EventEmitter {
  private terminals: Map<string, PTYSession> = new Map();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  exists(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  getSessionInfo(terminalId: string): { shell: string; cwd: string; cols: number; rows: number } | null {
    const session = this.terminals.get(terminalId);
    if (!session) return null;
    return { shell: session.shell, cwd: session.cwd, cols: session.cols, rows: session.rows };
  }

  isPtyAvailable(): boolean {
    return isPtyAvailable();
  }

  getPtyInstallInstructions(): string {
    return getPtyInstallInstructions();
  }

  create(
    terminalId: string,
    workingDir: string,
    cols: number = 80,
    rows: number = 24,
    requestedShell?: string,
    options?: { sandboxed?: boolean }
  ): { shell: string; cwd: string; isReconnect: boolean; platform: string } {
    const pty = getPty();
    if (!pty) {
      throw new Error(`PTY_NOT_AVAILABLE:${getPtyInstallInstructions()}`);
    }

    // Reconnect to existing session
    if (this.terminals.has(terminalId)) {
      const existingSession = this.terminals.get(terminalId)!;
      existingSession.pty.resize(cols, rows);
      existingSession.cols = cols;
      existingSession.rows = rows;
      return { shell: existingSession.shell, cwd: existingSession.cwd, isReconnect: true, platform: platform() };
    }

    const shell = requestedShell || detectShell();
    const cwd = workingDir || homedir();

    try {
      const baseEnv = options?.sandboxed
        ? sanitizeEnvForSandbox(process.env, cwd)
        : { ...process.env, HOME: homedir() };
      const env = { ...baseEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' };

      const ptyProcess = pty.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd, env });

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
        scrollback: new ScrollbackBuffer(SCROLLBACK_MAX_BYTES),
      };
      this.terminals.set(terminalId, session);

      this.attachOutputHandlers(session, terminalId);

      return { shell: session.shell, cwd, isReconnect: false, platform: platform() };
    } catch (error: unknown) {
      console.error(`[PTYManager] Failed to create terminal ${terminalId}:`, error);
      this.emit('error', terminalId, error instanceof Error ? error.message : 'Failed to create terminal');
      throw error;
    }
  }

  private attachOutputHandlers(session: PTYSession, terminalId: string): void {
    // Output coalescing constants
    const OUTPUT_COALESCE_MS = platform() === 'darwin' ? 32 : 8;
    const OUTPUT_HIGH_WATER = 64 * 1024;
    const OUTPUT_CHUNK_SIZE = 64 * 1024;

    const flushOutputBuffer = () => {
      if (session._outputTimer) {
        clearTimeout(session._outputTimer);
        session._outputTimer = null;
      }
      const buffered = session._outputBuffer;
      session._outputBuffer = '';
      for (let i = 0; i < buffered.length; i += OUTPUT_CHUNK_SIZE) {
        this.emit('output', terminalId, buffered.slice(i, i + OUTPUT_CHUNK_SIZE));
      }
    };

    session.pty.onData((data: string) => {
      session.scrollback.append(data);
      session.lastActivityAt = Date.now();
      session._outputBuffer += data;
      if (session._outputBuffer.length >= OUTPUT_HIGH_WATER) {
        flushOutputBuffer();
      } else if (!session._outputTimer) {
        session._outputTimer = setTimeout(flushOutputBuffer, OUTPUT_COALESCE_MS);
      }
    });

    session.pty.onExit(({ exitCode }) => {
      if (session._outputBuffer) {
        flushOutputBuffer();
      } else if (session._outputTimer) {
        clearTimeout(session._outputTimer);
        session._outputTimer = null;
      }
      this.emit('exit', terminalId, exitCode);
      this.terminals.delete(terminalId);
    });
  }

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

  close(terminalId: string): boolean {
    const session = this.terminals.get(terminalId);
    if (!session) return false;
    try {
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

  getScrollback(terminalId: string): string | null {
    const session = this.terminals.get(terminalId);
    if (!session) return null;
    return session.scrollback.getContents();
  }

  getSession(terminalId: string): PTYSession | undefined {
    return this.terminals.get(terminalId);
  }

  has(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  getActiveTerminals(): string[] {
    return Array.from(this.terminals.keys());
  }

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
