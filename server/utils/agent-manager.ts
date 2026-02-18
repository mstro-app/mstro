// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Agent Manager
 *
 * Handles agent discovery, installation, and availability checking.
 * Implements pre-flight file copy approach for agent hot-loading.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AgentInfo {
  name: string;
  path: string;
  location: 'bundled' | 'global' | 'project';
  description?: string;
}

export class AgentManager {
  private bundledAgentsPath: string;
  private globalAgentsPath: string;

  constructor() {
    // Path to bundled agents in mstro installation
    // In ES modules, we need to get __dirname equivalent using import.meta.url
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    this.bundledAgentsPath = join(dirname(dirname(__dirname)), '.claude', 'agents');

    // Global user agents directory
    this.globalAgentsPath = join(homedir(), '.claude', 'agents');
  }

  /**
   * Get path to project agents directory
   */
  private getProjectAgentsPath(workingDir: string): string {
    return join(workingDir, '.claude', 'agents');
  }

  /**
   * List all available bundled agents
   */
  listBundledAgents(): AgentInfo[] {
    if (!existsSync(this.bundledAgentsPath)) {
      return [];
    }

    const files = readdirSync(this.bundledAgentsPath)
      .filter(f => f.endsWith('.md') && f !== 'README.md');

    return files.map(file => ({
      name: basename(file, '.md'),
      path: join(this.bundledAgentsPath, file),
      location: 'bundled' as const,
      description: this.extractDescription(join(this.bundledAgentsPath, file))
    }));
  }

  /**
   * List all globally installed agents
   */
  listGlobalAgents(): AgentInfo[] {
    if (!existsSync(this.globalAgentsPath)) {
      return [];
    }

    const files = readdirSync(this.globalAgentsPath)
      .filter(f => f.endsWith('.md'));

    return files.map(file => ({
      name: basename(file, '.md'),
      path: join(this.globalAgentsPath, file),
      location: 'global' as const,
      description: this.extractDescription(join(this.globalAgentsPath, file))
    }));
  }

  /**
   * List all project-level agents
   */
  listProjectAgents(workingDir: string): AgentInfo[] {
    const projectPath = this.getProjectAgentsPath(workingDir);
    if (!existsSync(projectPath)) {
      return [];
    }

    const files = readdirSync(projectPath)
      .filter(f => f.endsWith('.md'));

    return files.map(file => ({
      name: basename(file, '.md'),
      path: join(projectPath, file),
      location: 'project' as const,
      description: this.extractDescription(join(projectPath, file))
    }));
  }

