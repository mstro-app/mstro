#!/usr/bin/env -S npx tsx
// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

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
 * Handle tool calls (approval_prompt)
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'approval_prompt') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { tool_name, input } = request.params.arguments as {
    tool_name: string;
    input: Record<string, any>;
  };

  console.error(`[MCP Bouncer] Analyzing ${tool_name} request...`);

  // Format operation string for bouncer analysis
  // Example: "Bash: rm -rf node_modules"
  let operationString = `${tool_name}:`;

  // Extract file path with multiple property name support
  // Claude Code may use file_path, filePath, or path depending on context
  const getFilePath = (inp: Record<string, any>) =>
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

  // Build bouncer request with context
  const bouncerRequest: BouncerReviewRequest = {
    operation: operationString,
    context: {
      purpose: `Tool use request from Claude`,
      workingDirectory: process.cwd(),
      toolName: tool_name,
      toolInput: input,
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
  } catch (error: any) {
    console.error(`[MCP Bouncer] Error: ${error.message}`);

    // Fail-safe: deny on error
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            behavior: 'deny',
            message: `Security analysis failed: ${error.message}. Denying for safety.`,
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
