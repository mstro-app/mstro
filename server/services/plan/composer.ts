// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Plan Composer — Handles natural language prompts for PPS creation/editing.
 *
 * When a planPrompt message arrives, this builds a context-enriched prompt
 * against the .pm/ (or legacy .plan/) directory and spawns a scoped
 * HeadlessRunner session to execute it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HeadlessRunner, type ToolUseEvent } from '../../cli/headless/index.js';
import type { HandlerContext } from '../websocket/handler-context.js';
import type { WSContext } from '../websocket/types.js';
import { getNextId, parsePlanDirectory, resolvePmDir } from './parser.js';

const PROMPT_TOOL_MESSAGES: Record<string, string> = {
  Glob: 'Discovering project files...',
  Read: 'Reading project structure...',
  Grep: 'Searching codebase...',
  Write: 'Creating project files...',
  Edit: 'Updating project files...',
  Bash: 'Running commands...',
};

function getPromptToolCompleteMessage(event: ToolUseEvent): string | null {
  const input = event.completeInput;
  if (!input) return null;
  if (event.toolName === 'Write' && input.file_path) {
    const filename = String(input.file_path).split('/').pop() ?? '';
    return `Created ${filename}`;
  }
  if (event.toolName === 'Edit' && input.file_path) {
    const filename = String(input.file_path).split('/').pop() ?? '';
    return `Updated ${filename}`;
  }
  if (event.toolName === 'Read' && input.file_path) {
    return `Read ${String(input.file_path).split('/').slice(-2).join('/')}`;
  }
  return null;
}

function createPromptProgressTracker() {
  const seenToolStarts = new Set<string>();

  return (event: ToolUseEvent): string | null => {
    if (event.type === 'tool_start' && event.toolName) {
      if (seenToolStarts.has(event.toolName)) return null;
      seenToolStarts.add(event.toolName);
      return PROMPT_TOOL_MESSAGES[event.toolName] ?? null;
    }
    if (event.type === 'tool_complete') return getPromptToolCompleteMessage(event);
    return null;
  };
}

function readFileOrEmpty(path: string): string {
  try {
    if (existsSync(path)) return readFileSync(path, 'utf-8');
  } catch { /* skip */ }
  return '';
}

export async function handlePlanPrompt(
  ctx: HandlerContext,
  ws: WSContext,
  userPrompt: string,
  workingDir: string,
): Promise<void> {
  const pmDir = resolvePmDir(workingDir) ?? join(workingDir, '.pm');
  const stateContent = readFileOrEmpty(join(pmDir, 'STATE.md'));
  const projectContent = readFileOrEmpty(join(pmDir, 'project.md'));

  // Compute next available IDs
  const fullState = parsePlanDirectory(workingDir);
  let idInfo = '';
  if (fullState) {
    const nextIS = getNextId(fullState.issues, 'IS');
    const nextBG = getNextId(fullState.issues, 'BG');
    const nextEP = getNextId(fullState.issues, 'EP');
    idInfo = `Next available IDs: ${nextIS}, ${nextBG}, ${nextEP}`;
  }

  const enrichedPrompt = `You are managing a project in the .pm/ directory format (Project Plan Spec).
The project's current state is:

<state>
${stateContent || 'No STATE.md exists yet'}
</state>

<project>
${projectContent || 'No project.md yet'}
</project>

${idInfo}

Follow these rules:
- When creating .pm/ files, use YAML front matter + markdown body
- When modifying issues, preserve all existing YAML fields you don't change
- After any state change, update STATE.md to reflect the new status
- Use the next available ID for new entities
- Respond briefly describing what you did

User request: ${userPrompt}`;

  try {
    ctx.broadcastToAll({
      type: 'planPromptProgress',
      data: { message: 'Starting project planning...' },
    });

    const runner = new HeadlessRunner({
      workingDir,
      directPrompt: enrichedPrompt,
      outputCallback: (text: string) => {
        ctx.send(ws, {
          type: 'planPromptStreaming',
          data: { token: text },
        });
      },
      toolUseCallback: (() => {
        const getProgressMessage = createPromptProgressTracker();
        return (event: ToolUseEvent) => {
          const message = getProgressMessage(event);
          if (message) {
            ctx.broadcastToAll({
              type: 'planPromptProgress',
              data: { message },
            });
          }
        };
      })(),
    });

    ctx.broadcastToAll({
      type: 'planPromptProgress',
      data: { message: 'Claude is planning your project...' },
    });

    const result = await runner.run();

    ctx.broadcastToAll({
      type: 'planPromptProgress',
      data: { message: 'Finalizing project plan...' },
    });

    ctx.send(ws, {
      type: 'planPromptResponse',
      data: {
        response: result.completed ? 'Prompt executed successfully.' : (result.error || 'Unknown error'),
        success: result.completed,
        error: result.error || null,
      },
    });

    // Re-parse and broadcast updated state
    const updatedState = parsePlanDirectory(workingDir);
    if (updatedState) {
      ctx.broadcastToAll({ type: 'planStateUpdated', data: updatedState });
    }
  } catch (error) {
    ctx.send(ws, {
      type: 'planError',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}
