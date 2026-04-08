// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Agent Prompt Loader — loads review agent prompts from markdown files.
 *
 * Resolution order (first match wins):
 *   1. Board-level override:  {boardDir}/agents/{agentName}.md
 *   2. System default:        cli/server/services/plan/agents/{agentName}.md
 *
 * Files use YAML frontmatter + markdown body with {{variable}} placeholders.
 * Falls back to null when no file is found (caller should use hardcoded fallback).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * Load an agent prompt by name with layered resolution.
 *
 * @param agentName - The agent file name without extension (e.g., "review-code")
 * @param variables - Key-value map for {{variable}} substitution
 * @param boardDir  - Optional board directory for board-level overrides
 * @returns The interpolated prompt string, or null if no agent file found
 */
export function loadAgentPrompt(
  agentName: string,
  variables: Record<string, string>,
  boardDir?: string | null,
): string | null {
  const fileName = `${agentName}.md`;

  // 1. Board-level override
  if (boardDir) {
    const boardAgentPath = join(boardDir, 'agents', fileName);
    if (existsSync(boardAgentPath)) {
      try {
        const raw = readFileSync(boardAgentPath, 'utf-8');
        return interpolate(stripFrontmatter(raw), variables);
      } catch { /* fall through to system default */ }
    }
  }

  // 2. System default
  const systemPath = join(SYSTEM_AGENTS_DIR, fileName);
  if (existsSync(systemPath)) {
    try {
      const raw = readFileSync(systemPath, 'utf-8');
      return interpolate(stripFrontmatter(raw), variables);
    } catch { /* return null */ }
  }

  return null;
}
