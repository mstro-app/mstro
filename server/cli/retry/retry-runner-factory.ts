// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Factory for the HeadlessRunner used in a single retry iteration.
 * Wires session options into HeadlessRunner callbacks that respect the
 * shared cancel flag and forward streaming events via `callbacks`.
 */

import { HeadlessRunner } from '../headless/index.js';
import type { ExecutionCheckpoint } from '../headless/types.js';
import type { FileAttachment, RetryLoopState } from '../improvisation-types.js';
import { buildHistoricalContext } from '../prompt-builders.js';
import type { RetryCallbacks, RetrySessionState } from './retry-types.js';

/** Create HeadlessRunner for one retry iteration */
export function createExecutionRunner(
  state: RetryLoopState,
  session: RetrySessionState,
  callbacks: RetryCallbacks,
  sequenceNumber: number,
  useResume: boolean,
  resumeSessionId: string | undefined,
  imageAttachments: FileAttachment[] | undefined,
  workingDirOverride?: string,
): HeadlessRunner {
  return new HeadlessRunner({
    workingDir: workingDirOverride || session.options.workingDir,
    tokenBudgetThreshold: session.options.tokenBudgetThreshold,
    maxSessions: session.options.maxSessions,
    verbose: session.options.verbose,
    noColor: session.options.noColor,
    model: session.options.model,
    effortLevel: session.options.effortLevel,
    improvisationMode: true,
    movementNumber: sequenceNumber,
    continueSession: useResume,
    claudeSessionId: resumeSessionId,
    outputCallback: (text: string) => {
      if (callbacks.isCancelled()) return;
      callbacks.addEventLog({ type: 'output', data: { text, timestamp: Date.now() }, timestamp: Date.now() });
      callbacks.queueOutput(text);
      callbacks.flushOutputQueue();
    },
    thinkingCallback: (text: string) => {
      if (callbacks.isCancelled()) return;
      callbacks.addEventLog({ type: 'thinking', data: { text }, timestamp: Date.now() });
      callbacks.emit('onThinking', text);
      callbacks.flushOutputQueue();
    },
    toolUseCallback: (event) => {
      if (callbacks.isCancelled()) return;
      callbacks.addEventLog({ type: 'toolUse', data: { ...event, timestamp: Date.now() }, timestamp: Date.now() });
      callbacks.emit('onToolUse', event);
      callbacks.flushOutputQueue();
    },
    tokenUsageCallback: (usage) => {
      if (callbacks.isCancelled()) return;
      callbacks.emit('onTokenUsage', usage);
    },
    directPrompt: state.currentPrompt,
    imageAttachments,
    promptContext: (state.retryNumber === 0 && session.isResumedSession && session.isFirstPrompt)
      ? { accumulatedKnowledge: buildHistoricalContext(session.history.movements), filesModified: [] }
      : undefined,
    onToolTimeout: (checkpoint: ExecutionCheckpoint) => {
      state.checkpointRef.value = checkpoint;
    },
  });
}
