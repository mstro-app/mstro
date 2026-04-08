// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Plan Composer — Handles natural language prompts for PPS creation/editing.
 *
 * When a planPrompt message arrives, this builds a context-enriched prompt
 * against the .mstro/pm/ directory and spawns a scoped
 * HeadlessRunner session to execute it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWithFileLogger } from '../../cli/headless/headless-logger.js';
import { HeadlessRunner, type ToolUseEvent } from '../../cli/headless/index.js';
import type { HandlerContext } from '../websocket/handler-context.js';
import type { WSContext } from '../websocket/types.js';
import { defaultPmDir, getNextId, parseBoardDirectory, parsePlanDirectory, resolvePmDir } from './parser.js';
import type { Issue } from './types.js';

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

interface ComposerContext {
  boardContext: string;
  stateContent: string;
  issues: Issue[];
  idInfo: string;
  epicContext: string;
  issuesSummary: string;
  boardDir: string;
  backlogPath: string;
  effectiveBoardId: string | null;
}

function buildComposerContext(pmDir: string, workingDir: string, boardId?: string): ComposerContext {
  const fullState = parsePlanDirectory(workingDir);
  const effectiveBoardId = boardId ?? fullState?.workspace?.activeBoardId ?? null;

  let boardContext = '';
  let stateContent = '';
  let issues: Issue[] = [];

  if (effectiveBoardId) {
    const boardState = parseBoardDirectory(pmDir, effectiveBoardId);
    if (boardState) {
      stateContent = readFileOrEmpty(join(pmDir, 'boards', effectiveBoardId, 'STATE.md'));
      issues = boardState.issues;
      boardContext = `\nActive board: ${effectiveBoardId} — "${boardState.board.title}"
Board status: ${boardState.board.status}
Board goal: ${boardState.board.goal || '(none set)'}
Board directory: ${pmDir}/boards/${effectiveBoardId}/
Backlog directory: ${pmDir}/boards/${effectiveBoardId}/backlog/\n`;
    }
  }

  if (!stateContent) stateContent = readFileOrEmpty(join(pmDir, 'STATE.md'));
  if (issues.length === 0 && fullState) issues = fullState.issues;

  const idInfo = (issues.length > 0 || fullState)
    ? `Next available IDs: ${getNextId(issues, 'IS')}, ${getNextId(issues, 'BG')}, ${getNextId(issues, 'EP')}`
    : '';

  const existingEpics = issues.filter(i => i.type === 'epic');
  const epicContext = existingEpics.length > 0
    ? `\nExisting epics:\n${existingEpics.map(e => `- ${e.id}: ${e.title} (${e.path}, children: ${e.children.length})`).join('\n')}\n`
    : '';

  const nonEpicIssues = issues.filter(i => i.type !== 'epic');
  const issuesSummary = nonEpicIssues.length > 0
    ? `\nExisting issues on this board:\n${nonEpicIssues.map(i => `- ${i.id}: ${i.title} [${i.status}] (P${i.priority})`).join('\n')}\n`
    : '';

  const boardDir = effectiveBoardId ? `boards/${effectiveBoardId}` : '';
  const backlogPath = effectiveBoardId
    ? `${pmDir}/boards/${effectiveBoardId}/backlog/`
    : `${pmDir}/backlog/`;

  return { boardContext, stateContent, issues, idInfo, epicContext, issuesSummary, boardDir, backlogPath, effectiveBoardId };
}

