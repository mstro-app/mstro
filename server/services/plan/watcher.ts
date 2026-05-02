// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Plan Watcher — Watches .mstro/pm/ directory for changes and broadcasts updates.
 *
 * Uses fs.watch with debouncing to batch rapid changes.
 */

import { type FSWatcher, watch } from 'node:fs';
import type { HandlerContext } from '../websocket/handler-context.js';
import { parsePlanDirectory, resolvePmDir } from './parser.js';

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

    const planDir = resolvePmDir(this.workingDir);
    if (!planDir) return;

    try {
      this.watcher = watch(planDir, { recursive: true }, (_event, filename) => {
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
      const fullState = parsePlanDirectory(this.workingDir);
      if (fullState) {
        this.ctx.broadcastToAll({ type: 'planStateUpdated', data: fullState });
      }
    } catch {
      // Ignore parse errors from partial writes
    }
  }
}
