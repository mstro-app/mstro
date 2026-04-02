// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import type { ChildProcess } from 'node:child_process';
import type { StallState } from './claude-invoker-stall.js';
import type { StreamHandlerContext } from './claude-invoker-stream.js';
import { verboseLog } from './claude-invoker-stream.js';
import { killProcessGroup } from './runner.js';
import { assessToolTimeout } from './stall-assessor.js';
import { ToolWatchdog } from './tool-watchdog.js';
import type { ResolvedHeadlessConfig, ToolUseEvent } from './types.js';

// ========== Tool Tracking ==========

/** Summarize a tool's input for stall assessment context */
function summarizeToolInput(input: Record<string, unknown>): string | undefined {
  try {
    if (input.description) return String(input.description).slice(0, 200);
    if (input.prompt) return String(input.prompt).slice(0, 200);
    if (input.command) return String(input.command).slice(0, 200);
    if (input.pattern) return `pattern: ${String(input.pattern).slice(0, 100)}`;
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return undefined;
  }
}

/** Shared mutable state for tool event handlers */
interface ToolTrackingState {
  pendingTools: Map<string, string>;
  counters: { lastToolInputSummary: string | undefined; totalToolCalls: number };
  toolIdToName: Map<string, string>;
  toolIdToInput: Map<string, Record<string, unknown>>;
  watchdog: ToolWatchdog | null;
  stallState: StallState;
  ctx: StreamHandlerContext;
  onTimeout: (hungToolId: string) => void;
}

export interface ToolTrackingResult {
  pendingTools: Map<string, string>;
  watchdog: ToolWatchdog | null;
  toolWatchdogActive: boolean;
  counters: { lastToolInputSummary: string | undefined; totalToolCalls: number };
  /** Must be called after stallCheckInterval is created, to wire up the kill handler */
  setKillContext: (claudeProcess: ChildProcess, stallCheckInterval: ReturnType<typeof setInterval>) => void;
}

function onToolStart(event: ToolUseEvent, s: ToolTrackingState): void {
  const id = event.toolId!;
  s.pendingTools.set(id, event.toolName!);
  s.counters.totalToolCalls++;
  s.toolIdToName.set(id, event.toolName!);
  if (s.watchdog) {
    s.watchdog.startWatch(id, event.toolName!, {}, () => { s.onTimeout(id); });
  }
}

function onToolComplete(event: ToolUseEvent, s: ToolTrackingState): void {
  const id = event.toolId!;
  const input = event.completeInput ?? {};
  s.counters.lastToolInputSummary = summarizeToolInput(input);
  s.toolIdToInput.set(id, input);
  if (!s.watchdog) return;
  const toolName = s.toolIdToName.get(id);
  if (toolName) {
    s.watchdog.startWatch(id, toolName, input, () => { s.onTimeout(id); });
  }
}

function onToolResult(event: ToolUseEvent, s: ToolTrackingState): void {
  const id = event.toolId!;
  s.pendingTools.delete(id);
  s.stallState.stallWarningEmitted = false;
  s.stallState.lastActivityTime = Date.now();
  const toolEntry = s.ctx.accumulatedToolUse.find(t => t.toolId === id);
  if (!s.watchdog || !toolEntry) return;
  const toolName = s.toolIdToName.get(id);
  if (toolName && toolEntry.duration) {
    s.watchdog.recordCompletion(toolName, toolEntry.duration);
  }
  s.watchdog.clearWatch(id);
}

/** Resolve a display URL from tool input for timeout messages */
function resolveToolUrl(toolInput: Record<string, unknown>): string | undefined {
  if (toolInput.url) return String(toolInput.url);
  if (toolInput.query) return String(toolInput.query);
  return undefined;
}

