#!/usr/bin/env node
// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Bouncer CLI — stdin/stdout wrapper for Claude Code PreToolUse hooks.
 *
 * Reads a tool use request from stdin (JSON), runs it through the full
 * 2-layer bouncer (pattern matching + Haiku AI), and writes the decision
 * to stdout in the format Claude Code hooks expect.
 *
 * Input format (from Claude Code hook):
 *   { "tool_name": "Bash", "input": { "command": "rm -rf /" } }
 *
 * Output format (to Claude Code hook):
 *   { "decision": "allow"|"deny", "reason": "..." }
 */

import type { BouncerReviewRequest } from './bouncer-integration.js';
import { reviewOperation } from './bouncer-integration.js';

function buildOperation(toolName: string, toolInput: Record<string, unknown>): string {
  const prefix = `${toolName}: `;
  if (toolName === 'Bash' && toolInput.command) return prefix + String(toolInput.command);
  if (toolName === 'Edit' && toolInput.file_path) return prefix + String(toolInput.file_path);
  if (toolName === 'Write' && toolInput.file_path) return prefix + String(toolInput.file_path);
  return prefix + JSON.stringify(toolInput).slice(0, 500);
}

async function evaluate(rawInput: string): Promise<{ decision: string; reason: string }> {
  if (!rawInput.trim()) {
    return { decision: 'allow', reason: 'Empty input' };
  }

  let parsed: { tool_name?: string; toolName?: string; input?: Record<string, unknown>; toolInput?: Record<string, unknown> };
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return { decision: 'allow', reason: 'Invalid JSON input' };
  }

  const toolName = parsed.tool_name || parsed.toolName || 'unknown';
  const toolInput = parsed.input || parsed.toolInput || {};

  const request: BouncerReviewRequest = {
    operation: buildOperation(toolName, toolInput),
    context: {
      purpose: 'Tool use request from Claude Code hook',
      workingDirectory: process.cwd(),
      toolName,
      toolInput,
    },
  };

  const result = await reviewOperation(request);
  return {
    decision: result.decision === 'deny' ? 'deny' : 'allow',
    reason: result.reasoning,
  };
}

async function main(): Promise<void> {
  let rawInput = '';
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }
  const result = await evaluate(rawInput);
  console.log(JSON.stringify(result));
}

main().catch(() => {
  console.log(JSON.stringify({ decision: 'allow', reason: 'Bouncer crash' }));
});
