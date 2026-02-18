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
  tool_name?: string;
  toolName?: string;
  input?: Record<string, any>;
  toolInput?: Record<string, any>;
  // Conversation context from Claude Code hooks
  session_id?: string;
  conversation?: {
    messages?: Array<{
      role: 'user' | 'assistant';
      content: string;
    }>;
    last_user_message?: string;
  };
  // Additional context fields Claude Code may provide
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

function buildOperationString(toolName: string, toolInput: Record<string, any>): string {
  if (toolName === 'Bash' && toolInput.command) {
    return `${toolName}: ${toolInput.command}`;
  }
  if (['Write', 'Edit', 'Read'].includes(toolName)) {
    const filePath = toolInput.file_path || toolInput.filePath || toolInput.path;
    return filePath ? `${toolName}: ${filePath}` : `${toolName}: ${JSON.stringify(toolInput)}`;
  }
  return `${toolName}: ${JSON.stringify(toolInput)}`;
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

  const toolName = hookInput.tool_name || hookInput.toolName || 'unknown';
  const toolInput = hookInput.input || hookInput.toolInput || {};
  const userRequestContext = extractConversationContext(hookInput);
  const lastUserMessage = hookInput.conversation?.last_user_message;
  const recentMessages = hookInput.conversation?.messages?.slice(-5);

  const bouncerRequest: BouncerReviewRequest = {
    operation: buildOperationString(toolName, toolInput),
    context: {
      purpose: userRequestContext || 'Tool use request from Claude',
      workingDirectory: hookInput.working_directory || process.cwd(),
      toolName,
      toolInput,
      userRequest: lastUserMessage,
      conversationHistory: recentMessages?.map(m => `${m.role}: ${m.content}`),
      sessionId: hookInput.session_id,
    },
  };

  try {
    const decision = await reviewOperation(bouncerRequest);
    console.log(JSON.stringify({
      decision: decision.decision === 'deny' ? 'deny' : 'allow',
      reason: decision.reasoning,
      confidence: decision.confidence,
      threatLevel: decision.threatLevel,
      alternative: decision.alternative,
    }));
  } catch (error: any) {
    console.error('[bouncer-cli] Error:', error.message);
    console.log(JSON.stringify({
      decision: 'allow',
      reason: `Bouncer error: ${error.message}. Allowing to avoid blocking.`
    }));
  }
}

main();
