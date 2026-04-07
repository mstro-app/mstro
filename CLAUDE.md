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
npm run start       # Production server (NODE_ENV=production)
npm run mstro       # CLI entry point (node bin/mstro.js)
npm run mstro:dev   # CLI in dev mode
npm run test        # vitest run
npm run test:watch  # vitest (interactive)
npm run test:coverage # vitest with coverage
npm run check       # tsc + vitest + biome + npm audit
npm run build       # tsc -p tsconfig.build.json
```

## Stack

- Node.js 18+ with tsx (no build step in dev)
- Hono web framework + @hono/node-server
- @modelcontextprotocol/sdk for MCP bouncer
- ws for WebSocket (platform relay + local improv sessions)
- Fuse.js for fuzzy file search (autocomplete with frecency)
- Sentry for error tracking
- PostHog for analytics (opt-out)
- node-pty (optional) for terminal sessions
- Biome for linting
- Published as ESM (`"type": "module"`)

## Source Layout

```
server/
  index.ts                          # Hono app entry, port detection, WebSocket setup
  routes/
    index.ts                        # Route aggregator
    files.ts                        # File REST endpoints
    improvise.ts                    # Improv session history routes
    instances.ts                    # Claude instance management + shutdown
    notifications.ts                # Push notification routes
  services/
    auth.ts                         # Local session token auth (~/.mstro/session-token)
    platform.ts                     # WebSocket connection to platform server
    credentials.ts                  # Token storage (~/.mstro/)
    client-id.ts                    # Persistent client UUID
    instances.ts                    # Claude instance lifecycle
    files.ts                        # File system operations
    analytics.ts                    # PostHog analytics
    settings.ts                     # Settings.json (model selection, PR base branches per repo)
    sentry.ts                       # Sentry error reporting
    pathUtils.ts                    # Path utilities
    terminal/
      pty-manager.ts                # PTY session management
    websocket/
      handler.ts                    # Main WebSocket message router
      handler-context.ts            # Context interface for handlers
      types.ts                      # WebSocket message types (100+ types)
      session-registry.ts           # Tab-to-session persistence (.mstro/session-registry.json)
      session-handlers.ts           # Execute, cancel, resume, history queries
      tab-handlers.ts               # Tab CRUD (create, delete, reorder, sync metadata)
      settings-handlers.ts          # Get/update machine-wide settings
      autocomplete.ts               # File autocomplete with frecency + fuzzy matching
      file-utils.ts                 # Directory scanning, .gitignore parsing
      file-explorer-handlers.ts     # listDirectory, createFile, writeFile, etc.
      file-upload-handler.ts        # File upload via WebSocket
      git-handlers.ts               # Git: status, stage, commit, push, pull, log, diff
      git-pr-handlers.ts            # PR creation + AI description generation
      git-worktree-handlers.ts      # Worktree ops + merge preview/complete
      terminal-handlers.ts          # Terminal init, input, resize, close, subscribers
  cli/
    improvisation-session-manager.ts # Session orchestration, retry logic, checkpoints
    headless/
      index.ts                      # HeadlessRunner class export
      runner.ts                     # Main orchestrator — spawns Claude CLI
      claude-invoker.ts             # Claude CLI process spawning with MCP bouncer
      mcp-config.ts                 # MCP bouncer config generation
      prompt-utils.ts               # Prompt enrichment utilities
      output-utils.ts               # Output parsing + token estimation
      types.ts                      # Headless runner types
      stall-assessor.ts             # 2-layer stall detection (heuristic + Haiku AI)
      tool-watchdog.ts              # Per-tool adaptive timeouts (RFC 6298 EMA)
  mcp/
    server.ts                       # MCP server entry (stdio transport)
    bouncer-integration.ts          # 2-layer security (patterns + Haiku AI)
    security-patterns.ts            # Threat/safe pattern matching
    security-audit.ts               # Audit logging (~/.mstro/logs/bouncer-audit.jsonl)
    bouncer-sandbox.ts              # Sandbox execution for bouncer
  utils/
    paths.ts                        # Path utilities
    port.ts, port-manager.ts        # Port detection/allocation
    agent-manager.ts                # Claude agent lifecycle
bin/
  mstro.js                          # Main CLI entry (npm bin)
  postinstall.js                    # Post-install setup
  commands/
    login.js                        # mstro login
    logout.js                       # mstro logout
    status.js                       # mstro status
    whoami.js                       # mstro whoami
    config.js                       # mstro config (telemetry on/off)
```

## API Endpoints

- `GET /health` — Server status + version
- `GET /api/config` — Server configuration
- `GET /api/improvise/sessions` — List session history
- `GET /api/improvise/sessions/:sessionId` — Session details
- `WS /ws` — Unified WebSocket (improv sessions, autocomplete, files, git, terminal, settings)

## Security Bouncer

2-layer tool approval system for mstro sessions:

1. **Pattern Matching** (<5ms) — Critical threats -> DENY, known-safe -> ALLOW
2. **Haiku AI Analysis** (~200-500ms) — Context-aware decisions for ambiguous cases

Philosophy: protect against injection attacks, not dangerous commands. Integrated via MCP in headless sessions. Not active for standalone Claude Code.

## Headless Execution

The HeadlessRunner orchestrates Claude Code execution:
- **Improvisation Session Manager** — Fast direct prompt execution, retry logic with context recovery, checkpoint-and-retry on tool timeouts
- **Stall Assessor** — Quick heuristic (known long-running patterns, token flow) + Haiku AI for ambiguous cases
- **Tool Watchdog** — Per-tool adaptive timeouts using RFC 6298 EMA, with coldstart defaults and floor/ceiling bounds. Custom profiles for WebFetch (3m), Bash (5m), Task (15m), etc.

## File Locations

- Client config: `~/.mstro/` (client-id, credentials, session-token, settings.json, frecency data, session-registry.json)
- History: `~/.mstro/history/` (session JSON files)
- Audit logs: `~/.mstro/logs/bouncer-audit.jsonl`

## Development Notes

- Runs on Node with tsx for dev, no compilation needed
- Port 4101 by default, auto-finds available port if taken
- WebSocket maintains persistent connection to platform for relay
- Autocomplete scans working directory, excludes node_modules/dist/etc, uses frecency + fuzzy matching
- Session registry persists tab-to-session mapping across WebSocket disconnects
- Settings.json stores model selection (defaults to opus) and per-repo PR base branches
- Shared sessions are view-only — the server blocks all write operations for non-owner users
