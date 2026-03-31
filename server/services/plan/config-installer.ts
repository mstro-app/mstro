// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Config Installer — Manages temporary config file modifications for Agent Teams.
 *
 * Installs teammate permissions in .claude/settings.json and bouncer MCP config
 * in .mcp.json before wave execution, then restores originals afterward.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateMcpConfig } from '../../cli/headless/mcp-config.js';

/** Tools that teammates may need during execution */
const REQUIRED_PERMISSIONS = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Agent',
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
  private savedMcpJson: string | null = null;
  private mcpJsonInstalled = false;

  constructor(private workingDir: string) {
    // Recover from prior crash: if backup files exist, restore them
    this.recoverFromCrash();
  }

  /** Restore .claude/settings.json and .mcp.json from backups left by a previous crash. */
  private recoverFromCrash(): void {
    restoreFromBackup(
      join(this.workingDir, '.claude', 'settings.json.pm-backup'),
      join(this.workingDir, '.claude', 'settings.json'),
    );
    restoreFromBackup(
      join(this.workingDir, '.mcp.json.pm-backup'),
      join(this.workingDir, '.mcp.json'),
    );
  }

  /**
   * Pre-approve tools in .claude/settings.json so Agent Teams
   * teammates can work without interactive permission prompts.
   */
  installTeammatePermissions(): void {
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
      // Non-fatal — teammates may hit permission prompts
    }
  }

  /** Restore original .claude/settings.json after wave execution. */
  uninstallTeammatePermissions(): void {
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

  /**
   * Write .mcp.json so Agent Teams teammates auto-discover the bouncer MCP server.
   * Also generates ~/.mstro/mcp-config.json for the team lead (--mcp-config).
   */
  installBouncerForSubagents(): void {
    const mcpJsonPath = join(this.workingDir, '.mcp.json');

    const backupPath = join(this.workingDir, '.mcp.json.pm-backup');
    try {
      const generatedPath = generateMcpConfig(this.workingDir);
      if (!generatedPath) return;

      const mcpConfig = readFileSync(generatedPath, 'utf-8');

      if (existsSync(mcpJsonPath)) {
        this.savedMcpJson = readFileSync(mcpJsonPath, 'utf-8');
        writeFileSync(backupPath, this.savedMcpJson);

        const existing = JSON.parse(this.savedMcpJson);
        const generated = JSON.parse(mcpConfig);
        existing.mcpServers = {
          ...existing.mcpServers,
          'mstro-bouncer': generated.mcpServers['mstro-bouncer'],
        };
        writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2));
      } else {
        writeFileSync(backupPath, '__NONE__');
        writeFileSync(mcpJsonPath, mcpConfig);
      }

      this.mcpJsonInstalled = true;
    } catch {
      // Non-fatal: parent has MCP via --mcp-config, teammates fall back to PreToolUse hooks
    }
  }

  /** Restore or remove .mcp.json after execution. */
  uninstallBouncerForSubagents(): void {
    if (!this.mcpJsonInstalled) return;
    const mcpJsonPath = join(this.workingDir, '.mcp.json');
    const backupPath = join(this.workingDir, '.mcp.json.pm-backup');

    try {
      if (this.savedMcpJson !== null) {
        writeFileSync(mcpJsonPath, this.savedMcpJson);
      } else {
        unlinkSync(mcpJsonPath);
      }
    } catch {
      // Best effort cleanup
    }

    try { if (existsSync(backupPath)) unlinkSync(backupPath); } catch { /* ok */ }

    this.savedMcpJson = null;
    this.mcpJsonInstalled = false;
  }
}
