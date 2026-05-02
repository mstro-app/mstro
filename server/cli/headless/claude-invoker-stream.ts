// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { hlog } from './headless-logger.js';
import type { NativeTimeoutDetector } from './native-timeout-detector.js';
import { classifyError } from './stall-assessor.js';
import type { ResolvedHeadlessConfig, ToolUseAccumulator } from './types.js';

interface StreamContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | unknown;
  is_error?: boolean;
}

interface StreamTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

type StreamJson = {
  type: string;
  subtype?: string;
  session_id?: string;
  stop_reason?: string;
  is_error?: boolean;
  error?: string | { message?: string };
  result?: string;
  message?: {
    content?: StreamContentBlock[];
    usage?: StreamTokenUsage;
  };
  event?: {
    type: string;
    delta?: {
      type: string;
      thinking?: string;
      text?: string;
      partial_json?: string;
    };
    content_block?: {
      type: string;
      name?: string;
      id?: string;
    };
    index?: number;
    message?: { usage?: StreamTokenUsage };
    usage?: { output_tokens?: number };
  };
  usage?: StreamTokenUsage;
  delta?: {
    type: string;
    thinking?: string;
    text?: string;
    partial_json?: string;
  };
  content_block?: {
    type: string;
    name?: string;
    id?: string;
  };
  index?: number;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
};

export interface StreamHandlerContext {
  config: ResolvedHeadlessConfig;
  accumulatedAssistantResponse: string;
  accumulatedThinking: string;
  accumulatedToolUse: ToolUseAccumulator[];
  toolInputBuffers: Map<number, { name: string; id: string; inputJson: string; startTime: number }>;
  nativeTimeoutDetector: NativeTimeoutDetector;
  /** When true, assistant text is buffered instead of forwarded to outputCallback.
   *  Active during resume mode until thinking/tool activity confirms Claude has context. */
  resumeAssessmentActive: boolean;
  /** Buffered assistant text during resume assessment */
  resumeAssessmentBuffer: string;
  /** Cumulative API token usage from message_start/message_delta events */
  apiTokenUsage: { inputTokens: number; outputTokens: number };
  /** Tracks cumulative output_tokens within the current step (message_delta is cumulative per-step) */
  currentStepOutputTokens: number;
  /** Timestamp of the last token usage change (tokens still flowing = process alive) */
  lastTokenActivityTime: number;
  /** Claude Code result event stop_reason (e.g., 'end_turn', 'max_tokens') */
  stopReason?: string;
  /** True once any stream_event text_delta has been received — used to skip
   *  duplicate text from assistant messages emitted alongside streaming deltas. */
  hasReceivedTextDeltas: boolean;
  /** Same guard for thinking deltas */
  hasReceivedThinkingDeltas: boolean;
}

/** Log messages when verbose mode is enabled */
export function verboseLog(verbose: boolean | undefined, ...msgs: string[]): void {
  if (verbose) {
    for (const msg of msgs) hlog(msg);
  }
}

// ========== Stream Event Handlers ==========

function handleSessionCapture(
  parsed: StreamJson,
  captured: { claudeSessionId?: string }
): void {
  if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
    captured.claudeSessionId = parsed.session_id;
  }
  if (parsed.type === 'result' && parsed.session_id && !captured.claudeSessionId) {
    captured.claudeSessionId = parsed.session_id;
  }
}

function handleThinkingDelta(event: StreamJson, ctx: StreamHandlerContext): string {
  if (
    event.type !== 'content_block_delta' ||
    event.delta?.type !== 'thinking_delta' ||
    !event.delta?.thinking
  ) {
    return ctx.accumulatedThinking;
  }

  ctx.hasReceivedThinkingDeltas = true;

  if (ctx.resumeAssessmentActive) {
    ctx.resumeAssessmentActive = false;
    if (ctx.resumeAssessmentBuffer) {
      ctx.config.outputCallback?.(ctx.resumeAssessmentBuffer);
      ctx.resumeAssessmentBuffer = '';
    }
  }

  const thinking = event.delta.thinking;
  const updated = ctx.accumulatedThinking + thinking;

  if (ctx.config.thinkingCallback) {
    ctx.config.thinkingCallback(thinking);
  } else if (ctx.config.outputCallback) {
    ctx.config.outputCallback(thinking);
  } else {
    process.stdout.write(thinking);
  }

  return updated;
}

