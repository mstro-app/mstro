// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Plan Watcher — Watches .pm/ directory for changes and broadcasts updates.
 *
 * Uses fs.watch with debouncing to batch rapid changes.
 */

import { existsSync, type FSWatcher, watch } from 'node:fs';
import { join } from 'node:path';
import type { HandlerContext } from '../websocket/handler-context.js';
import { parsePmDirectory } from './parser.js';

export class PlanWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly workingDir: string;
  private readonly ctx: HandlerContext;
  private started = false;

  constructor(workingDir: string, ctx: HandlerContext) {
    this.workingDir = workingDir;
    this.ctx = ctx;
  }

  start(): void {
    if (this.started) return;

    const pmDir = join(this.workingDir, '.pm');
    if (!existsSync(pmDir)) return;

    try {
      this.watcher = watch(pmDir, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.endsWith('.md')) return;
        this.debounce();
      });
      this.started = true;
    } catch {
      // fs.watch recursive may not be supported on all platforms
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.started = false;
  }

  private debounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.handleChange();
    }, 200);
  }

  private handleChange(): void {
    try {
      // Always do a full reparse — concurrent changes may affect multiple files
      const fullState = parsePmDirectory(this.workingDir);
      if (fullState) {
        this.ctx.broadcastToAll({ type: 'planStateUpdated', data: fullState });
      }
    } catch {
      // Ignore parse errors from partial writes
    }
  }
}
