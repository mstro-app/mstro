// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Tool Watchdog
 *
 * Per-tool adaptive timeout system using TCP RTO-style EMA tracking (RFC 6298).
 * Monitors individual tool call durations and kills tools that exceed their
 * adaptive timeout, preserving work via checkpoint-and-retry.
 *
 * Three-tier timeout strategy:
 * 1. EMA tracking: timeout = estimatedDuration + 4 * deviation
 * 2. Floor/ceiling bounds: never kill below floor, always kill at ceiling
 * 3. Haiku tiebreaker: optional AI assessment before killing ambiguous cases
 */

import { hlog } from './headless-logger.js';
import type {
  ExecutionCheckpoint,
  ToolDurationTracker,
  ToolTimeoutProfile,
  ToolUseAccumulator,
} from './types.js';

// RFC 6298 smoothing constants
const ALPHA = 0.125;  // smoothing factor for duration EMA
const BETA = 0.25;    // smoothing factor for deviation EMA
const DEVIATION_MULTIPLIER = 4;  // timeout = est + 4*dev (same as TCP)

/** Default timeout profiles per tool type */
export const DEFAULT_TOOL_TIMEOUT_PROFILES: Record<string, ToolTimeoutProfile> = {
  WebFetch: {
    coldStartMs: 180_000,      // 3 min — accounts for slow sites + Haiku inference
    floorMs: 120_000,          // 2 min absolute minimum
    ceilingMs: 300_000,        // 5 min hard cap
    useAdaptive: true,
    useHaikuTiebreaker: true,
  },
  WebSearch: {
    coldStartMs: 90_000,       // 1.5 min
    floorMs: 60_000,           // 1 min minimum
    ceilingMs: 180_000,        // 3 min hard cap
    useAdaptive: true,
    useHaikuTiebreaker: false,
  },
  Task: {
    coldStartMs: 900_000,      // 15 min — subagents are inherently long-running
    floorMs: 600_000,          // 10 min minimum (research agents routinely take 7-10 min)
    ceilingMs: 2_700_000,      // 45 min hard cap
    useAdaptive: true,         // learn from past Task durations via EMA
    useHaikuTiebreaker: true,
  },
  // Claude Code renamed the Task tool to Agent — keep both for backward compatibility
  Agent: {
    coldStartMs: 900_000,      // 15 min — subagents are inherently long-running
    floorMs: 600_000,          // 10 min minimum (research agents routinely take 7-10 min)
    ceilingMs: 2_700_000,      // 45 min hard cap
    useAdaptive: true,         // learn from past Agent durations via EMA
    useHaikuTiebreaker: true,
  },
  Bash: {
    coldStartMs: 300_000,      // 5 min
    floorMs: 120_000,          // 2 min minimum
    ceilingMs: 600_000,        // 10 min hard cap
    useAdaptive: false,
    useHaikuTiebreaker: true,
  },
  // Local filesystem tools — these go through Claude Code's streaming stdio protocol,
  // NOT direct filesystem I/O. Large files/results can take 30-60s+ to stream.
  // Read/Grep have bimodal distributions (tiny vs huge responses) that defeat EMA,
  // so adaptive is disabled for them. Floors are generous to prevent premature kills.
  Read: {
    coldStartMs: 120_000,      // 2 min — large files stream slowly through stdio protocol
    floorMs: 60_000,           // 1 min minimum — prevents EMA-driven premature kills
    ceilingMs: 300_000,        // 5 min ceiling (very large files, slow mounts)
    useAdaptive: false,        // bimodal: 1-line file vs 2000-line file defeats EMA
    useHaikuTiebreaker: true,  // safety net: assess before killing the whole process
  },
  Grep: {
    coldStartMs: 120_000,      // 2 min — broad searches return large result sets
    floorMs: 60_000,           // 1 min minimum
    ceilingMs: 300_000,        // 5 min ceiling
    useAdaptive: false,        // bimodal: single-file vs codebase-wide search
    useHaikuTiebreaker: true,  // safety net before killing
  },
  Glob: {
    coldStartMs: 60_000,       // 1 min — pattern matching can be slow on large trees
    floorMs: 30_000,           // 30s minimum
    ceilingMs: 180_000,        // 3 min ceiling
    useAdaptive: true,
    useHaikuTiebreaker: true,
  },
  Edit: {
    coldStartMs: 60_000,       // 1 min — edits go through streaming protocol too
    floorMs: 30_000,           // 30s minimum
    ceilingMs: 180_000,        // 3 min ceiling
    useAdaptive: true,
    useHaikuTiebreaker: true,
  },
  Write: {
    coldStartMs: 300_000,      // 5 min — large docs stream slowly through stdio; model generates content inline
    floorMs: 120_000,          // 2 min minimum — prevents premature kills on big writes
    ceilingMs: 600_000,        // 10 min hard cap
    useAdaptive: false,        // bimodal: 1-line config vs 50KB research doc defeats EMA
    useHaikuTiebreaker: true,
  },
};