function handleTextDelta(event: StreamJson, ctx: StreamHandlerContext): string {
  if (
    event.type !== 'content_block_delta' ||
    event.delta?.type !== 'text_delta' ||
    !event.delta?.text
  ) {
    return ctx.accumulatedAssistantResponse;
  }

  ctx.hasReceivedTextDeltas = true;
  const text = event.delta.text;
  const updated = ctx.accumulatedAssistantResponse + text;

  const { passthrough, timeouts } = ctx.nativeTimeoutDetector.processChunk(text);

  for (const timeout of timeouts) {
    ctx.config.outputCallback?.(
      `\n[[MSTRO_NATIVE_TIMEOUT]] ${timeout.toolName} timed out \u2014 ${timeout.action} with ${timeout.preservedCount} results preserved\n`
    );
  }

  if (ctx.resumeAssessmentActive) {
    if (passthrough) {
      ctx.resumeAssessmentBuffer += passthrough;
    }
    return updated;
  }

  if (passthrough && ctx.config.outputCallback) {
    ctx.config.outputCallback(passthrough);
  }

  return updated;
}

/** Accumulate input tokens from a message_start event */
function handleMessageStartTokens(event: StreamJson, ctx: StreamHandlerContext): boolean {
  if (event.type !== 'message_start' || !event.message?.usage) return false;
  const usage = event.message.usage;
  ctx.currentStepOutputTokens = 0;
  let changed = false;
  if (typeof usage.input_tokens === 'number') {
    ctx.apiTokenUsage.inputTokens += usage.input_tokens;
    changed = true;
  }
  if (typeof usage.cache_creation_input_tokens === 'number') {
    ctx.apiTokenUsage.inputTokens += usage.cache_creation_input_tokens;
    changed = true;
  }
  if (typeof usage.cache_read_input_tokens === 'number') {
    ctx.apiTokenUsage.inputTokens += usage.cache_read_input_tokens;
    changed = true;
  }
  verboseLog(ctx.config.verbose,
    `[TOKENS] message_start: input=${usage.input_tokens ?? 0} cache_create=${usage.cache_creation_input_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0} → total_input=${ctx.apiTokenUsage.inputTokens}`);
  return changed;
}

/** Accumulate output tokens from a message_delta event (cumulative tracking) */
function handleMessageDeltaTokens(event: StreamJson, ctx: StreamHandlerContext): boolean {
  if (event.type !== 'message_delta' || !event.usage) return false;
  if (typeof event.usage.output_tokens !== 'number') return false;
  const increment = event.usage.output_tokens - ctx.currentStepOutputTokens;
  verboseLog(ctx.config.verbose,
    `[TOKENS] message_delta: output=${event.usage.output_tokens} (step_prev=${ctx.currentStepOutputTokens} increment=${increment}) → total_output=${ctx.apiTokenUsage.outputTokens + Math.max(increment, 0)}`);
  if (increment <= 0) return false;
  ctx.apiTokenUsage.outputTokens += increment;
  ctx.currentStepOutputTokens = event.usage.output_tokens;
  return true;
}

function handleTokenUsage(event: StreamJson, ctx: StreamHandlerContext): void {
  const changed = handleMessageStartTokens(event, ctx) || handleMessageDeltaTokens(event, ctx);
  if (changed) {
    ctx.lastTokenActivityTime = Date.now();
    ctx.config.tokenUsageCallback?.({ ...ctx.apiTokenUsage });
  }
}

/** Extract definitive token usage from the result event */
function handleResultTokenUsage(parsed: StreamJson, ctx: StreamHandlerContext): void {
  if (!parsed.usage) return;
  const u = parsed.usage;
  const input = (typeof u.input_tokens === 'number' ? u.input_tokens : 0)
    + (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0)
    + (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0);
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;

  if (input > 0 || output > 0) {
    verboseLog(ctx.config.verbose,
      `[TOKENS] Result event usage: input=${input} output=${output} ` +
      `(stream accumulated: input=${ctx.apiTokenUsage.inputTokens} output=${ctx.apiTokenUsage.outputTokens})`);
    ctx.apiTokenUsage = { inputTokens: input, outputTokens: output };
    ctx.lastTokenActivityTime = Date.now();
    ctx.config.tokenUsageCallback?.({ ...ctx.apiTokenUsage });
  }
}

