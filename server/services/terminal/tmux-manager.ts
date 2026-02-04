// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Tmux Session Manager - Provides persistent terminal sessions via tmux
 *
 * When enabled, terminals are run inside tmux sessions, which allows:
 * - Sessions to survive client restarts
 * - True process persistence across browser disconnections
 * - Session restoration even after server restart
 *
 * Tmux sessions are named with a prefix to identify them as mstro-managed.
 */

import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MSTRO_TMUX_PREFIX = 'mstro-terminal-';
const SESSION_REGISTRY_PATH = join(homedir(), '.mstro', 'terminal-sessions.json');

export interface TmuxSession {
  terminalId: string;
  tmuxSessionName: string;
  shell: string;
  cwd: string;
  createdAt: number;
  lastAttachedAt: number;
}

interface SessionRegistry {
  sessions: TmuxSession[];
}

/**
 * Check if tmux is available on the system
 */
export function isTmuxAvailable(): boolean {
  try {
    const result = spawnSync('which', ['tmux'], { encoding: 'utf-8' });
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * TmuxManager - Manages tmux-backed terminal sessions
 */
export class TmuxManager extends EventEmitter {
  private sessions: Map<string, TmuxSession> = new Map();
  private outputHandlers: Map<string, NodeJS.Timeout> = new Map();
  private tmuxAvailable: boolean;

  constructor() {
    super();
    this.tmuxAvailable = isTmuxAvailable();

    if (this.tmuxAvailable) {
      this.loadRegistry();
      this.syncWithTmux();
    }
  }

  /**
   * Check if tmux persistence is available
   */
  isAvailable(): boolean {
    return this.tmuxAvailable;
  }

  /**
   * Load session registry from disk
   */
  private loadRegistry(): void {
    try {
      if (existsSync(SESSION_REGISTRY_PATH)) {
        const data = readFileSync(SESSION_REGISTRY_PATH, 'utf-8');
        const registry: SessionRegistry = JSON.parse(data);
        for (const session of registry.sessions) {
          this.sessions.set(session.terminalId, session);
        }
      }
    } catch (error) {
      console.error('[TmuxManager] Failed to load registry:', error);
    }
  }

  /**
   * Save session registry to disk
   */
  private saveRegistry(): void {
    try {
      const dir = join(homedir(), '.mstro');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const registry: SessionRegistry = {
        sessions: Array.from(this.sessions.values()),
      };
      writeFileSync(SESSION_REGISTRY_PATH, JSON.stringify(registry, null, 2));
    } catch (error) {
      console.error('[TmuxManager] Failed to save registry:', error);
    }
  }

  /**
   * Sync our registry with actual tmux sessions
   * Remove sessions that no longer exist in tmux
   */
  private syncWithTmux(): void {
    if (!this.tmuxAvailable) return;

    try {
      // List all tmux sessions
      const result = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
        encoding: 'utf-8',
      });

      if (result.status !== 0) {
        // No tmux server running - clear all sessions
        this.sessions.clear();
        this.saveRegistry();
        return;
      }

      const existingSessions = new Set(
        result.stdout
          .trim()
          .split('\n')
          .filter((name) => name.startsWith(MSTRO_TMUX_PREFIX))
      );

      // Remove sessions that no longer exist
      for (const [terminalId, session] of this.sessions) {
        if (!existingSessions.has(session.tmuxSessionName)) {
          this.sessions.delete(terminalId);
        }
      }

      this.saveRegistry();
    } catch (error) {
      console.error('[TmuxManager] Failed to sync with tmux:', error);
    }
  }

  /**
   * Check if a session exists
   */
  exists(terminalId: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session) return false;

    // Verify it still exists in tmux
    try {
      const result = spawnSync('tmux', ['has-session', '-t', session.tmuxSessionName], {
        encoding: 'utf-8',
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Get session info
   */
  getSessionInfo(terminalId: string): TmuxSession | null {
    return this.sessions.get(terminalId) || null;
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): TmuxSession[] {
    this.syncWithTmux();
    return Array.from(this.sessions.values());
  }

  /**
   * Create a new tmux-backed terminal session
   */
  create(
    terminalId: string,
    workingDir: string,
    cols: number = 80,
    rows: number = 24,
    shell?: string
  ): { shell: string; cwd: string; isReconnect: boolean } {
    if (!this.tmuxAvailable) {
      throw new Error('tmux is not available');
    }

    // Check if session already exists
    if (this.exists(terminalId)) {
      const session = this.sessions.get(terminalId)!;
      session.lastAttachedAt = Date.now();
      this.saveRegistry();
      return {
        shell: session.shell,
        cwd: session.cwd,
        isReconnect: true,
      };
    }

    const tmuxSessionName = `${MSTRO_TMUX_PREFIX}${terminalId}`;
    const cwd = workingDir || homedir();
    const shellPath = shell || process.env.SHELL || '/bin/bash';
    const shellName = shellPath.split('/').pop() || 'shell';


    try {
      // Create new tmux session
      const result = spawnSync(
        'tmux',
        [
          'new-session',
          '-d', // Detached
          '-s', tmuxSessionName,
          '-x', cols.toString(),
          '-y', rows.toString(),
          '-c', cwd,
          shellPath,
        ],
        {
          encoding: 'utf-8',
          cwd,
        }
      );

      if (result.status !== 0) {
        throw new Error(`Failed to create tmux session: ${result.stderr}`);
      }

      // Store session info
      const session: TmuxSession = {
        terminalId,
        tmuxSessionName,
        shell: shellName,
        cwd,
        createdAt: Date.now(),
        lastAttachedAt: Date.now(),
      };
      this.sessions.set(terminalId, session);
      this.saveRegistry();

      return { shell: shellName, cwd, isReconnect: false };
    } catch (error: any) {
      console.error(`[TmuxManager] Failed to create session:`, error);
      throw error;
    }
  }

  /**
   * Attach to a tmux session and stream output
   * Returns a function to detach
   */
  attach(
    terminalId: string,
    onOutput: (data: string) => void,
    onExit: (code: number) => void
  ): { write: (data: string) => void; resize: (cols: number, rows: number) => void; detach: () => void } {
    const session = this.sessions.get(terminalId);
    if (!session) {
      throw new Error(`Session not found: ${terminalId}`);
    }

    // Update last attached time
    session.lastAttachedAt = Date.now();
    this.saveRegistry();

    // Create a pipe process to capture tmux output
    // We use 'tmux pipe-pane' to capture output and 'tmux send-keys' for input
    const _pipePath = `/tmp/mstro-tmux-pipe-${terminalId}`;

    // Start capturing output using tmux's capture-pane in a loop
    let capturing = true;
    let lastCaptureLength = 0;

    const captureLoop = setInterval(() => {
      if (!capturing) {
        clearInterval(captureLoop);
        return;
      }

      try {
        // Capture the current pane content
        const result = spawnSync(
          'tmux',
          ['capture-pane', '-t', session.tmuxSessionName, '-p', '-S', '-100'],
          { encoding: 'utf-8' }
        );

        if (result.status === 0) {
          const output = result.stdout;
          // Only emit new content
          if (output.length > lastCaptureLength) {
            const newContent = output.slice(lastCaptureLength);
            if (newContent.trim()) {
              onOutput(newContent);
            }
            lastCaptureLength = output.length;
          }
        } else if (result.stderr?.includes('no server running')) {
          // Session ended
          capturing = false;
          clearInterval(captureLoop);
          onExit(0);
          this.sessions.delete(terminalId);
          this.saveRegistry();
        }
      } catch (error) {
        console.error('[TmuxManager] Capture error:', error);
      }
    }, 100); // Poll every 100ms

    this.outputHandlers.set(terminalId, captureLoop);

    return {
      write: (data: string) => {
        try {
          // Send keys to tmux session
          spawnSync('tmux', ['send-keys', '-t', session.tmuxSessionName, '-l', data], {
            encoding: 'utf-8',
          });
        } catch (error) {
          console.error('[TmuxManager] Write error:', error);
        }
      },

      resize: (cols: number, rows: number) => {
        try {
          spawnSync(
            'tmux',
            ['resize-window', '-t', session.tmuxSessionName, '-x', cols.toString(), '-y', rows.toString()],
            { encoding: 'utf-8' }
          );
        } catch (_error) {
          // Resize errors are not critical
        }
      },

      detach: () => {
        capturing = false;
        const handler = this.outputHandlers.get(terminalId);
        if (handler) {
          clearInterval(handler);
          this.outputHandlers.delete(terminalId);
        }
      },
    };
  }

  /**
   * Get scrollback/history from tmux session
   */
  getScrollback(terminalId: string, lines: number = 5000): string[] {
    const session = this.sessions.get(terminalId);
    if (!session) return [];

    try {
      const result = spawnSync(
        'tmux',
        ['capture-pane', '-t', session.tmuxSessionName, '-p', '-S', `-${lines}`],
        { encoding: 'utf-8' }
      );

      if (result.status === 0) {
        return result.stdout.split('\n');
      }
    } catch (error) {
      console.error('[TmuxManager] Failed to get scrollback:', error);
    }

    return [];
  }

  /**
   * Close/kill a tmux session
   */
  close(terminalId: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session) return false;

    // Stop output capture if running
    const handler = this.outputHandlers.get(terminalId);
    if (handler) {
      clearInterval(handler);
      this.outputHandlers.delete(terminalId);
    }

    try {
      spawnSync('tmux', ['kill-session', '-t', session.tmuxSessionName], {
        encoding: 'utf-8',
      });
      this.sessions.delete(terminalId);
      this.saveRegistry();
      return true;
    } catch (error) {
      console.error('[TmuxManager] Failed to close session:', error);
      return false;
    }
  }

  /**
   * Close all mstro-managed tmux sessions
   */
  closeAll(): void {
    for (const terminalId of this.sessions.keys()) {
      this.close(terminalId);
    }
  }
}

// Singleton instance
let tmuxManagerInstance: TmuxManager | null = null;

export function getTmuxManager(): TmuxManager {
  if (!tmuxManagerInstance) {
    tmuxManagerInstance = new TmuxManager();
  }
  return tmuxManagerInstance;
}
