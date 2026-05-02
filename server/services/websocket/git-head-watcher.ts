// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { existsSync, type FSWatcher, watch } from 'node:fs';
import { join } from 'node:path';
import { executeGitCommand } from './git-utils.js';
import type { HandlerContext } from './handler-context.js';

/**
 * Watches .git/HEAD and .git/worktrees/ for branch changes and
 * broadcasts updates to all connected web clients.
 */
export class GitHeadWatcher {
  private headWatcher: FSWatcher | null = null;
  private worktreeWatcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastKnownBranch = '';
  private lastKnownWorktreeBranches = new Map<string, string>();
  private started = false;

  constructor(
    private readonly workingDir: string,
    private readonly ctx: HandlerContext,
  ) {}

  start(): void {
    if (this.started) return;

    const gitDir = join(this.workingDir, '.git');
    if (!existsSync(gitDir)) return;

    this.initLastKnownBranches();

    try {
      this.headWatcher = watch(join(gitDir, 'HEAD'), () => this.debounce());
    } catch { /* not a git repo or permission issue */ }

    this.startWorktreeWatcher();
    this.started = true;
  }

  startWorktreeWatcher(): void {
    if (this.worktreeWatcher) return;
    try {
      const worktreesDir = join(this.workingDir, '.git', 'worktrees');
      if (!existsSync(worktreesDir)) return;
      this.worktreeWatcher = watch(worktreesDir, { recursive: true }, (_event, filename) => {
        if (filename?.endsWith('HEAD')) this.debounce();
      });
    } catch { /* recursive watch not supported or dir missing */ }
  }

  stop(): void {
    if (this.headWatcher) { this.headWatcher.close(); this.headWatcher = null; }
    if (this.worktreeWatcher) { this.worktreeWatcher.close(); this.worktreeWatcher = null; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    this.started = false;
  }

  private async initLastKnownBranches(): Promise<void> {
    try {
      const result = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], this.workingDir);
      if (result.exitCode === 0) this.lastKnownBranch = result.stdout.trim();
    } catch { /* ignore */ }

    for (const [tabId, wtPath] of this.ctx.gitDirectories) {
      if (wtPath === this.workingDir) continue;
      try {
        const result = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath);
        if (result.exitCode === 0) this.lastKnownWorktreeBranches.set(tabId, result.stdout.trim());
      } catch { /* ignore */ }
    }
  }

  private debounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => { this.handleChange(); }, 300);
  }

  private async handleChange(): Promise<void> {
    try {
      await this.checkMainBranch();
      await this.checkWorktreeBranches();
    } catch { /* ignore errors from concurrent git operations */ }
  }

  private async checkMainBranch(): Promise<void> {
    const result = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], this.workingDir);
    if (result.exitCode !== 0) return;
    const branch = result.stdout.trim();
    if (!branch || branch === this.lastKnownBranch) return;
    this.lastKnownBranch = branch;
    this.ctx.broadcastToAll({
      type: 'gitBranchChanged',
      data: { directory: this.workingDir, branch },
    });
  }

  private async checkWorktreeBranches(): Promise<void> {
    for (const [tabId, wtPath] of this.ctx.gitDirectories) {
      if (wtPath === this.workingDir) continue;
      try {
        const result = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath);
        if (result.exitCode !== 0) continue;
        const branch = result.stdout.trim();
        if (!branch) continue;
        const lastBranch = this.lastKnownWorktreeBranches.get(tabId);
        if (branch === lastBranch) continue;
        this.lastKnownWorktreeBranches.set(tabId, branch);
        this.ctx.gitBranches.set(tabId, branch);
        const registry = this.ctx.getRegistry(this.workingDir);
        registry.updateTabWorktree(tabId, wtPath, branch);
        this.ctx.broadcastToAll({
          type: 'gitBranchChanged',
          data: { directory: wtPath, branch },
        });
      } catch { /* ignore */ }
    }
  }
}
