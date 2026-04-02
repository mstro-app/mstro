/**
 * Prompt building and formatting utilities for improvisation sessions.
 * Extracted from ImprovisationSessionManager for Single Responsibility.
 *
 * These are stateless formatting functions that take their inputs as parameters.
 */

import type { ExecutionCheckpoint } from './headless/types.js';
import type { MovementRecord, ToolUseRecord } from './improvisation-session-manager.js';

// ============================================================================
// Formatting Utilities
// ============================================================================

/** Summarize a tool input for display in retry prompts */
export function summarizeToolInput(input: Record<string, unknown>): string {
  if (input.url) return String(input.url).slice(0, 100);
  if (input.query) return String(input.query).slice(0, 100);
  if (input.command) return String(input.command).slice(0, 100);
  if (input.prompt) return String(input.prompt).slice(0, 100);
  return JSON.stringify(input).slice(0, 100);
}

/** Format a list of timed-out tools for retry prompts */
export function formatTimedOutTools(tools: Array<{ toolName: string; input: Record<string, unknown>; timeoutMs: number }>): string[] {
  const lines: string[] = [];
  lines.push('### Tools/resources that have timed out (DO NOT retry these):');
  for (const t of tools) {
    const inputSummary = summarizeToolInput(t.input);
    lines.push(`- **${t.toolName}**(${inputSummary}) — timed out after ${Math.round(t.timeoutMs / 1000)}s`);
  }
  return lines;
}

/** Format completed checkpoint tools for retry prompts */
export function formatCompletedTools(tools: Array<{ toolName: string; input: Record<string, unknown>; result: string }>, maxLen = 2000): string[] {
  const lines: string[] = [];
  lines.push('### Results already obtained:');
  for (const tool of tools) {
    const inputSummary = summarizeToolInput(tool.input);
    const preview = tool.result.length > maxLen ? `${tool.result.slice(0, maxLen)}...` : tool.result;
    lines.push(`- **${tool.toolName}**(${inputSummary}): ${preview}`);
  }
  return lines;
}

/** Format in-progress tools for retry prompts */
export function formatInProgressTools(tools: Array<{ toolName: string; input: Record<string, unknown> }>): string[] {
  const lines: string[] = [];
  lines.push('### Tools that were still running (lost when process was killed):');
  for (const tool of tools) {
    const inputSummary = summarizeToolInput(tool.input);
    lines.push(`- **${tool.toolName}**(${inputSummary}) — was in progress, may need re-running`);
  }
  return lines;
}

/** Format tool results from ToolUseRecord[] for recovery prompts */
export function formatToolResults(toolResults: ToolUseRecord[], maxLen = 3000): string[] {
  const completed = toolResults.filter(t => t.result !== undefined && !t.isError);
  if (completed.length === 0) return [];
  const lines: string[] = [`### ${completed.length} preserved results from prior work:`, ''];
  for (const tool of completed) {
    const inputSummary = summarizeToolInput(tool.toolInput);
    const preview = tool.result && tool.result.length > maxLen
      ? `${tool.result.slice(0, maxLen)}...\n(truncated, ${tool.result.length} chars total)`
      : tool.result || '';
    lines.push(`**${tool.toolName}**(${inputSummary}):`);
    lines.push(preview);
    lines.push('');
  }
  return lines;
}

/** Format conversation history for recovery prompts */
export function formatConversationHistory(movements: MovementRecord[], maxMovements = 5): string[] {
  const recent = movements.slice(-maxMovements);
  if (recent.length === 0) return [];
  const lines: string[] = ['### Conversation so far:'];
  for (const movement of recent) {
    const promptText = movement.userPrompt.length > 300 ? `${movement.userPrompt.slice(0, 300)}...` : movement.userPrompt;
    lines.push(`**User (prompt ${movement.sequenceNumber}):** ${promptText}`);
    if (movement.assistantResponse) {
      const response = movement.assistantResponse.length > 1000
        ? `${movement.assistantResponse.slice(0, 1000)}...\n(truncated, ${movement.assistantResponse.length} chars)`
        : movement.assistantResponse;
      lines.push(`**Your response:** ${response}`);
    }
    lines.push('');
  }
  return lines;
}

// ============================================================================
// Prompt Builders
// ============================================================================

/** Build historical context from prior movements (for resumed sessions or first prompt with history) */
export function buildHistoricalContext(movements: MovementRecord[]): string {
  if (movements.length === 0) {
    return '';
  }

  const contextParts: string[] = [
    '--- CONVERSATION HISTORY (for context, do not repeat these responses) ---',
    ''
  ];

  for (const movement of movements) {
    contextParts.push(`[User Prompt ${movement.sequenceNumber}]:`);
    contextParts.push(movement.userPrompt);
    contextParts.push('');

    if (movement.assistantResponse) {
      contextParts.push(`[Your Response ${movement.sequenceNumber}]:`);
      const response = movement.assistantResponse.length > 2000
        ? `${movement.assistantResponse.slice(0, 2000)}\n... (response truncated for context)`
        : movement.assistantResponse;
      contextParts.push(response);
      contextParts.push('');
    }

    if (movement.toolUseHistory && movement.toolUseHistory.length > 0) {
      contextParts.push(`[Tools Used in Prompt ${movement.sequenceNumber}]:`);
      for (const tool of movement.toolUseHistory) {
        contextParts.push(`- ${tool.toolName}`);
      }
      contextParts.push('');
    }
  }

  contextParts.push('--- END OF CONVERSATION HISTORY ---');
  contextParts.push('');
  contextParts.push('Continue the conversation from where we left off. The user is now asking:');
  contextParts.push('');

  return contextParts.join('\n');
}

