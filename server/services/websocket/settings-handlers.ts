// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSettings, setModel } from '../settings.js';
import type { HandlerContext } from './handler-context.js';
import type { WebSocketMessage, WSContext } from './types.js';

export function handleGetSettings(ctx: HandlerContext, ws: WSContext): void {
  ctx.send(ws, { type: 'settings', data: getSettings() });
}

export function handleUpdateSettings(ctx: HandlerContext, _ws: WSContext, msg: WebSocketMessage): void {
  if (msg.data?.model !== undefined) {
    setModel(msg.data.model);
  }
  ctx.broadcastToAll({ type: 'settingsUpdated', data: getSettings() });
}

export async function generateNotificationSummary(
  ctx: HandlerContext,
  ws: WSContext,
  tabId: string,
  userPrompt: string,
  output: string,
  workingDir: string
): Promise<void> {
  try {
    const tempDir = join(workingDir, '.mstro', 'tmp');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    let truncatedOutput = output;
    if (output.length > 4000) {
      const firstPart = output.slice(0, 2000);
      const lastPart = output.slice(-1500);
      truncatedOutput = `${firstPart}\n\n... [output truncated] ...\n\n${lastPart}`;
    }

    const summaryPrompt = `You are generating a SHORT browser notification summary for a completed task.
The user ran a task and wants a brief notification to remind them what happened.

USER'S ORIGINAL PROMPT:
"${userPrompt}"

TASK OUTPUT (may be truncated):
${truncatedOutput}

Generate a notification summary following these rules:
1. Maximum 100 characters (this is a browser notification)
2. Focus on the OUTCOME, not the process
3. Be specific about what was accomplished
4. Use past tense (e.g., "Fixed bug in auth.ts", "Added 3 new tests")
5. If there was an error, mention it briefly
6. No emojis, no markdown, just plain text

Respond with ONLY the summary text, nothing else.`;

    const promptFile = join(tempDir, `notif-summary-${Date.now()}.txt`);
    writeFileSync(promptFile, summaryPrompt);

    const systemPrompt = 'You are a notification summary assistant. Respond with only the summary text, no preamble or explanation.';

    const args = [
      '--print',
      '--model', 'haiku',
      '--system-prompt', systemPrompt,
      promptFile
    ];

    const claude = spawn('claude', args, {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    claude.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    claude.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    claude.on('close', (code: number | null) => {
      try {
        unlinkSync(promptFile);
      } catch {
        // Ignore cleanup errors
      }

      let summary: string;
      if (code === 0 && stdout.trim()) {
        summary = stdout.trim().slice(0, 150);
      } else {
        console.error('[WebSocketImproviseHandler] Claude error:', stderr || 'Unknown error');
        summary = createFallbackSummary(userPrompt);
      }

      ctx.send(ws, {
        type: 'notificationSummary',
        tabId,
        data: { summary }
      });
    });

    claude.on('error', (err: Error) => {
      console.error('[WebSocketImproviseHandler] Failed to spawn Claude:', err);
      const summary = createFallbackSummary(userPrompt);
      ctx.send(ws, {
        type: 'notificationSummary',
        tabId,
        data: { summary }
      });
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      claude.kill();
      const summary = createFallbackSummary(userPrompt);
      ctx.send(ws, {
        type: 'notificationSummary',
        tabId,
        data: { summary }
      });
    }, 10000);

  } catch (error) {
    console.error('[WebSocketImproviseHandler] Error generating summary:', error);
    const summary = createFallbackSummary(userPrompt);
    ctx.send(ws, {
      type: 'notificationSummary',
      tabId,
      data: { summary }
    });
  }
}

function createFallbackSummary(userPrompt: string): string {
  const truncated = userPrompt.slice(0, 60);
  if (userPrompt.length > 60) {
    return `Completed: "${truncated}..."`;
  }
  return `Completed: "${truncated}"`;
}
