// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getSettings,
  isEngineSwapEnabled,
  setBouncerClassifier,
  setEffortLevel,
  setModel,
} from '../settings.js';
import type { HandlerContext } from './handler-context.js';
import type { WebSocketMessage, WSContext } from './types.js';

/**
 * Return the stored settings with the resolved `engineSwap` boolean patched
 * in, so web clients always see the effective flag value (env-var override,
 * NODE_ENV default, etc.) rather than the raw — possibly `undefined` —
 * stored field.
 */
function getSettingsWithResolvedFlags() {
  return { ...getSettings(), engineSwap: isEngineSwapEnabled() };
}

export function handleGetSettings(ctx: HandlerContext, ws: WSContext): void {
  ctx.send(ws, { type: 'settings', data: getSettingsWithResolvedFlags() });
}

export function handleUpdateSettings(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage): void {
  if (msg.data?.model !== undefined) {
    setModel(msg.data.model);
  }
  if (msg.data?.effortLevel !== undefined) {
    setEffortLevel(msg.data.effortLevel);
  }
  if (msg.data?.bouncerClassifier !== undefined) {
    try {
      setBouncerClassifier(msg.data.bouncerClassifier);
    } catch (err) {
      // Reject crafted payloads (non-eligible model, bad engine) — surface
      // the reason to the requester and skip the broadcast so other clients
      // keep showing the previous valid config.
      const message = err instanceof Error ? err.message : String(err);
      ctx.send(ws, {
        type: 'error',
        data: {
          scope: 'bouncerClassifier',
          message,
        },
      });
      // Still echo the current settings back to the requester so the UI can
      // revert its optimistic update.
      ctx.send(ws, { type: 'settings', data: getSettingsWithResolvedFlags() });
      return;
    }
  }
  ctx.broadcastToAll({ type: 'settingsUpdated', data: getSettingsWithResolvedFlags() });
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
    let responseSent = false;

    const sendSummaryOnce = (summary: string) => {
      if (responseSent) return;
      responseSent = true;
      ctx.send(ws, {
        type: 'notificationSummary',
        tabId,
        data: { summary }
      });
    };

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

      if (code === 0 && stdout.trim()) {
        sendSummaryOnce(stdout.trim().slice(0, 150));
      } else {
        console.error('[WebSocketImproviseHandler] Claude error:', stderr || 'Unknown error');
        sendSummaryOnce(createFallbackSummary(userPrompt));
      }
    });

    claude.on('error', (err: Error) => {
      console.error('[WebSocketImproviseHandler] Failed to spawn Claude:', err);
      sendSummaryOnce(createFallbackSummary(userPrompt));
    });

    // Timeout after 10 seconds
    const timeout = setTimeout(() => {
      claude.kill();
      sendSummaryOnce(createFallbackSummary(userPrompt));
    }, 10000);

    claude.on('close', () => { clearTimeout(timeout); });

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
