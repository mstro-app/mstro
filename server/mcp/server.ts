#!/usr/bin/env -S npx tsx
// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * MCP Bouncer Server
 *
 * Provides permission approval/denial for Claude Code tool use via MCP protocol.
 * Integrates with Mstro's existing bouncer-integration.ts for security analysis.
 *
 * Usage:
 *   claude --print --permission-prompt-tool mcp__mstro-bouncer__approval_prompt \
 *     --mcp-config mstro-bouncer-mcp.json \
 *     "your prompt here"
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { type BouncerReviewRequest, reviewOperation } from './bouncer-integration.js';

// Create MCP server
const server = new Server(
  {
    name: 'mstro-bouncer',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * List available tools (required by MCP protocol)
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'approval_prompt',
        description: 'Analyze and approve/deny tool use requests from Claude Code. Integrates with Mstro security bouncer for AI-powered risk analysis.',
        inputSchema: {
          type: 'object',
          properties: {
            tool_name: {
              type: 'string',
              description: 'Name of the tool being requested (e.g., "Bash", "Write", "Read")',
            },
            input: {
              type: 'object',
              description: 'Tool input parameters as JSON object',
            },
          },
          required: ['tool_name', 'input'],
        },
      },
    ],
  };
});

/**
 * Bridge AskUserQuestion to the running CLI server. Claude pauses on this
 * tool until we return; the CLI server pushes the questions to the web UI
 * via WebSocket, awaits the user's answers, and returns them here.
 *
 * On any failure (server unreachable, timeout, no tab routing context) we
 * return `behavior: allow` with the input unchanged. Claude treats it as
 * "no answers" and proceeds with its own guesses — same fallback as before
 * we had this integration. Better than blocking the run.
 */
async function bridgeAskUserQuestion(
  input: Record<string, unknown>,
): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }> {
  const port = process.env.MSTRO_PORT;
  const tabId = process.env.MSTRO_TAB_ID;
  const secret = process.env.MSTRO_BOUNCER_SECRET;
  const toolUseId = process.env.MSTRO_CURRENT_TOOL_USE_ID || `aq-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  if (!port || !tabId || !secret) {
    console.error('[MCP Bouncer] AskUserQuestion: missing routing context (port/tabId/secret) — passing through with no answers');
    return { behavior: 'allow', updatedInput: input };
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/internal/ask-user-question`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mstro-bouncer-secret': secret },
      body: JSON.stringify({ toolUseId, tabId, questions: input.questions }),
    });
    if (!res.ok) {
      console.error(`[MCP Bouncer] AskUserQuestion bridge returned ${res.status} — passing through with no answers`);
      return { behavior: 'allow', updatedInput: input };
    }
    const json = (await res.json()) as { answers?: Record<string, string> };
    const answers = json.answers && typeof json.answers === 'object' ? json.answers : {};
    return {
      behavior: 'allow',
      updatedInput: { questions: input.questions, answers },
    };
  } catch (err) {
    console.error(`[MCP Bouncer] AskUserQuestion bridge failed: ${err instanceof Error ? err.message : String(err)} — passing through with no answers`);
    return { behavior: 'allow', updatedInput: input };
  }
}

/**
 * Handle tool calls (approval_prompt)
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'approval_prompt') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { tool_name, input } = request.params.arguments as {
    tool_name: string;
    input: Record<string, unknown>;
  };

  // AskUserQuestion is a clarifying-question tool — Claude needs the user's
  // answers in `updatedInput.answers`, not a yes/no permission decision. Skip
  // the security review entirely (the prior pattern fast-path also auto-allowed
  // this) and route to the web UI bridge for real interactive answering.
  if (tool_name === 'AskUserQuestion') {
    console.error('[MCP Bouncer] AskUserQuestion received — bridging to web UI');
    const response = await bridgeAskUserQuestion(input);
    return {
      content: [{ type: 'text', text: JSON.stringify(response) }],
    };
  }

  console.error(`[MCP Bouncer] Analyzing ${tool_name} request...`);

  // Format operation string for bouncer analysis
  // Example: "Bash: rm -rf node_modules"
  let operationString = `${tool_name}:`;

  // Extract file path with multiple property name support
  // Claude Code may use file_path, filePath, or path depending on context
  const getFilePath = (inp: Record<string, unknown>) =>
    inp.file_path || inp.filePath || inp.path;

  if (tool_name === 'Bash' && input.command) {
    operationString += ` ${input.command}`;
  } else if (['Write', 'Edit', 'Read'].includes(tool_name)) {
    const filePath = getFilePath(input);
    operationString += filePath ? ` ${filePath}` : ` ${JSON.stringify(input)}`;
  } else {
    // Generic format: include all input parameters
    operationString += ` ${JSON.stringify(input)}`;
  }

  // Build bouncer request with context — include the user's original prompt
  // so Haiku can distinguish user-requested operations from prompt injection.
  const bouncerRequest: BouncerReviewRequest = {
    operation: operationString,
    context: {
      purpose: `Tool use request from Claude`,
      workingDirectory: process.cwd(),
      toolName: tool_name,
      toolInput: input,
      userRequest: process.env.BOUNCER_USER_PROMPT,
    },
  };

  try {
    // Use existing Mstro bouncer for analysis
    const decision = await reviewOperation(bouncerRequest);

    console.error(`[MCP Bouncer] Decision: ${decision.decision} (${decision.confidence}% confidence)`);
    console.error(`[MCP Bouncer] Reasoning: ${decision.reasoning}`);

    // Format response for Claude Code
    const response =
      decision.decision === 'deny'
        ? {
            behavior: 'deny',
            message: `🚫 ${decision.reasoning}${
              decision.alternative ? `\n\nAlternative: ${decision.alternative}` : ''
            }`,
          }
        : {
            behavior: 'allow',
            updatedInput: input,
            message:
              decision.decision === 'warn_allow'
                ? `⚠️  Allowed with caution: ${decision.reasoning}`
                : undefined,
          };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response),
        },
      ],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[MCP Bouncer] Error: ${errorMessage}`);

    // Fail-safe: deny on error
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            behavior: 'deny',
            message: `Security analysis failed: ${errorMessage}. Denying for safety.`,
          }),
        },
      ],
    };
  }
});

/**
 * Start the MCP server
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP Bouncer] Server started and ready');
}

main().catch((error) => {
  console.error('[MCP Bouncer] Fatal error:', error);
  process.exit(1);
});
