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
import { HeadlessRunner } from '../../cli/headless/index.js';
import type { HandlerContext } from '../websocket/handler-context.js';
import type { WSContext } from '../websocket/types.js';
import { getNextId, parsePlanDirectory, resolvePmDir } from './parser.js';

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
    const runner = new HeadlessRunner({
      workingDir,
      directPrompt: enrichedPrompt,
      outputCallback: (text: string) => {
        ctx.send(ws, {
          type: 'planPromptStreaming',
          data: { token: text },
        });
      },
    });

    const result = await runner.run();

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
