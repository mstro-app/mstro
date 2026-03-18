#!/usr/bin/env node
// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Bouncer CLI - Shell-callable wrapper for Mstro security bouncer
 *
 * This CLI reads Claude Code hook input from stdin and returns a security decision.
 * It's designed to be called from bouncer.sh.
 *
 * Input (stdin): Claude Code PreToolUse hook JSON payload
 * Output (stdout): JSON decision { decision: "allow"|"deny", reason: string }
 *
 * The hook payload includes conversation context that we pass to the bouncer
 * so it can make context-aware decisions.
 */

import { type BouncerReviewRequest, reviewOperation } from './bouncer-integration.js';

interface HookInput {
  // Tool identification (mstro: toolName, Claude Code: tool_name)
  tool_name?: string;
  toolName?: string;
  // Tool parameters (mstro: input/toolInput, Claude Code: tool_input)
  input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  tool_input?: Record<string, unknown>;
  // Claude Code hook metadata
  hook_event_name?: string;
  transcript_path?: string;
  permission_mode?: string;
  cwd?: string;
  // Mstro conversation context
  session_id?: string;
  conversation?: {
    messages?: Array<{
      role: 'user' | 'assistant';
      content: string;
    }>;
    last_user_message?: string;
  };
  // Common fields
  tool_use_id?: string;
  working_directory?: string;
}

/**
 * Read all data from stdin (Node.js compatible)
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').trim()));
    process.stdin.on('error', reject);
  });
}

function buildOperationString(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'Bash' && toolInput.command) {
    return `${toolName}: ${toolInput.command}`;
  }
  if (['Write', 'Edit', 'Read'].includes(toolName)) {
    const filePath = toolInput.file_path || toolInput.filePath || toolInput.path;
    return filePath ? `${toolName}: ${filePath}` : `${toolName}: ${JSON.stringify(toolInput)}`;
  }
  return `${toolName}: ${JSON.stringify(toolInput)}`;
}

/**
 * Detect whether the caller is Claude Code (vs mstro).
 * Claude Code includes hook_event_name in its payload.
 */
function isClaudeCodeHook(hookInput: HookInput): boolean {
  return hookInput.hook_event_name === 'PreToolUse';
}

/**
 * Format a bouncer decision for the calling system.
 * Claude Code expects: { hookSpecificOutput: { permissionDecision, ... } }
 * Mstro expects: { decision, reason, confidence, threatLevel, alternative }
 */
function formatDecisionOutput(
  decision: { decision: string; reasoning: string; confidence?: number; threatLevel?: string; alternative?: string },
  claudeCode: boolean
): string {
  const mappedDecision = decision.decision === 'deny' ? 'deny' : 'allow';
  if (claudeCode) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: mappedDecision,
        permissionDecisionReason: decision.reasoning,
      },
    });
  }
  return JSON.stringify({
    decision: mappedDecision,
    reason: decision.reasoning,
    confidence: decision.confidence,
    threatLevel: decision.threatLevel,
    alternative: decision.alternative,
  });
}

function formatSimpleOutput(d: 'allow' | 'deny', reason: string, claudeCode: boolean): string {
  if (claudeCode) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: d,
        permissionDecisionReason: reason,
      },
    });
  }
  return JSON.stringify({ decision: d, reason });
}

function extractConversationContext(hookInput: HookInput): string | undefined {
  const lastUserMessage = hookInput.conversation?.last_user_message;
  if (lastUserMessage) return `User's request: "${lastUserMessage}"`;

  const recentMessages = hookInput.conversation?.messages?.slice(-5);
  if (recentMessages?.length) {
    return `Recent conversation:\n${recentMessages.map(m => `${m.role}: ${m.content}`).join('\n')}`;
  }
  return undefined;
}

async function main() {
  const inputStr = await readStdin();

  if (!inputStr) {
    // Can't detect caller without input — output both-compatible allow
    console.log(JSON.stringify({ decision: 'allow', reason: 'Empty input, allowing' }));
    process.exit(0);
  }

  let hookInput: HookInput;
  try {
    hookInput = JSON.parse(inputStr);
  } catch (e) {
    console.error('[bouncer-cli] Failed to parse input JSON:', e);
    console.log(JSON.stringify({ decision: 'allow', reason: 'Invalid JSON input, allowing' }));
    process.exit(0);
  }

  const claudeCode = isClaudeCodeHook(hookInput);
  const toolName = hookInput.tool_name || hookInput.toolName || 'unknown';
  // Claude Code: tool_input, mstro: input/toolInput
  const toolInput = hookInput.tool_input || hookInput.input || hookInput.toolInput || {};
  const userRequestContext = extractConversationContext(hookInput);
  const lastUserMessage = hookInput.conversation?.last_user_message;
  const recentMessages = hookInput.conversation?.messages?.slice(-5);

  const bouncerRequest: BouncerReviewRequest = {
    operation: buildOperationString(toolName, toolInput),
    context: {
      purpose: userRequestContext || 'Tool use request from Claude',
      // Claude Code: cwd, mstro: working_directory
      workingDirectory: hookInput.cwd || hookInput.working_directory || process.cwd(),
      toolName,
      toolInput,
      userRequest: lastUserMessage,
      conversationHistory: recentMessages?.map(m => `${m.role}: ${m.content}`),
      sessionId: hookInput.session_id,
    },
  };

  try {
    const decision = await reviewOperation(bouncerRequest);
    console.log(formatDecisionOutput(decision, claudeCode));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[bouncer-cli] Error:', message);
    console.log(formatSimpleOutput('allow', `Bouncer error: ${message}. Allowing to avoid blocking.`, claudeCode));
  }
}

main();