/**
 * Build a retry prompt from a tool timeout checkpoint.
 * Injects completed tool results and instructs Claude to skip the failed resource.
 */
export function buildRetryPrompt(
  checkpoint: ExecutionCheckpoint,
  originalPrompt: string,
  allTimedOut?: Array<{ toolName: string; input: Record<string, unknown>; timeoutMs: number }>,
): string {
  const urlSuffix = checkpoint.hungTool.url ? ` while fetching: ${checkpoint.hungTool.url}` : '';
  const parts: string[] = [
    '## AUTOMATIC RETRY -- Previous Execution Interrupted',
    '',
    `The previous execution was interrupted because ${checkpoint.hungTool.toolName} timed out after ${Math.round(checkpoint.hungTool.timeoutMs / 1000)}s${urlSuffix}.`,
    '',
  ];

  if (allTimedOut && allTimedOut.length > 0) {
    parts.push(...formatTimedOutTools(allTimedOut), '');
  } else {
    parts.push('This URL/resource is unreachable. DO NOT retry the same URL or query.', '');
  }

  if (checkpoint.completedTools.length > 0) {
    parts.push(...formatCompletedTools(checkpoint.completedTools), '');
  }

  if (checkpoint.inProgressTools && checkpoint.inProgressTools.length > 0) {
    parts.push(...formatInProgressTools(checkpoint.inProgressTools), '');
  }

  if (checkpoint.assistantText) {
    const preview = checkpoint.assistantText.length > 8000
      ? `${checkpoint.assistantText.slice(0, 8000)}...\n(truncated — full response was ${checkpoint.assistantText.length} chars)`
      : checkpoint.assistantText;
    parts.push('### Your response before interruption:', preview, '');
  }

  parts.push('### Original task (continue from where you left off):');
  parts.push(originalPrompt);
  parts.push('');
  parts.push('INSTRUCTIONS:');
  parts.push('1. Use the results above -- do not re-fetch content you already have');
  parts.push('2. Find ALTERNATIVE sources for the content that timed out (different URL, different approach)');
  parts.push('3. Re-run any in-progress tools that were lost (listed above) if their results are needed');
  parts.push('4. If no alternative exists, proceed with the results you have and note what was unavailable');

  return parts.join('\n');
}

/**
 * Build a short retry prompt for --resume sessions.
 */
export function buildResumeRetryPrompt(
  checkpoint: ExecutionCheckpoint,
  allTimedOut?: Array<{ toolName: string; input: Record<string, unknown>; timeoutMs: number }>,
): string {
  const parts: string[] = [];

  parts.push(
    `Your previous ${checkpoint.hungTool.toolName} call timed out after ${Math.round(checkpoint.hungTool.timeoutMs / 1000)}s${checkpoint.hungTool.url ? ` fetching: ${checkpoint.hungTool.url}` : ''}.`
  );

  if (allTimedOut && allTimedOut.length > 1) {
    parts.push('');
    parts.push('All timed-out tools/resources (DO NOT retry any of these):');
    for (const t of allTimedOut) {
      const inputSummary = summarizeToolInput(t.input);
      parts.push(`- ${t.toolName}(${inputSummary})`);
    }
  } else {
    parts.push('This URL/resource is unreachable. DO NOT retry the same URL or query.');
  }
  parts.push('Continue your task — find an alternative source or proceed with the results you already have.');

  return parts.join('\n');
}

/** Build a recovery prompt for --resume after context loss. */
export function buildContextRecoveryPrompt(originalPrompt: string): string {
  const parts: string[] = [];

  parts.push('Your previous response indicated you lost context due to tool timeouts, but your full conversation history is preserved — including all successful tool results.');
  parts.push('');
  parts.push('Review your conversation history above. You already have results from many successful tool calls. Use those results to continue the task.');
  parts.push('');
  parts.push('Original task:');
  parts.push(originalPrompt);
  parts.push('');
  parts.push('INSTRUCTIONS:');
  parts.push('1. Review your conversation history — all your previous tool results are still available');
  parts.push('2. Continue from where you left off using the results you already gathered');
  parts.push('3. If specific tool calls timed out, skip those and work with what you have');
  parts.push('4. Do NOT start over — build on the work already done');
  parts.push('5. Do NOT spawn Task subagents for work that previously timed out — do it inline instead');
  parts.push('6. Prefer multiple small, focused tool calls over single large ones to avoid further timeouts');

  return parts.join('\n');
}