const DEFAULT_TOOL_TIMEOUT_PROFILE: ToolTimeoutProfile = {
  coldStartMs: 300_000,
  floorMs: 120_000,
  ceilingMs: 600_000,
  useAdaptive: false,
  useHaikuTiebreaker: true,
};

export interface ToolWatchdogOptions {
  profiles?: Record<string, Partial<ToolTimeoutProfile>>;
  verbose?: boolean;
  /** Called before killing — if returns 'extend', reschedule with extensionMs */
  onTiebreaker?: (toolName: string, toolInput: Record<string, unknown>, elapsedMs: number, tokenSilenceMs?: number) => Promise<{ action: 'extend' | 'kill'; extensionMs: number; reason: string }>;
  /** Returns ms since last token activity. Called at tiebreaker time for fresh data. */
  getTokenSilenceMs?: () => number | undefined;
}

interface ActiveWatch {
  toolName: string;
  toolInput: Record<string, unknown>;
  startTime: number;
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
  tiebreakerAttempted: boolean;
}

export class ToolWatchdog {
  private trackers: Map<string, ToolDurationTracker> = new Map();
  private profiles: Record<string, ToolTimeoutProfile>;
  private activeWatches: Map<string, ActiveWatch> = new Map();
  private verbose: boolean;
  private onTiebreaker?: ToolWatchdogOptions['onTiebreaker'];
  private getTokenSilenceMs?: () => number | undefined;

  constructor(options: ToolWatchdogOptions = {}) {
    this.verbose = options.verbose ?? false;
    this.onTiebreaker = options.onTiebreaker;
    this.getTokenSilenceMs = options.getTokenSilenceMs;

    // Merge user profiles with defaults
    this.profiles = { ...DEFAULT_TOOL_TIMEOUT_PROFILES };
    if (options.profiles) {
      for (const [name, partial] of Object.entries(options.profiles)) {
        const base = this.profiles[name] || DEFAULT_TOOL_TIMEOUT_PROFILE;
        this.profiles[name] = { ...base, ...partial };
      }
    }
  }

  /** Record a tool completion — updates the EMA tracker for its type */
  recordCompletion(toolName: string, durationMs: number): void {
    const profile = this.getProfile(toolName);
    if (!profile.useAdaptive) return;

    const tracker = this.trackers.get(toolName);
    if (!tracker) {
      this.trackers.set(toolName, {
        estimatedDuration: durationMs,
        deviation: durationMs / 2,
        sampleCount: 1,
      });
      if (this.verbose) {
        hlog(`[WATCHDOG] ${toolName}: first sample ${durationMs}ms, initial timeout ${this.getTimeout(toolName)}ms`);
      }
      return;
    }

    // RFC 6298 update
    tracker.deviation = (1 - BETA) * tracker.deviation + BETA * Math.abs(durationMs - tracker.estimatedDuration);
    tracker.estimatedDuration = (1 - ALPHA) * tracker.estimatedDuration + ALPHA * durationMs;
    tracker.sampleCount++;

    if (this.verbose) {
      hlog(`[WATCHDOG] ${toolName}: sample #${tracker.sampleCount} ${durationMs}ms, est=${Math.round(tracker.estimatedDuration)}ms, dev=${Math.round(tracker.deviation)}ms, timeout=${this.getTimeout(toolName)}ms`);
    }
  }

  /** Compute the current timeout for a tool type */
  getTimeout(toolName: string): number {
    const profile = this.getProfile(toolName);
    if (!profile.useAdaptive) return profile.coldStartMs;

    const tracker = this.trackers.get(toolName);
    if (!tracker || tracker.sampleCount < 1) return profile.coldStartMs;

    const adaptive = tracker.estimatedDuration + DEVIATION_MULTIPLIER * tracker.deviation;
    return Math.max(profile.floorMs, Math.min(profile.ceilingMs, adaptive));
  }

