# Mstro CLI

Local server and CLI that runs on the user's machine. Published to npm as `mstro-app`. Executes Claude Code workflows via improvise mode and connects to the platform via WebSocket relay.

## Before You Code

- Read the full file you're modifying, not just the function. CLI code has cross-cutting concerns (auth, WebSocket state, bouncer hooks) that break if you miss context.
- The CLI is the user's local machine. Destructive file ops, process spawning, and port binding are real — double-check before writing code that touches the filesystem or spawns processes.
- WebSocket messages flow: web -> server -> cli. If you change a message handler in cli, check the corresponding sender in server/src/relay/ and web/src/services/.
- The Security Bouncer is critical infrastructure. Do not weaken pattern rules in security-patterns.ts or bypass the 2-layer check in bouncer-integration.ts without explicit instruction.

## Commands

```bash
npm run dev         # Dev server with tsx (port 4101)
npm run dev:mcp     # MCP bouncer server only
npm run start       # Production server
npm run mstro       # CLI entry point
npm run mstro:dev   # CLI in dev mode
npm run test        # Run vitest
```

## Stack

- Node.js + tsx (no build step in dev)
- Hono web framework + @hono/node-server
- @modelcontextprotocol/sdk for MCP bouncer
- ws for WebSocket (platform relay + local improv sessions)
- Fuse.js for fuzzy file search (autocomplete)
- node-pty (optional) for terminal sessions
- Published as ESM (`"type": "module"`)

## Source Layout

```
server/
  index.ts                          # Hono app entry, port detection, WebSocket setup
  routes/
    index.ts                        # Route aggregator
    files.ts                        # File REST endpoints
    improvise.ts                    # Improv session routes
    instances.ts                    # Claude instance management
    notifications.ts                # Push notification routes
  services/
    auth.ts                         # Local session token auth (~/.mstro/session-token)
    platform.ts                     # WebSocket connection to platform server
    credentials.ts                  # Token storage (~/.mstro/)
    client-id.ts                    # Persistent client UUID
    instances.ts                    # Claude instance lifecycle
    files.ts                        # File system operations
    analytics.ts                    # PostHog analytics
    websocket/
      handler.ts                    # Main WebSocket message router
      autocomplete.ts               # File autocomplete with frecency + fuzzy matching
      file-utils.ts                 # Directory scanning, gitignore parsing
      types.ts                      # WebSocket types
    terminal/
      pty-manager.ts                # PTY session management
      tmux-manager.ts               # Tmux integration
  cli/
    improvisation-session-manager.ts # Live improv session management
    headless/                       # Headless runner internals
      runner.ts                     # Main orchestrator — spawns Claude CLI
      claude-invoker.ts             # Claude CLI process spawning
      mcp-config.ts                 # MCP bouncer config generation
      prompt-utils.ts               # Prompt enrichment utilities
      output-utils.ts               # Output parsing utilities
      types.ts                      # Headless runner types
  mcp/
    server.ts                       # MCP server entry
    bouncer-integration.ts          # 2-layer security (patterns + Haiku AI)
    security-patterns.ts            # Threat pattern matching
    bouncer-cli.ts                  # CLI for bouncer testing
    security-audit.ts               # Audit logging
  utils/
    paths.ts                        # Path utilities
    port.ts, port-manager.ts        # Port detection/allocation
    agent-manager.ts                # Claude agent lifecycle
bin/
  mstro.js                          # Main CLI entry (npm bin)
  commands/                         # CLI subcommands: login, logout, status, whoami
  postinstall.js                    # Post-install setup
  configure-claude.js               # Configure Claude hooks
hooks/
  bouncer.sh                   # Pre-tool-use security hook for Claude Code
```

## API Endpoints

- `GET /health` — Server status
- `GET /api/config` — Server configuration
- `WS /ws` — Local WebSocket (improv sessions, autocomplete)

## Security Bouncer

2-layer tool approval system for Claude Code:

1. **Pattern Matching** (<5ms) — Critical threats -> DENY, known-safe -> ALLOW
2. **Haiku AI Analysis** (~200-500ms) — Context-aware decisions for ambiguous cases

Installed via `hooks/bouncer.sh` -> `~/.claude/hooks/`

## File Locations

- Client config: `~/.mstro/` (client-id, credentials, session-token, frecency data)
- Bouncer hook: `~/.claude/hooks/bouncer.sh`

## Development Notes

- Runs on Node with tsx for dev, no compilation needed
- Port 4101 by default, auto-finds available port if taken
- WebSocket maintains persistent connection to platform for relay
- Autocomplete scans working directory, excludes node_modules/dist/etc, uses frecency + fuzzy matching