/** Build a recovery prompt for a fresh session after repeated context loss. */
export function buildFreshRecoveryPrompt(
  originalPrompt: string,
  toolResults: ToolUseRecord[],
  timedOutTools?: Array<{ toolName: string; input: Record<string, unknown>; timeoutMs: number }>,
): string {
  const parts: string[] = [
    '## CONTINUING LONG-RUNNING TASK',
    '',
    'The previous execution encountered tool timeouts and lost context.',
    'Below are all results gathered before the interruption. Continue the task using these results.',
    '',
  ];

  if (timedOutTools && timedOutTools.length > 0) {
    parts.push(...formatTimedOutTools(timedOutTools), '');
  }

  parts.push(...formatToolResults(toolResults));

  parts.push('### Original task:');
  parts.push(originalPrompt);
  parts.push('');
  parts.push('INSTRUCTIONS:');
  parts.push('1. Use the preserved results above — do NOT re-fetch data you already have');
  parts.push('2. Continue the task from where it was interrupted');
  parts.push('3. If you need additional data, fetch it (but try alternative sources if the original timed out)');
  parts.push('4. Complete the original task fully');
  parts.push('5. Do NOT spawn Task subagents for work that previously timed out — do it inline instead');
  parts.push('6. Prefer multiple small, focused tool calls over single large ones to avoid further timeouts');

  return parts.join('\n');
}

/** Build a recovery prompt for inter-movement context loss. */
export function buildInterMovementRecoveryPrompt(
  originalPrompt: string,
  toolResults: ToolUseRecord[],
  movements: MovementRecord[],
): string {
  const parts: string[] = [
    '## SESSION RECOVERY — Prior Session Expired',
    '',
    'Your previous session expired between prompts. Below is a summary of the conversation so far and all preserved tool results.',
    '',
  ];

  parts.push(...formatConversationHistory(movements));
  parts.push(...formatToolResults(toolResults));

  parts.push('### Current user prompt:');
  parts.push(originalPrompt);
  parts.push('');
  parts.push('INSTRUCTIONS:');
  parts.push('1. Use the preserved results above — do NOT re-fetch data you already have');
  parts.push('2. Continue the conversation naturally based on the history above');
  parts.push('3. If you need additional data, fetch it with small focused tool calls');
  parts.push('4. Do NOT spawn Task subagents — do work inline to avoid further timeouts');
  parts.push('5. Prefer multiple small, focused tool calls over single large ones');

  return parts.join('\n');
}

/** Build a recovery prompt after signal crash */
export function buildSignalCrashRecoveryPrompt(
  originalPrompt: string,
  isResume: boolean,
  toolResults?: ToolUseRecord[],
): string {
  const parts: string[] = [];

  if (isResume) {
    parts.push('Your previous execution was interrupted by a system signal (the process was killed externally).');
    parts.push('Your full conversation history is preserved — including all successful tool results.');
    parts.push('');
    parts.push('Review your conversation history above and continue from where you left off.');
  } else {
    parts.push('## AUTOMATIC RETRY — Previous Execution Interrupted');
    parts.push('');
    parts.push('The previous execution was interrupted by a system signal (process killed).');
    if (toolResults && toolResults.length > 0) {
      parts.push(`${toolResults.length} tool results were preserved from prior work.`);
      parts.push('');
      parts.push('### Preserved results:');
      for (const t of toolResults.slice(-20)) {
        const inputSummary = JSON.stringify(t.toolInput).slice(0, 120);
        const resultPreview = (t.result ?? '').slice(0, 200);
        parts.push(`- **${t.toolName}**(${inputSummary}): ${resultPreview}`);
      }
    }
  }

  parts.push('');
  parts.push('### Original task:');
  parts.push(originalPrompt);
  parts.push('');
  parts.push('INSTRUCTIONS:');
  parts.push('1. Use the results above -- do not re-fetch content you already have');
  parts.push('2. Continue from where you left off');
  parts.push('3. Prefer multiple small, focused tool calls over single large ones');
  parts.push('4. Do NOT spawn Task subagents — do work inline to avoid further interruptions');

  return parts.join('\n');
}

/**
 * Extract tool results from movements.
 * Used for recovery to provide context from prior work.
 */
export function extractHistoricalToolResults(movements: MovementRecord[], maxMovements = 3): ToolUseRecord[] {
  const results: ToolUseRecord[] = [];
  const recentMovements = movements.slice(-maxMovements);

  for (const movement of recentMovements) {
    if (!movement.toolUseHistory) continue;
    for (const tool of movement.toolUseHistory) {
      if (tool.result !== undefined && !tool.isError) {
        results.push({
          toolName: tool.toolName,
          toolId: tool.toolId,
          toolInput: tool.toolInput,
          result: tool.result,
          isError: tool.isError,
          duration: tool.duration,
        });
      }
    }
  }

  return results;
}
