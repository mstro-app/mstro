// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Agent Prompt Loader — loads review agent prompts from Skills and markdown files.
 *
 * Resolution order (first match wins):
 *   1. Board-level override:  {boardDir}/agents/{agentName}.md
 *   2. Project Skill:         {workingDir}/.claude/skills/{agentName}/SKILL.md
 *   3. System default:        cli/server/services/plan/agents/{agentName}.md
 *
 * Files use YAML frontmatter + markdown body with {{variable}} placeholders.
 * Falls back to null when no file is found (caller should use hardcoded fallback).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSkillsDir } from '../../utils/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_AGENTS_DIR = join(__dirname, 'agents');

/** Strip YAML frontmatter (--- ... ---) from markdown, returning just the body. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return content;
  return content.slice(endIdx + 3).trimStart();
}

/** Replace all {{variable}} placeholders with values from the provided map. */
function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in variables ? variables[key] : match;
  });
}

/** Try to load and interpolate a prompt file. Returns null on failure. */
function tryLoadFile(filePath: string, variables: Record<string, string>): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return interpolate(stripFrontmatter(raw), variables);
  } catch {
    return null;
  }
}

/**
 * Load an agent prompt by name with layered resolution.
 *
 * @param agentName  - The agent file name without extension (e.g., "review-code")
 * @param variables  - Key-value map for {{variable}} substitution
 * @param boardDir   - Optional board directory for board-level overrides
 * @param workingDir - Optional working directory for project-level Skill resolution
 * @returns The interpolated prompt string, or null if no agent file found
 */
export function loadAgentPrompt(
  agentName: string,
  variables: Record<string, string>,
  boardDir?: string | null,
  workingDir?: string | null,
): string | null {
  const fileName = `${agentName}.md`;

  // 1. Board-level override
  if (boardDir) {
    const result = tryLoadFile(join(boardDir, 'agents', fileName), variables);
    if (result) return result;
  }

  // 2. Project Skill: {workingDir}/.claude/skills/{agentName}/SKILL.md
  if (workingDir) {
    const skillsDir = findSkillsDir(workingDir);
    if (skillsDir) {
      const result = tryLoadFile(join(skillsDir, agentName, 'SKILL.md'), variables);
      if (result) return result;
    }
  }

  // 3. System default
  return tryLoadFile(join(SYSTEM_AGENTS_DIR, fileName), variables);
}

/**
 * Load a Skill template body by name, stripping frontmatter.
 * Looks in {workingDir}/.claude/skills/{skillName}/SKILL.md first,
 * then falls back to the system agents directory.
 *
 * @param skillName  - The skill directory name (e.g., "code-review")
 * @param workingDir - Working directory for project-level Skill resolution
 * @returns Raw template body (no frontmatter), or null if not found
 */
export function loadSkillTemplate(skillName: string, workingDir?: string): string | null {
  if (workingDir) {
    const skillsDir = findSkillsDir(workingDir);
    if (skillsDir) {
      const path = join(skillsDir, skillName, 'SKILL.md');
      if (existsSync(path)) {
        try {
          return stripFrontmatter(readFileSync(path, 'utf-8'));
        } catch { /* fall through */ }
      }
    }
  }

  // Fallback: system agents directory
  const systemPath = join(SYSTEM_AGENTS_DIR, `${skillName}.md`);
  if (existsSync(systemPath)) {
    try {
      return stripFrontmatter(readFileSync(systemPath, 'utf-8'));
    } catch { /* return null */ }
  }

  return null;
}

/**
 * Load a Skill template and interpolate variables.
 * Convenience wrapper combining loadSkillTemplate + interpolation.
 */
export function loadSkillPrompt(
  skillName: string,
  variables: Record<string, string>,
  workingDir?: string,
): string | null {
  const template = loadSkillTemplate(skillName, workingDir);
  if (!template) return null;
  return interpolate(template, variables);
}
