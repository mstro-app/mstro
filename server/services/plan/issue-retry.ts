// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { ResilientRunner } from '../../cli/headless/resilient-runner.js';
import type { SessionResult, ToolUseEvent } from '../../cli/headless/types.js';

export interface IssueRunnerConfig {
  workingDir: string;
  prompt: string;
  stallWarningMs: number;
  stallKillMs: number;
  stallHardCapMs: number;
  stallMaxExtensions: number;
  outputCallback?: (text: string) => void;
  thinkingCallback?: (text: string) => void;
  toolUseCallback?: (event: ToolUseEvent) => void;
  extraEnv?: Record<string, string>;
  abortSignal?: AbortSignal;
}

export async function runIssueWithRetry(config: IssueRunnerConfig): Promise<SessionResult> {
  const runner = new ResilientRunner({
    workingDir: config.workingDir,
    prompt: config.prompt,
    policy: 'FULL',
    maxRetries: 3,
    stallWarningMs: config.stallWarningMs,
    stallKillMs: config.stallKillMs,
    stallHardCapMs: config.stallHardCapMs,
    stallMaxExtensions: config.stallMaxExtensions,
    outputCallback: config.outputCallback,
    thinkingCallback: config.thinkingCallback,
    toolUseCallback: config.toolUseCallback,
    verbose: true,
    extraEnv: config.extraEnv,
    abortSignal: config.abortSignal,
    onRetry: (info) => {
      config.outputCallback?.(
        `\n[PM-RETRY] Auto-retry ${info.retryNumber}/${info.maxRetries}: ${info.path} — ${info.reason}\n`,
      );
    },
  });

  return runner.run();
}
