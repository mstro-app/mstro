// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import type { ChildProcess } from 'node:child_process';
import { hlog } from './headless-logger.js';
import { killProcessGroup } from './runner.js';
import { assessStall, type StallContext } from './stall-assessor.js';
import type { ResolvedHeadlessConfig } from './types.js';

export interface StallAssessmentParams {
  stallCtx: StallContext;
  config: ResolvedHeadlessConfig;
  now: number;
  extensionsGranted: number;
  maxExtensions: number;
  toolWatchdogActive?: boolean;
}

/** Mutable state for stall detection, shared between the interval callback and the outer function */
export interface StallState {
  lastActivityTime: number;
  stallWarningEmitted: boolean;
  assessmentInProgress: boolean;
  extensionsGranted: number;
  currentKillDeadline: number;
  nextWarningAfter: number;
}

/** Terminate a stalled process: SIGTERM then SIGKILL after 5s */
export function terminateStallProcess(
  claudeProcess: ChildProcess,
  interval: ReturnType<typeof setInterval>,
  config: ResolvedHeadlessConfig,
  message: string,
): void {
  clearInterval(interval);
  config.outputCallback?.(message);
  if (claudeProcess.pid) killProcessGroup(claudeProcess.pid, 'SIGTERM');
  setTimeout(() => {
    if (!claudeProcess.killed && claudeProcess.pid) {
      killProcessGroup(claudeProcess.pid, 'SIGKILL');
    }
  }, 5000);
}

/** Run stall assessment and return updated state if extended, null otherwise */
async function runStallAssessment(
  params: StallAssessmentParams,
): Promise<{ extensionsGranted: number; currentKillDeadline: number } | null> {
  const { stallCtx, config, now, extensionsGranted, maxExtensions, toolWatchdogActive } = params;
  try {
    const verdict = await assessStall(stallCtx, config.claudeCommand, config.verbose, toolWatchdogActive);
    if (verdict.action === 'extend') {
      const newExtensions = extensionsGranted + 1;
      const elapsedMin = Math.round(stallCtx.elapsedTotalMs / 60_000);
      const pendingNames = stallCtx.pendingToolNames ?? new Set<string>();

      const isAgentTeamsLead = verdict.reason.includes('Agent Teams lead');
      if (pendingNames.has('Task') || isAgentTeamsLead) {
        config.outputCallback?.(
          `\n[[MSTRO_STALL_EXTENDED]] ${isAgentTeamsLead ? 'Teammates still working' : 'Task subagent still running'} (${elapsedMin} min elapsed). ${verdict.reason}.\n`
        );
      } else {
        config.outputCallback?.(
          `\n[[MSTRO_STALL_EXTENDED]] Process still working (${elapsedMin} min elapsed). ${verdict.reason}. Extension ${newExtensions}/${maxExtensions}.\n`
        );
      }
      if (config.verbose) {
        hlog(`[STALL] Extended by ${Math.round(verdict.extensionMs / 60_000)} min: ${verdict.reason}`);
      }
      return { extensionsGranted: newExtensions, currentKillDeadline: now + verdict.extensionMs };
    }
    config.outputCallback?.(
      `\n[[MSTRO_STALL_CONFIRMED]] Assessment: process likely stalled. ${verdict.reason}.\n`
    );
    if (config.verbose) {
      hlog(`[STALL] Assessment says stalled: ${verdict.reason}`);
    }
  } catch (err) {
    if (config.verbose) {
      hlog(`[STALL] Assessment error: ${err}`);
    }
  }
  return null;
}

/** Run a single stall-check tick */
export async function runStallCheckTick(
  state: StallState,
  opts: {
    perfStart: number;
    stallWarningMs: number;
    stallHardCapMs: number;
    maxExtensions: number;
    stallAssessEnabled: boolean;
    toolWatchdogActive: boolean;
    prompt: string;
    pendingTools: Map<string, string>;
    lastToolInputSummary: string | undefined;
    totalToolCalls: number;
    claudeProcess: ChildProcess;
    stallCheckInterval: ReturnType<typeof setInterval>;
    config: ResolvedHeadlessConfig;
    lastTokenActivityTime: number;
  },
): Promise<void> {
  const now = Date.now();
  const silenceMs = now - state.lastActivityTime;
  const totalElapsed = now - opts.perfStart;
  const tokenSilenceMs = now - opts.lastTokenActivityTime;

  if (totalElapsed >= opts.stallHardCapMs) {
    terminateStallProcess(opts.claudeProcess, opts.stallCheckInterval, opts.config,
      `\n[[MSTRO_ERROR:EXECUTION_STALLED]] Hard time limit reached (${Math.round(opts.stallHardCapMs / 60000)} min total). Terminating process.\n`
    );
    return;
  }

  // Token activity pushes the kill deadline forward
  if (tokenSilenceMs < 60_000 && now < state.currentKillDeadline) {
    const killMs = opts.config.stallKillMs ?? 1_800_000;
    state.currentKillDeadline = Math.max(state.currentKillDeadline, now + killMs);
  }

  if (now >= state.currentKillDeadline) {
    terminateStallProcess(opts.claudeProcess, opts.stallCheckInterval, opts.config,
      `\n[[MSTRO_ERROR:EXECUTION_STALLED]] No output for ${Math.round(silenceMs / 60_000)} minutes. Terminating process.\n`
    );
    return;
  }

  if (silenceMs < opts.stallWarningMs || state.stallWarningEmitted || now < state.nextWarningAfter || state.assessmentInProgress) return;

  const stallCtx: StallContext = {
    originalPrompt: opts.prompt,
    silenceMs,
    lastToolName: opts.pendingTools.size > 0 ? Array.from(opts.pendingTools.values()).pop() : undefined,
    lastToolInputSummary: opts.lastToolInputSummary,
    pendingToolCount: opts.pendingTools.size,
    pendingToolNames: new Set(opts.pendingTools.values()),
    totalToolCalls: opts.totalToolCalls,
    elapsedTotalMs: totalElapsed,
    tokenSilenceMs,
  };

  if (opts.stallAssessEnabled && state.extensionsGranted < opts.maxExtensions) {
    state.assessmentInProgress = true;
    const result = await runStallAssessment({ stallCtx, config: opts.config, now, extensionsGranted: state.extensionsGranted, maxExtensions: opts.maxExtensions, toolWatchdogActive: opts.toolWatchdogActive });
    state.assessmentInProgress = false;

    if (result) {
      state.extensionsGranted = result.extensionsGranted;
      state.currentKillDeadline = result.currentKillDeadline;
      state.nextWarningAfter = now + opts.stallWarningMs;
      return;
    }
  }

  state.stallWarningEmitted = true;
  const killIn = Math.round((state.currentKillDeadline - now) / 60_000);
  opts.config.outputCallback?.(
    `\n[[MSTRO_ERROR:EXECUTION_STALLED]] No output for ${Math.round(silenceMs / 60_000)} minutes. Will terminate in ${killIn} minutes if no activity.\n`
  );
}
