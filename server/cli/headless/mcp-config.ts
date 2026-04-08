/**
 * MCP Configuration Generator
 *
 * Generates MCP config with bouncer + user's MCP servers from ~/.claude.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MCP_SERVER_PATH, MSTRO_ROOT } from '../../utils/paths.js';
import { herror, hlog } from './headless-logger.js';

/**
 * Load user's MCP servers from ~/.claude.json (global + project-level)
 */
function loadUserMcpServers(workingDir: string, verbose: boolean): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
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
        const projectServers = (projectConfig as Record<string, unknown>)?.mcpServers;
        if (workingDir.startsWith(projectPath) && typeof projectServers === 'object') {
          Object.assign(servers, projectServers);
        }
      }
    }

    if (verbose) {
      hlog(`[${new Date().toISOString()}] Loaded ${Object.keys(servers).length} user MCP servers from ~/.claude.json`);
    }
  } catch (parseError: unknown) {
    herror(`[${new Date().toISOString()}] Failed to parse ~/.claude.json: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
  }

  return servers;
}

/** Max length for user prompt passed to bouncer (prevents env var size issues). */
const MAX_USER_PROMPT_LENGTH = 4000;

/** Truncate prompt at a word boundary and append a marker so the bouncer knows it's incomplete. */
function truncatePrompt(prompt: string): string {
  const truncated = prompt.slice(0, MAX_USER_PROMPT_LENGTH);
  const lastSpace = truncated.lastIndexOf(' ');
  const clean = lastSpace > MAX_USER_PROMPT_LENGTH * 0.8 ? truncated.slice(0, lastSpace) : truncated;
  return `${clean}... [truncated]`;
}

/**
 * Generate MCP config with bouncer + user's MCP servers from ~/.claude.json.
 * Writes to ~/.mstro/mcp-config-{sessionId}.json for use with --mcp-config flag.
 * Per-session files prevent concurrent sessions from overwriting each other's config.
 *
 * @param userPrompt — The user's original prompt, passed to the bouncer so its
 *   AI layer can distinguish user-requested operations from prompt injection.
 * @param sessionId — Unique session identifier for per-session config isolation.
 */
export function generateMcpConfig(workingDir: string, verbose: boolean = false, userPrompt?: string, sessionId?: string, deployMode?: boolean): string | null {
  try {
    if (!existsSync(MCP_SERVER_PATH)) {
      herror(`[${new Date().toISOString()}] MCP server not found at ${MCP_SERVER_PATH}`);
      return null;
    }

    const bouncerEnv: Record<string, string> = {
      BOUNCER_USE_AI: 'true',
      MSTRO_ROOT: MSTRO_ROOT,
    };
    if (deployMode) {
      bouncerEnv.BOUNCER_DEPLOY_MODE = 'true';
    }
    if (userPrompt) {
      bouncerEnv.BOUNCER_USER_PROMPT = userPrompt.length > MAX_USER_PROMPT_LENGTH
        ? truncatePrompt(userPrompt)
        : userPrompt;
    }

    const mcpServers: Record<string, unknown> = {
      'mstro-bouncer': {
        command: 'npx',
        args: ['tsx', MCP_SERVER_PATH],
        description: 'Mstro security bouncer for approving/denying Claude Code tool use',
        env: bouncerEnv,
      },
      ...loadUserMcpServers(workingDir, verbose)
    };

    const configDir = join(homedir(), '.mstro');
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    const configFileName = sessionId ? `mcp-config-${sessionId}.json` : 'mcp-config.json';
    const configPath = join(configDir, configFileName);
    writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));

    if (verbose) {
      hlog(`[${new Date().toISOString()}] Generated MCP config at ${configPath} (${Object.keys(mcpServers).length} servers)`);
    }

    return configPath;
  } catch (error: unknown) {
    herror(`[${new Date().toISOString()}] Failed to generate MCP config: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