function handleToolResult(parsed: StreamJson, ctx: StreamHandlerContext): void {
  if (parsed.type !== 'user' || !parsed.message?.content) {
    return;
  }

  for (const content of parsed.message.content) {
    if (content.type !== 'tool_result') {
      continue;
    }

    const toolId = content.tool_use_id;
    const result = content.content;
    const isError = content.is_error || false;
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

    const toolEntry = ctx.accumulatedToolUse.find(t => t.toolId === toolId);
    if (toolEntry) {
      toolEntry.result = resultStr;
      toolEntry.isError = isError;
      toolEntry.duration = Date.now() - toolEntry.startTime;
    }

    if (ctx.config.toolUseCallback) {
      ctx.config.toolUseCallback({ type: 'tool_result', toolId, result: resultStr, isError });
    }
  }
}

// ========== Stream Processing ==========

function handleAssistantTextBlock(block: StreamJson, ctx: StreamHandlerContext): void {
  if (ctx.hasReceivedTextDeltas) return;
  ctx.accumulatedAssistantResponse += block.text!;
  ctx.config.outputCallback?.(block.text!);
}

function handleAssistantThinkingBlock(block: StreamJson, ctx: StreamHandlerContext): void {
  if (ctx.hasReceivedThinkingDeltas) return;
  ctx.accumulatedThinking += block.thinking!;
  if (ctx.config.thinkingCallback) {
    ctx.config.thinkingCallback(block.thinking!);
  } else {
    ctx.config.outputCallback?.(block.thinking!);
  }
}

function handleAssistantToolUseBlock(block: StreamJson, ctx: StreamHandlerContext): void {
  const toolInput = block.input || {};
  ctx.accumulatedToolUse.push({
    toolName: block.name!, toolId: block.id!,
    toolInput, startTime: Date.now(),
  });
  ctx.config.toolUseCallback?.({
    type: 'tool_start', toolName: block.name!, toolId: block.id!, index: 0,
  });
  ctx.config.toolUseCallback?.({
    type: 'tool_complete', toolName: block.name!, toolId: block.id!,
    index: 0, completeInput: toolInput,
  });
}

function handleAssistantContentBlock(block: StreamJson, ctx: StreamHandlerContext): void {
  if (block.type === 'text' && block.text) handleAssistantTextBlock(block, ctx);
  else if (block.type === 'thinking' && block.thinking) handleAssistantThinkingBlock(block, ctx);
  else if (block.type === 'tool_use' && block.name && block.id) handleAssistantToolUseBlock(block, ctx);
}

/**
 * Handle a complete `assistant` message event.
 * Claude Code emits these instead of (or alongside) stream_event deltas when
 * running skill commands or when --include-partial-messages is unsupported.
 */
function handleAssistantMessage(parsed: StreamJson, ctx: StreamHandlerContext): void {
  if (parsed.type !== 'assistant' || !parsed.message?.content) return;
  const content = parsed.message.content;
  if (!Array.isArray(content)) return;

  for (const block of content) handleAssistantContentBlock(block, ctx);

  if (ctx.resumeAssessmentActive) {
    ctx.resumeAssessmentActive = false;
    if (ctx.resumeAssessmentBuffer) {
      ctx.config.outputCallback?.(ctx.resumeAssessmentBuffer);
      ctx.resumeAssessmentBuffer = '';
    }
  }
}

function extractErrorMessage(parsed: StreamJson): string {
  const errObj = typeof parsed.error === 'object' ? parsed.error?.message : parsed.error;
  return errObj || String(parsed.message ?? '') || JSON.stringify(parsed);
}

function handleResultEvent(parsed: StreamJson, ctx: StreamHandlerContext): boolean {
  handleResultTokenUsage(parsed, ctx);
  if (parsed.stop_reason) {
    ctx.stopReason = parsed.stop_reason;
  }
  if (parsed.is_error) {
    const errorMessage = parsed.error || parsed.result || 'Unknown error in result';
    ctx.config.outputCallback?.(`\n[[MSTRO_ERROR:CLAUDE_RESULT_ERROR]] ${errorMessage}\n`);
    return true;
  }
  if (!ctx.accumulatedAssistantResponse && parsed.result && typeof parsed.result === 'string') {
    ctx.accumulatedAssistantResponse = parsed.result;
    ctx.config.outputCallback?.(parsed.result);
  }
  return false;
}

export function processStreamEvent(parsed: StreamJson, ctx: StreamHandlerContext): void {
  if (parsed.type === 'error') {
    ctx.config.outputCallback?.(`\n[[MSTRO_ERROR:CLAUDE_ERROR]] ${extractErrorMessage(parsed)}\n`);
    return;
  }

  if (parsed.type === 'result') {
    if (handleResultEvent(parsed, ctx)) return;
  }

  if (parsed.type === 'stream_event' && parsed.event) {
    const event = parsed.event;
    ctx.accumulatedThinking = handleThinkingDelta(event, ctx);
    ctx.accumulatedAssistantResponse = handleTextDelta(event, ctx);
    handleToolStreamEvents(event, ctx);
    handleTokenUsage(event, ctx);
  }
  handleAssistantMessage(parsed, ctx);
  handleToolResult(parsed, ctx);
}