  /** Get the profile for a tool (with fallback to default) */
  getProfile(toolName: string): ToolTimeoutProfile {
    return this.profiles[toolName] || DEFAULT_TOOL_TIMEOUT_PROFILE;
  }

  /** Start watching a tool call */
  startWatch(toolId: string, toolName: string, toolInput: Record<string, unknown>, onTimeout: () => void): void {
    // Clear any existing watch for this ID
    this.clearWatch(toolId);

    const timeoutMs = this.getTimeout(toolName);
    const profile = this.getProfile(toolName);

    if (this.verbose) {
      hlog(`[WATCHDOG] Starting watch: ${toolName} (${toolId}), timeout=${Math.round(timeoutMs / 1000)}s`);
    }

    const timer = setTimeout(async () => {
      const extended = await this.handleTimeoutWithTiebreaker(toolId, toolName, toolInput, profile, onTimeout);
      if (!extended) {
        // Don't delete the watch here — buildCheckpoint() needs it.
        // handleToolTimeout() calls clearAll() after building the checkpoint.
        onTimeout();
      }
    }, timeoutMs);

    this.activeWatches.set(toolId, {
      toolName,
      toolInput,
      startTime: Date.now(),
      timer,
      timeoutMs,
      tiebreakerAttempted: false,
    });
  }

  /** Handle timeout expiry: attempt tiebreaker if configured, return true if extended */
  private async handleTimeoutWithTiebreaker(
    toolId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    profile: ToolTimeoutProfile,
    onTimeout: () => void,
  ): Promise<boolean> {
    const watch = this.activeWatches.get(toolId);
    if (!watch) return true;

    const elapsedMs = Date.now() - watch.startTime;

    // Activity-gated auto-extension: if data is actively streaming, extend without
    // consuming the one-shot Haiku tiebreaker. Respects ceiling to prevent runaway.
    const tokenSilenceMs = this.getTokenSilenceMs?.();
    if (tokenSilenceMs !== undefined && tokenSilenceMs < 60_000) {
      const remainingToCeiling = profile.ceilingMs - elapsedMs;
      if (remainingToCeiling > 0) {
        const extensionMs = Math.min(5 * 60_000, remainingToCeiling);
        if (this.verbose) {
          hlog(`[WATCHDOG] ${toolName} (${toolId}) hit timeout after ${Math.round(elapsedMs / 1000)}s, but stream active ${Math.round(tokenSilenceMs / 1000)}s ago — auto-extending ${Math.round(extensionMs / 1000)}s`);
        }
        this.scheduleActivityGatedTimeout(watch, toolId, toolName, toolInput, profile, extensionMs, onTimeout);
        watch.timeoutMs = elapsedMs + extensionMs;
        return true;
      }
    }

    if (!profile.useHaikuTiebreaker || !this.onTiebreaker || watch.tiebreakerAttempted) {
      if (this.verbose) {
        hlog(`[WATCHDOG] ${toolName} (${toolId}) timed out after ${Math.round(elapsedMs / 1000)}s, killing`);
      }
      return false;
    }

    return this.runTiebreaker(watch, toolId, toolName, toolInput, elapsedMs, onTimeout);
  }

  /** Execute the Haiku tiebreaker and reschedule if extended */
  private async runTiebreaker(
    watch: ActiveWatch,
    toolId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    elapsedMs: number,
    onTimeout: () => void,
  ): Promise<boolean> {
    watch.tiebreakerAttempted = true;

    if (this.verbose) {
      hlog(`[WATCHDOG] ${toolName} (${toolId}) hit timeout after ${Math.round(elapsedMs / 1000)}s, running tiebreaker...`);
    }

    try {
      const tokenSilenceMs = this.getTokenSilenceMs?.();
      const verdict = await this.onTiebreaker!(toolName, toolInput, elapsedMs, tokenSilenceMs);

      if (verdict.action === 'extend') {
        if (this.verbose) {
          hlog(`[WATCHDOG] Tiebreaker: extend ${toolName} by ${Math.round(verdict.extensionMs / 1000)}s — ${verdict.reason}`);
        }
        this.scheduleExtensionTimeout(watch, toolId, toolName, verdict.extensionMs, onTimeout);
        watch.timeoutMs = elapsedMs + verdict.extensionMs;
        return true;
      }

      if (this.verbose) {
        hlog(`[WATCHDOG] Tiebreaker: kill ${toolName} — ${verdict.reason}`);
      }
    } catch (err) {
      if (this.verbose) {
        hlog(`[WATCHDOG] Tiebreaker failed: ${err}, proceeding with kill`);
      }
    }

    return false;
  }

