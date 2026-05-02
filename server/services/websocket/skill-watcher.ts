// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { type FSWatcher, watch } from 'node:fs';
import { findSkillsDir } from '../../utils/paths.js';
import type { HandlerContext } from './handler-context.js';
import { collectAllSkills, USER_SKILLS_DIR } from './skill-handlers.js';

export class SkillsWatcher {
  private userWatcher: FSWatcher | null = null;
  private projectWatcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSkillsHash = '';
  private started = false;

  constructor(
    private readonly workingDir: string,
    private readonly ctx: HandlerContext,
  ) {}

  start(): void {
    if (this.started) return;

    this.lastSkillsHash = this.computeHash();

    try {
      this.userWatcher = watch(USER_SKILLS_DIR, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.endsWith('.md')) return;
        this.debounce();
      });
      this.userWatcher.on('error', () => { /* directory deleted or inaccessible */ });
    } catch { /* directory missing or recursive watch unsupported */ }

    const projectSkillsDir = findSkillsDir(this.workingDir);
    if (projectSkillsDir) {
      try {
        this.projectWatcher = watch(projectSkillsDir, { recursive: true }, (_event, filename) => {
          if (!filename || !filename.endsWith('.md')) return;
          this.debounce();
        });
        this.projectWatcher.on('error', () => { /* directory deleted or inaccessible */ });
      } catch { /* directory missing or recursive watch unsupported */ }
    }

    this.started = true;
  }

  stop(): void {
    if (this.userWatcher) { this.userWatcher.close(); this.userWatcher = null; }
    if (this.projectWatcher) { this.projectWatcher.close(); this.projectWatcher = null; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    this.started = false;
  }

  private debounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.handleChange();
    }, 250);
  }

  private handleChange(): void {
    try {
      const skills = collectAllSkills(this.workingDir);
      const hash = JSON.stringify(skills.map(s => `${s.name}:${s.source}:${s.description}`));
      if (hash === this.lastSkillsHash) return;
      this.lastSkillsHash = hash;

      this.ctx.broadcastToAll({ type: 'skillsList', data: { skills } });
    } catch {
      // Ignore errors from partial writes or missing files
    }
  }

  private computeHash(): string {
    const skills = collectAllSkills(this.workingDir);
    return JSON.stringify(skills.map(s => `${s.name}:${s.source}:${s.description}`));
  }
}