  /**
   * Extract description from agent markdown file (first line after title)
   */
  private extractDescription(filePath: string): string | undefined {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      // Find first non-header line
      for (const line of lines) {
        if (!line.startsWith('#')) {
          return line.trim();
        }
      }
    } catch {
      // Ignore errors
    }
    return undefined;
  }

  /**
   * Check if an agent is available (exists in project, global, or bundled)
   */
  findAgent(agentName: string, workingDir?: string): AgentInfo | null {
    const agentFile = `${agentName}.md`;

    // 1. Check project-level (if working dir provided)
    if (workingDir) {
      const projectPath = join(this.getProjectAgentsPath(workingDir), agentFile);
      if (existsSync(projectPath)) {
        return {
          name: agentName,
          path: projectPath,
          location: 'project',
          description: this.extractDescription(projectPath)
        };
      }
    }

    // 2. Check global
    const globalPath = join(this.globalAgentsPath, agentFile);
    if (existsSync(globalPath)) {
      return {
        name: agentName,
        path: globalPath,
        location: 'global',
        description: this.extractDescription(globalPath)
      };
    }

    // 3. Check bundled
    const bundledPath = join(this.bundledAgentsPath, agentFile);
    if (existsSync(bundledPath)) {
      return {
        name: agentName,
        path: bundledPath,
        location: 'bundled',
        description: this.extractDescription(bundledPath)
      };
    }

    return null;
  }

  /**
   * Ensure an agent is available for use
   * If not in project or global, copy from bundled to project
   */
  async ensureAgentAvailable(agentName: string, workingDir: string): Promise<AgentInfo> {
    const agentFile = `${agentName}.md`;
    const projectPath = join(this.getProjectAgentsPath(workingDir), agentFile);
    const globalPath = join(this.globalAgentsPath, agentFile);
    const bundledPath = join(this.bundledAgentsPath, agentFile);

    // If already in project or global, we're done
    if (existsSync(projectPath)) {
      return {
        name: agentName,
        path: projectPath,
        location: 'project',
        description: this.extractDescription(projectPath)
      };
    }

    if (existsSync(globalPath)) {
      return {
        name: agentName,
        path: globalPath,
        location: 'global',
        description: this.extractDescription(globalPath)
      };
    }

    // Check if bundled agent exists
    if (!existsSync(bundledPath)) {
      throw new Error(`Agent not found: ${agentName}\nNot available in bundled, global, or project agents.`);
    }

    // Copy bundled agent to project
    const targetDir = dirname(projectPath);
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(bundledPath, projectPath);

    return {
      name: agentName,
      path: projectPath,
      location: 'project',
      description: this.extractDescription(projectPath)
    };
  }

  /**
   * Install a specific bundled agent to global directory
   */
  installAgentGlobally(agentName: string): void {
    const agentFile = `${agentName}.md`;
    const bundledPath = join(this.bundledAgentsPath, agentFile);
    const globalPath = join(this.globalAgentsPath, agentFile);

    if (!existsSync(bundledPath)) {
      throw new Error(`Bundled agent not found: ${agentName}`);
    }

    // Create global agents directory if needed
    mkdirSync(this.globalAgentsPath, { recursive: true });

    // Copy to global
    copyFileSync(bundledPath, globalPath);
  }

  /**
   * Install all bundled agents to global directory
   */
  installAllAgentsGlobally(): string[] {
    const bundled = this.listBundledAgents();
    const installed: string[] = [];

    mkdirSync(this.globalAgentsPath, { recursive: true });

    for (const agent of bundled) {
      const targetPath = join(this.globalAgentsPath, `${agent.name}.md`);
      copyFileSync(agent.path, targetPath);
      installed.push(agent.name);
    }

    return installed;
  }

  /**
   * Install a specific bundled agent to project directory
   */
  installAgentToProject(agentName: string, workingDir: string): void {
    const agentFile = `${agentName}.md`;
    const bundledPath = join(this.bundledAgentsPath, agentFile);
    const projectPath = join(this.getProjectAgentsPath(workingDir), agentFile);

    if (!existsSync(bundledPath)) {
      throw new Error(`Bundled agent not found: ${agentName}`);
    }

    // Create project agents directory if needed
    const targetDir = dirname(projectPath);
    mkdirSync(targetDir, { recursive: true });

    // Copy to project
    copyFileSync(bundledPath, projectPath);
  }

  /**
   * Install all bundled agents to project directory
   */
  installAllAgentsToProject(workingDir: string): string[] {
    const bundled = this.listBundledAgents();
    const installed: string[] = [];

    const projectAgentsPath = this.getProjectAgentsPath(workingDir);
    mkdirSync(projectAgentsPath, { recursive: true });

    for (const agent of bundled) {
      const targetPath = join(projectAgentsPath, `${agent.name}.md`);
      copyFileSync(agent.path, targetPath);
      installed.push(agent.name);
    }

    return installed;
  }

  /**
   * Extract agent names from a score object
   */
  extractAgentNamesFromScore(score: any): string[] {
    if (!Array.isArray(score.movements)) return [];

    const names = (score.movements as any[])
      .flatMap(m => Array.isArray(m.musicians) ? m.musicians : [])
      .filter((m: any) => m.type === 'custom')
      .map((m: any) => m.config?.agent || m.role)
      .filter(Boolean);

    return [...new Set<string>(names)];
  }

  /**
   * Ensure all agents required by a score are available
   */
  async ensureScoreAgentsAvailable(score: any, workingDir: string): Promise<Map<string, AgentInfo>> {
    const agentNames = this.extractAgentNamesFromScore(score);
    const results = new Map<string, AgentInfo>();

    for (const agentName of agentNames) {
      const info = await this.ensureAgentAvailable(agentName, workingDir);
      results.set(agentName, info);
    }

    return results;
  }
}

/**
 * Singleton instance
 */
export const agentManager = new AgentManager();