  /** Schedule an activity-gated timeout that re-enters the full timeout handler */
  private scheduleActivityGatedTimeout(
    watch: ActiveWatch,
    toolId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    profile: ToolTimeoutProfile,
    extensionMs: number,
    onTimeout: () => void,
  ): void {
    watch.timer = setTimeout(async () => {
      const w = this.activeWatches.get(toolId);
      if (!w) return;
      const extended = await this.handleTimeoutWithTiebreaker(toolId, toolName, toolInput, profile, onTimeout);
      if (!extended) {
        onTimeout();
      }
    }, extensionMs);
  }

  /** Schedule a post-extension timeout that kills without another tiebreaker */
  private scheduleExtensionTimeout(
    watch: ActiveWatch,
    toolId: string,
    toolName: string,
    extensionMs: number,
    onTimeout: () => void,
  ): void {
    watch.timer = setTimeout(() => {
      const w = this.activeWatches.get(toolId);
      if (!w) return;
      if (this.verbose) {
        hlog(`[WATCHDOG] ${toolName} (${toolId}) still running after extension, killing`);
      }
      // Don't delete the watch — buildCheckpoint() needs it.
      // handleToolTimeout() calls clearAll() after building the checkpoint.
      onTimeout();
    }, extensionMs);
  }

  /** Stop watching a tool (it completed normally) */
  clearWatch(toolId: string): void {
    const watch = this.activeWatches.get(toolId);
    if (watch) {
      clearTimeout(watch.timer);
      this.activeWatches.delete(toolId);
    }
  }

  /** Clear all active watches (process ending) */
  clearAll(): void {
    for (const [_id, watch] of this.activeWatches) {
      clearTimeout(watch.timer);
    }
    this.activeWatches.clear();
  }

  /** Get the active watch for a tool ID (for checkpoint building) */
  getActiveWatch(toolId: string): ActiveWatch | undefined {
    return this.activeWatches.get(toolId);
  }

  /** Get all active watches */
  getActiveWatches(): Map<string, ActiveWatch> {
    return this.activeWatches;
  }

  /** Build an ExecutionCheckpoint from the current state */
  buildCheckpoint(
    originalPrompt: string,
    assistantText: string,
    thinkingText: string,
    accumulatedToolUse: ToolUseAccumulator[],
    hungToolId: string,
    claudeSessionId: string | undefined,
    processStartTime: number,
  ): ExecutionCheckpoint | null {
    const hungWatch = this.activeWatches.get(hungToolId);
    if (!hungWatch) return null;

    // Find the matching tool entry
    const hungToolEntry = accumulatedToolUse.find(t => t.toolId === hungToolId);

    // Build completed tools list (exclude the hung one)
    const completedTools = accumulatedToolUse
      .filter(t => t.toolId !== hungToolId && t.result !== undefined)
      .map(t => ({
        toolName: t.toolName,
        toolId: t.toolId,
        input: t.toolInput,
        result: t.result || '',
        isError: t.isError || false,
        durationMs: t.duration || 0,
      }));

    // Build in-progress tools list (started but no result, excluding the hung one)
    const inProgressTools = accumulatedToolUse
      .filter(t => t.toolId !== hungToolId && t.result === undefined)
      .map(t => ({
        toolName: t.toolName,
        toolId: t.toolId,
        input: t.toolInput,
      }));

    // Extract URL from tool input if WebFetch/WebSearch
    let url: string | undefined;
    const toolInput = hungToolEntry?.toolInput || hungWatch.toolInput;
    if (toolInput.url) {
      url = String(toolInput.url);
    } else if (toolInput.query) {
      url = String(toolInput.query);
    }

    return {
      originalPrompt,
      assistantText,
      thinkingText,
      completedTools,
      inProgressTools,
      hungTool: {
        toolName: hungWatch.toolName,
        toolId: hungToolId,
        input: toolInput,
        timeoutMs: hungWatch.timeoutMs,
        url,
      },
      claudeSessionId,
      elapsedMs: Date.now() - processStartTime,
    };
  }
}
