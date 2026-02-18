# Mstro MCP Bouncer Server

This directory contains the Model Context Protocol (MCP) server implementation for Mstro v2's security bouncer.

## Overview

The MCP bouncer server provides permission approval/denial for Claude Code tool use via the MCP protocol. It integrates with Mstro's security analysis system to review potentially risky operations before they execute.

## Architecture

The bouncer uses a 2-layer security system:

### Layer 1: Pattern-Based Fast Path (~95% of operations, <5ms)
- **Critical threats** → Immediate DENY (99% confidence)
- **Known-safe operations** → Immediate ALLOW (95% confidence)
- Uses consolidated security patterns

### Layer 2: Haiku AI Analysis (~5% of operations, 200-500ms)
- Lightweight AI for ambiguous cases
- Context-aware decisions with reasoning
- Uses Claude Code headless pattern (spawn + stdin)
- Variable confidence (50-90%)

## Files

- **server.ts** - Main MCP server entry point
- **bouncer-integration.ts** - Core security review logic
- **security-patterns.ts** - Pattern definitions for fast-path security checks
- **security-audit.ts** - Audit logging system

## Usage

### Starting the Server

```bash
# From mstro-v2 root directory
npm run dev:mcp

# Or directly with bun
bun run server/mcp/server.ts
```

### Configuration

The server is configured via `mstro-bouncer-mcp.json` in the project root:

```json
{
  "mcpServers": {
    "mstro-bouncer": {
      "command": "bun",
      "args": ["run", "server/mcp/server.ts"],
      "description": "Mstro security bouncer for approving/denying Claude Code tool use",
      "env": {
        "BOUNCER_USE_AI": "true"
      }
    }
  }
}
```

### Using with Claude Code

```bash
claude --print --permission-prompt-tool mcp__mstro-bouncer__approval_prompt \
  --mcp-config mstro-bouncer-mcp.json \
  "your prompt here"
```

## Environment Variables

- **BOUNCER_USE_AI** - Enable/disable AI analysis (default: `true`)
  - Set to `false` to use only pattern-based checks
- **CLAUDE_COMMAND** - Claude CLI command (default: `claude`)

## Security Patterns

### Critical Threats (Auto-deny)
- Root/home directory deletion (`rm -rf / or ~`)
- Fork bombs
- Disk device overwrites
- Filesystem formatting
- Obfuscated code execution

### Safe Operations (Auto-allow)
- Read/Glob/Grep operations
- Common package manager commands (`npm install`, `yarn build`)
- Git operations (`status`, `log`, `diff`)
- Safe file deletions (`node_modules`, `dist`, `build`)

### Requires AI Review
- Pipe-to-shell from remote sources
- Sudo operations
- Writing executable files
- System directory modifications
- Custom script execution

## Audit Logging

All security decisions are logged to `./logs/security/bouncer-audit.jsonl` in JSON Lines format.

Example log entry:
```json
{
  "timestamp": "2025-11-15T12:00:00.000Z",
  "operation": "Bash: rm -rf node_modules",
  "decision": "allow",
  "confidence": 95,
  "reasoning": "Operation matches known-safe patterns",
  "threatLevel": "low"
}
```

## Performance

- 95%+ operations resolve in <5ms (Layer 1)
- 5% require AI analysis (~200-500ms)
- No ANTHROPIC_API_KEY required - uses existing Claude installation

## Integration

The MCP server runs separately from the web application servers and is only needed when using Claude Code's permission prompts feature. It does NOT auto-start with `npm start` or the web servers.
