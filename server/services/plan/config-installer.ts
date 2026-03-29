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

export class ConfigInstaller {
  private savedClaudeSettings: string | null = null;
  private claudeSettingsInstalled = false;
  private savedMcpJson: string | null = null;
  private mcpJsonInstalled = false;

  constructor(private workingDir: string) {}

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

    try {
      if (existsSync(settingsPath)) {
        this.savedClaudeSettings = readFileSync(settingsPath, 'utf-8');
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

    try {
      if (this.savedClaudeSettings !== null) {
        writeFileSync(settingsPath, this.savedClaudeSettings);
      } else {
        unlinkSync(settingsPath);
      }
    } catch {
      // Best effort
    }

    this.savedClaudeSettings = null;
    this.claudeSettingsInstalled = false;
  }

  /**
   * Write .mcp.json so Agent Teams teammates auto-discover the bouncer MCP server.
   * Also generates ~/.mstro/mcp-config.json for the team lead (--mcp-config).
   */
  installBouncerForSubagents(): void {
    const mcpJsonPath = join(this.workingDir, '.mcp.json');

    try {
      const generatedPath = generateMcpConfig(this.workingDir);
      if (!generatedPath) return;

      const mcpConfig = readFileSync(generatedPath, 'utf-8');

      if (existsSync(mcpJsonPath)) {
        this.savedMcpJson = readFileSync(mcpJsonPath, 'utf-8');

        const existing = JSON.parse(this.savedMcpJson);
        const generated = JSON.parse(mcpConfig);
        existing.mcpServers = {
          ...existing.mcpServers,
          'mstro-bouncer': generated.mcpServers['mstro-bouncer'],
        };
        writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2));
      } else {
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

    try {
      if (this.savedMcpJson !== null) {
        writeFileSync(mcpJsonPath, this.savedMcpJson);
      } else {
        unlinkSync(mcpJsonPath);
      }
    } catch {
      // Best effort cleanup
    }

    this.savedMcpJson = null;
    this.mcpJsonInstalled = false;
  }
}
