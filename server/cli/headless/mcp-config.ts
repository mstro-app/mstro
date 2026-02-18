/**
 * MCP Configuration Generator
 *
 * Generates MCP config with bouncer + user's MCP servers from ~/.claude.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MCP_SERVER_PATH, MSTRO_ROOT } from '../../utils/paths.js';

/**
 * Load user's MCP servers from ~/.claude.json (global + project-level)
 */
function loadUserMcpServers(workingDir: string, verbose: boolean): Record<string, any> {
  const servers: Record<string, any> = {};
  const claudeConfigPath = join(homedir(), '.claude.json');

  if (!existsSync(claudeConfigPath)) {
    return servers;
  }

  try {
    const claudeConfig = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));

    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      Object.assign(servers, claudeConfig.mcpServers);
    }

    if (claudeConfig.projects && typeof claudeConfig.projects === 'object') {
      for (const [projectPath, projectConfig] of Object.entries(claudeConfig.projects)) {
        const projectServers = (projectConfig as any)?.mcpServers;
        if (workingDir.startsWith(projectPath) && typeof projectServers === 'object') {
          Object.assign(servers, projectServers);
        }
      }
    }

    if (verbose) {
      console.log(`[${new Date().toISOString()}] Loaded ${Object.keys(servers).length} user MCP servers from ~/.claude.json`);
    }
  } catch (parseError: any) {
    console.error(`[${new Date().toISOString()}] Failed to parse ~/.claude.json: ${parseError.message}`);
  }

  return servers;
}

/**
 * Generate MCP config with bouncer + user's MCP servers from ~/.claude.json.
 * Writes to ~/.mstro/mcp-config.json for use with --mcp-config flag.
 */
export function generateMcpConfig(workingDir: string, verbose: boolean = false): string | null {
  try {
    if (!existsSync(MCP_SERVER_PATH)) {
      console.error(`[${new Date().toISOString()}] MCP server not found at ${MCP_SERVER_PATH}`);
      return null;
    }

    const mcpServers: Record<string, any> = {
      'mstro-bouncer': {
        command: 'npx',
        args: ['tsx', MCP_SERVER_PATH],
        description: 'Mstro security bouncer for approving/denying Claude Code tool use',
        env: { BOUNCER_USE_AI: 'true', MSTRO_ROOT: MSTRO_ROOT }
      },
      ...loadUserMcpServers(workingDir, verbose)
    };

    const configDir = join(homedir(), '.mstro');
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    const configPath = join(configDir, 'mcp-config.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));

    if (verbose) {
      console.log(`[${new Date().toISOString()}] Generated MCP config at ${configPath} (${Object.keys(mcpServers).length} servers)`);
    }

    return configPath;
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] Failed to generate MCP config: ${error.message}`);
    return null;
  }
}