/** Handle a tool timeout by building a checkpoint and killing the process */
function executeToolTimeout(
  hungToolId: string,
  watchdog: ToolWatchdog,
  killCtx: { claudeProcess: ChildProcess; stallCheckInterval: ReturnType<typeof setInterval> },
  s: ToolTrackingState,
  config: ResolvedHeadlessConfig,
  prompt: string,
  sessionCapture: { claudeSessionId?: string },
  perfStart: number,
): void {
  const checkpoint = watchdog.buildCheckpoint(
    prompt, s.ctx.accumulatedAssistantResponse, s.ctx.accumulatedThinking,
    s.ctx.accumulatedToolUse, hungToolId, sessionCapture.claudeSessionId, perfStart,
  );

  const toolName = s.toolIdToName.get(hungToolId) || 'unknown';
  const toolInput = s.toolIdToInput.get(hungToolId) || {};
  const timeoutMs = watchdog.getTimeout(toolName);
  const url = resolveToolUrl(toolInput);

  config.outputCallback?.(
    `\n[[MSTRO_TOOL_TIMEOUT]] ${toolName} timed out after ${Math.round(timeoutMs / 1000)}s${url ? ` fetching: ${url.slice(0, 100)}` : ''}. ${s.ctx.accumulatedToolUse.filter(t => t.result !== undefined).length} completed results preserved.\n`
  );

  if (checkpoint) {
    config.onToolTimeout?.(checkpoint);
  }

  verboseLog(config.verbose, `[WATCHDOG] Killing process due to ${toolName} timeout`);
  watchdog.clearAll();
  clearInterval(killCtx.stallCheckInterval);
  if (killCtx.claudeProcess.pid) killProcessGroup(killCtx.claudeProcess.pid, 'SIGTERM');
  const proc = killCtx.claudeProcess;
  setTimeout(() => { if (!proc.killed && proc.pid) killProcessGroup(proc.pid, 'SIGKILL'); }, 5000);
}

/** Set up tool activity tracking and watchdog */
export function setupToolTracking(
  config: ResolvedHeadlessConfig,
  stallState: StallState,
  ctx: StreamHandlerContext,
  sessionCapture: { claudeSessionId?: string },
  prompt: string,
  perfStart: number,
): ToolTrackingResult {
  const pendingTools = new Map<string, string>();
  const counters = { lastToolInputSummary: undefined as string | undefined, totalToolCalls: 0 };

  const toolWatchdogActive = config.enableToolWatchdog !== false;
  const watchdog = toolWatchdogActive
    ? new ToolWatchdog({
        profiles: config.toolTimeoutProfiles,
        verbose: config.verbose,
        onTiebreaker: async (toolName, toolInput, elapsedMs, tokenSilenceMs) => {
          return assessToolTimeout(toolName, toolInput, elapsedMs, config.claudeCommand, config.verbose, tokenSilenceMs);
        },
        getTokenSilenceMs: () => {
          const last = ctx.lastTokenActivityTime;
          return last > 0 ? Date.now() - last : undefined;
        },
      })
    : null;

  let killCtx: { claudeProcess: ChildProcess; stallCheckInterval: ReturnType<typeof setInterval> } | null = null;

  const trackingState: ToolTrackingState = {
    pendingTools, counters,
    toolIdToName: new Map(), toolIdToInput: new Map(),
    watchdog, stallState, ctx,
    onTimeout: (hungToolId) => {
      if (!watchdog || !killCtx) return;
      executeToolTimeout(hungToolId, watchdog, killCtx, trackingState, config, prompt, sessionCapture, perfStart);
    },
  };

  const origToolUseCallback = config.toolUseCallback;

  config.toolUseCallback = (event) => {
    if (event.type === 'tool_start' && event.toolName && event.toolId) {
      onToolStart(event, trackingState);
    } else if (event.type === 'tool_complete' && event.completeInput && event.toolId) {
      onToolComplete(event, trackingState);
    } else if (event.type === 'tool_result' && event.toolId) {
      onToolResult(event, trackingState);
    }
    origToolUseCallback?.(event);
  };

  return {
    pendingTools, watchdog, toolWatchdogActive, counters,
    setKillContext: (claudeProcess, stallCheckInterval) => {
      killCtx = { claudeProcess, stallCheckInterval };
    },
  };
}