/** Handle tool_use content_block_start */
function handleToolStart(event: StreamJson, ctx: StreamHandlerContext): void {
  if (event.type !== 'content_block_start' || event.content_block?.type !== 'tool_use') return;

  if (ctx.resumeAssessmentActive) {
    ctx.resumeAssessmentActive = false;
    if (ctx.resumeAssessmentBuffer) {
      ctx.config.outputCallback?.(ctx.resumeAssessmentBuffer);
      ctx.resumeAssessmentBuffer = '';
    }
  }

  const toolName = event.content_block.name!;
  const toolId = event.content_block.id!;
  const index = event.index!;

  ctx.toolInputBuffers.set(index, { name: toolName, id: toolId, inputJson: '', startTime: Date.now() });
  ctx.config.toolUseCallback?.({ type: 'tool_start', toolName, toolId, index });
}

/** Handle input_json_delta for tool input streaming */
function handleToolInputDelta(event: StreamJson, ctx: StreamHandlerContext): void {
  if (event.type !== 'content_block_delta' || event.delta?.type !== 'input_json_delta') return;

  const index = event.index!;
  const partialJson = event.delta.partial_json;
  const toolBuffer = ctx.toolInputBuffers.get(index);
  if (toolBuffer) toolBuffer.inputJson += partialJson;
  ctx.lastTokenActivityTime = Date.now();
  ctx.config.toolUseCallback?.({ type: 'tool_input_delta', partialJson, index });
}

/** Handle content_block_stop — finalize tool input and emit tool_complete */
function handleToolComplete(event: StreamJson, ctx: StreamHandlerContext): void {
  if (event.type !== 'content_block_stop') return;

  const index = event.index!;
  const toolBuffer = ctx.toolInputBuffers.get(index);
  if (!toolBuffer) return;

  let completeInput: Record<string, unknown> = {};
  try { completeInput = JSON.parse(toolBuffer.inputJson); } catch { /* incomplete JSON */ }

  ctx.accumulatedToolUse.push({
    toolName: toolBuffer.name, toolId: toolBuffer.id,
    toolInput: completeInput, startTime: toolBuffer.startTime
  });
  ctx.toolInputBuffers.delete(index);

  ctx.config.toolUseCallback?.({
    type: 'tool_complete', toolName: toolBuffer.name, toolId: toolBuffer.id,
    index, completeInput
  });
}

/** Handle tool-specific stream events (start, input delta, complete) */
function handleToolStreamEvents(event: StreamJson, ctx: StreamHandlerContext): void {
  handleToolStart(event, ctx);
  handleToolInputDelta(event, ctx);
  handleToolComplete(event, ctx);
}

export function processStreamLines(
  buffer: string,
  sessionCapture: { claudeSessionId?: string },
  ctx: StreamHandlerContext
): string {
  const lines = buffer.split('\n');
  const remainder = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      handleSessionCapture(parsed, sessionCapture);
      processStreamEvent(parsed, ctx);
    } catch { /* Ignore parse errors */ }
  }

  return remainder;
}

/** Flush native timeout detector buffers and return post-timeout output if any */
export function flushNativeTimeoutBuffers(ctx: StreamHandlerContext): string | undefined {
  const remaining = ctx.nativeTimeoutDetector.flush();
  const buffered = ctx.nativeTimeoutDetector.bufferedPostTimeoutOutput;
  const postTimeout = (buffered + remaining) || undefined;

  if (!postTimeout && remaining) {
    ctx.config.outputCallback?.(remaining);
  }

  return postTimeout;
}

/** Classify unmatched stderr via Haiku when process exits with error */
export async function classifyUnmatchedStderr(
  stderr: string,
  errorAlreadySurfaced: boolean,
  code: number | null,
  config: ResolvedHeadlessConfig,
): Promise<void> {
  if (!stderr || errorAlreadySurfaced || code === 0) return;

  try {
    const classified = await classifyError(stderr, config.claudeCommand, config.verbose);
    if (classified) {
      config.outputCallback?.(`\n[[MSTRO_ERROR:${classified.errorCode}]] ${classified.message}\n`);
    }
  } catch {
    // Haiku classification failed — proceed without it
  }
}