export async function handlePlanPrompt(
  ctx: HandlerContext,
  ws: WSContext,
  userPrompt: string,
  workingDir: string,
  boardId?: string,
): Promise<void> {
  const pmDir = resolvePmDir(workingDir) ?? defaultPmDir(workingDir);
  const projectContent = readFileOrEmpty(join(pmDir, 'project.md'));
  const cc = buildComposerContext(pmDir, workingDir, boardId);

  const enrichedPrompt = `You are managing a project using a board-centric PM system (Project Plan Spec v2).
All issues belong to a board. Each board has its own backlog/, STATE.md, and out/ directory.
${cc.boardContext}
<state>
${cc.stateContent || 'No STATE.md exists yet'}
</state>

<project>
${projectContent || 'No project.md yet'}
</project>

${cc.idInfo}
${cc.epicContext}
${cc.issuesSummary}

## Directory structure

\`\`\`
${pmDir}/
├── project.md
├── workspace.json
└── boards/
    └── ${cc.effectiveBoardId || 'BOARD-NNN'}/
        ├── board.md          # Board metadata
        ├── STATE.md          # Board execution state
        ├── backlog/          # Issues, epics, bugs
        │   ├── EP-*.md
        │   ├── IS-*.md
        │   └── BG-*.md
        ├── out/              # Output artifacts
        ├── reviews/          # Review gate results
        └── progress.md       # Execution log
\`\`\`

## Rules

- ALL new issue files MUST be created in \`${cc.backlogPath}\`
- Use YAML front matter + markdown body for all files
- When modifying issues, preserve all existing YAML fields you don't change
- After any state change, update the board's STATE.md at \`${pmDir}/${cc.boardDir}/STATE.md\`
- Use the next available ID for new entities
- Set all new issue statuses to \`todo\` so they appear in the "Ready to Work" section
- Respond briefly describing what you did

## Issue format

Each issue file must have this structure:
\`\`\`markdown
---
id: IS-NNN
title: "Short descriptive title"
type: issue
status: todo
priority: P0|P1|P2|P3
estimate: 1-5
labels: []
epic: backlog/EP-NNN.md    # if part of an epic
created: "YYYY-MM-DD"
blocked_by: []             # Use backlog-relative paths: backlog/IS-NNN.md
blocks: []                 # Use backlog-relative paths: backlog/IS-NNN.md
review_gate: auto
output_file: null
---

# IS-NNN: Title

## Description
What needs to be done and why.

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Technical Notes
Implementation guidance.

## Files to Modify
- path/to/file.ts

## Activity
\`\`\`

## Issue scoping rules (critical for execution quality)

- Each issue is executed by a single AI agent with its own context window
- Issues estimated at 1-3 story points execute well (focused, single concern)
- Issues at 5 story points are viable if scoped to one subsystem
- Issues at 8+ story points MUST be decomposed into smaller sub-issues
- Issues at 13+ story points MUST become an epic with child issues
- Each issue should touch one logical concern (one component, one service, one data flow)
- If an issue requires work across multiple subsystems, split it into one issue per subsystem with blocked_by edges between them
- Research/investigation issues should be separate from implementation issues

## Epic creation rules

- Create an EP-*.md file in ${cc.backlogPath} with type: epic and a children: [] field in front matter
- Create individual IS-*.md (or BG-*.md) files for each child issue
- Each child issue must have epic: backlog/EP-XXX.md in its front matter
- The epic's children field must list all child paths: [backlog/IS-001.md, backlog/IS-002.md, ...]
- Set blocked_by between child issues where there are natural dependencies
- Give each child issue clear acceptance criteria and files to modify when possible
- Set appropriate priorities (P0-P3) based on the issue's importance within the epic

User request: ${userPrompt}`;

  try {
    ctx.broadcastToAll({
      type: 'planPromptProgress',
      data: { message: 'Starting project planning...' },
    });

    const runner = new HeadlessRunner({
      workingDir,
      directPrompt: enrichedPrompt,
      stallWarningMs: 300_000,   // 5 min — compose usually finishes quickly
      stallKillMs: 900_000,      // 15 min
      stallHardCapMs: 1_800_000, // 30 min hard cap
      verbose: true,
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

    const boardLogDir = cc.effectiveBoardId ? join(pmDir, 'boards', cc.effectiveBoardId, 'logs') : undefined;
    const result = await runWithFileLogger('pm-compose', () => runner.run(), boardLogDir);

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
