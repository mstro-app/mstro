// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Config Installer — Manages temporary .claude/settings.json modifications
 * for headless execution.
 *
 * Pre-approves tools so headless Claude Code instances can work without
 * interactive permission prompts, then restores the original settings afterward.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Tools that headless instances may need during execution */
const REQUIRED_PERMISSIONS = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
];

/** Restore a file from a .pm-backup, handling the __NONE__ sentinel for files that didn't exist. */
function restoreFromBackup(backupPath: string, targetPath: string): void {
  try {
    if (!existsSync(backupPath)) return;
    const backup = readFileSync(backupPath, 'utf-8');
    if (backup === '__NONE__') {
      if (existsSync(targetPath)) unlinkSync(targetPath);
    } else {
      writeFileSync(targetPath, backup);
    }
    unlinkSync(backupPath);
  } catch { /* best effort */ }
}

export class ConfigInstaller {
  private savedClaudeSettings: string | null = null;
  private claudeSettingsInstalled = false;

  constructor(private workingDir: string) {
    // Recover from prior crash: if backup files exist, restore them
    this.recoverFromCrash();
  }

  /** Restore .claude/settings.json from backups left by a previous crash. */
  private recoverFromCrash(): void {
    restoreFromBackup(
      join(this.workingDir, '.claude', 'settings.json.pm-backup'),
      join(this.workingDir, '.claude', 'settings.json'),
    );
    // Legacy: clean up .mcp.json backup from previous Agent Teams implementation
    restoreFromBackup(
      join(this.workingDir, '.mcp.json.pm-backup'),
      join(this.workingDir, '.mcp.json'),
    );
  }

  /**
   * Pre-approve tools in .claude/settings.json so headless instances
   * can work without interactive permission prompts.
   */
  installPermissions(): void {
    if (this.claudeSettingsInstalled) return;
    const claudeDir = join(this.workingDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.json');

    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    const backupPath = join(claudeDir, 'settings.json.pm-backup');
    try {
      if (existsSync(settingsPath)) {
        this.savedClaudeSettings = readFileSync(settingsPath, 'utf-8');
        writeFileSync(backupPath, this.savedClaudeSettings);
        const existing = JSON.parse(this.savedClaudeSettings);

        if (!existing.permissions) existing.permissions = {};
        if (!existing.permissions.allow) existing.permissions.allow = [];

        for (const tool of REQUIRED_PERMISSIONS) {
          if (!existing.permissions.allow.includes(tool)) {
            existing.permissions.allow.push(tool);
          }
        }

        writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
      } else {
        this.savedClaudeSettings = null;
        writeFileSync(backupPath, '__NONE__');
        writeFileSync(settingsPath, JSON.stringify({
          permissions: { allow: REQUIRED_PERMISSIONS },
        }, null, 2));
      }
      this.claudeSettingsInstalled = true;
    } catch {
      // Non-fatal — headless instances may hit permission prompts
    }
  }

  /** Restore original .claude/settings.json after wave execution. */
  uninstallPermissions(): void {
    if (!this.claudeSettingsInstalled) return;
    const settingsPath = join(this.workingDir, '.claude', 'settings.json');
    const backupPath = join(this.workingDir, '.claude', 'settings.json.pm-backup');

    try {
      if (this.savedClaudeSettings !== null) {
        writeFileSync(settingsPath, this.savedClaudeSettings);
      } else {
        unlinkSync(settingsPath);
      }
    } catch {
      // Best effort
    }

    // Remove backup — successful restore means crash recovery is no longer needed
    try { if (existsSync(backupPath)) unlinkSync(backupPath); } catch { /* ok */ }

    this.savedClaudeSettings = null;
    this.claudeSettingsInstalled = false;
  }
}
