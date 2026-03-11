# Mstro CLI Server

Local HTTP and WebSocket server that runs on the user's machine. Serves as the bridge between the mstro.app web interface and Claude Code.

## Running

```bash
# From cli/ directory
npm run dev         # Dev server with tsx (port 4101)
npm run start       # Production server
npm run dev:mcp     # MCP bouncer server only
```

Port 4101 by default. Auto-finds an available port if taken (increments up to +20).

## Stack

- **Runtime:** Node.js 18+ with tsx (TypeScript execution, no build step in dev)
- **Framework:** Hono + @hono/node-server
- **WebSocket:** ws library for platform relay and local connections
- **MCP:** @modelcontextprotocol/sdk for security bouncer
- **Search:** Fuse.js for fuzzy file matching with frecency scoring
- **Terminal:** node-pty (optional) for PTY sessions
- **Analytics:** PostHog (opt-out)
- **Errors:** Sentry

## Architecture

```
Browser (mstro.app)
    ↕ WebSocket (platform relay)
Platform Server (api.mstro.app)
    ↕ WebSocket (persistent connection)
CLI Server (this code, port 4101)
    ├── HTTP API (file listing, instance management, history)
    ├── WebSocket (/ws) — real-time messages (execute, git, terminal, files)
    ├── Platform Connection — relay to/from mstro.app
    └── Claude Code — headless execution via CLI spawning
```

## Source Layout

```
server/
├── index.ts                              # Hono app entry, port detection, WebSocket setup
├── routes/
│   ├── index.ts                          # Route aggregator
│   ├── files.ts                          # File REST endpoints
│   ├── improvise.ts                      # Improv session history routes
│   ├── instances.ts                      # Instance management routes
│   └── notifications.ts                  # Notification generation routes
├── services/
│   ├── auth.ts                           # Local session token auth (~/.mstro/session-token)
│   ├── platform.ts                       # WebSocket connection to platform server
│   ├── credentials.ts                    # Token storage (~/.mstro/)
│   ├── client-id.ts                      # Persistent client UUID
│   ├── instances.ts                      # Instance lifecycle + registry
│   ├── files.ts                          # File system operations
│   ├── analytics.ts                      # PostHog analytics
│   ├── settings.ts                       # User settings persistence
│   ├── pathUtils.ts                      # Path validation
│   ├── sandbox-utils.ts                  # Environment sandboxing
│   ├── sentry.ts                         # Error tracking
│   ├── terminal/
│   │   └── pty-manager.ts                # PTY session management
│   └── websocket/
│       ├── handler.ts                    # Main WebSocket message router
│       ├── handler-context.ts            # Handler context interface
│       ├── session-registry.ts           # Session persistence registry
│       ├── autocomplete.ts               # File autocomplete + frecency
│       ├── file-utils.ts                 # Directory scanning, gitignore
│       ├── file-explorer-handlers.ts     # File explorer operations
│       ├── git-handlers.ts               # Git status/log/staging
│       ├── git-pr-handlers.ts            # Git PR operations
│       ├── git-worktree-handlers.ts      # Git worktree operations
│       ├── terminal-handlers.ts          # Terminal I/O handlers
│       ├── session-handlers.ts           # Tab/session initialization
│       ├── settings-handlers.ts          # Settings sync
│       ├── tab-handlers.ts               # Tab management
│       └── types.ts                      # WebSocket message types
├── cli/
│   ├── improvisation-session-manager.ts  # Session orchestration + history
│   └── headless/
│       ├── runner.ts                     # Main orchestrator — spawns Claude CLI
│       ├── claude-invoker.ts             # Claude CLI process spawning
│       ├── mcp-config.ts                 # MCP bouncer config generation
│       ├── prompt-utils.ts               # Prompt enrichment
│       ├── output-utils.ts               # Output parsing
│       ├── stall-assessor.ts             # Stall detection/recovery
│       ├── tool-watchdog.ts              # Tool timeout enforcement
│       └── types.ts                      # Headless runner types
├── mcp/
│   ├── server.ts                         # MCP server entry
│   ├── bouncer-integration.ts            # 2-layer security (patterns + AI)
│   ├── security-patterns.ts              # Threat pattern matching
│   ├── bouncer-cli.ts                    # CLI wrapper for hook integration
│   └── security-audit.ts                 # Audit logging
└── utils/
    ├── paths.ts                          # Path utilities
    ├── port.ts                           # Port detection
    ├── port-manager.ts                   # Port allocation
    └── agent-manager.ts                  # Claude agent lifecycle
```

## HTTP API

### Public

- `GET /health` — Server status and version
- `GET /api/config` — Server configuration

### Authenticated (session token required)

- `GET /api/instances` — List running mstro instances
- `GET /api/instances/current` — Current instance info
- `POST /api/shutdown` — Graceful shutdown
- `GET /api/files?filter=...` — File listing with fuzzy search
- `GET /api/improvise/sessions` — List session history
- `GET /api/improvise/sessions/:id` — Get session details
- `POST /api/notifications/summarize` — Generate notification summary

## WebSocket API (`/ws`)

The WebSocket endpoint handles real-time communication for the web interface. Messages are JSON with a `type` field.

### Claude Execution

`execute`, `cancel`, `new`, `approve`, `reject`, `initTab`, `resumeSession`

### History

`getHistory`, `getSessions`, `getSessionsCount`, `getSessionById`, `deleteSession`, `clearHistory`, `searchHistory`

### File Operations

`autocomplete`, `readFile`, `recordSelection`, `listDirectory`, `writeFile`, `createFile`, `createDirectory`, `deleteFile`, `renameFile`, `searchFileContents`, `cancelSearch`, `findDefinition`, `notifyFileOpened`

### Terminal

`terminalInit`, `terminalReconnect`, `terminalList`, `terminalInput`, `terminalResize`, `terminalClose`

### Git

- Status: `gitStatus`, `gitLog`, `gitDiff`, `gitGetRemoteInfo`
- Staging: `gitStage`, `gitUnstage`, `gitCommit`, `gitCommitWithAI`
- Remote: `gitPush`, `gitPull`
- Branches: `gitListBranches`, `gitCheckout`, `gitCreateBranch`, `gitDeleteBranch`
- PRs: `gitCreatePR`, `gitGeneratePRDescription`
- Tags: `gitListTags`, `gitCreateTag`, `gitPushTag`
- Worktrees: `gitWorktreeList`, `gitWorktreeCreate`, `gitWorktreeRemove`, `gitWorktreePush`, `gitWorktreeCreatePR`, `gitWorktreeMerge`
- Merge: `gitMergePreview`, `gitMergeAbort`, `gitMergeComplete`
- Repo: `gitDiscoverRepos`, `gitSetDirectory`

### Tabs

`getActiveTabs`, `createTab`, `reorderTabs`, `syncTabMeta`, `syncPromptText`, `removeTab`, `markTabViewed`

### Settings

`getSettings`, `updateSettings`

## Middleware

1. **CORS** — Localhost-only in production, permissive in dev
2. **Logger** — HTTP request logging via Hono logger
3. **Session Auth** — Token validation on `/api/*` routes (`x-session-token` header)

## Authentication

**Local:** Session token stored at `~/.mstro/session-token` (32 random bytes, hex-encoded). Validated via `x-session-token` header on HTTP or `?token=` query param on WebSocket.

**Platform:** Device credentials stored at `~/.mstro/credentials.json`. Token sent as first WebSocket message to platform relay (not in URL to avoid logging).

## Platform Relay

Persistent WebSocket connection to `wss://api.mstro.app/ws/client`:

- Heartbeat every 2 minutes (server TTL is 5 minutes)
- Token refresh every 30 days
- Exponential backoff reconnect (max 10 attempts, up to 30s delay)
- Relays messages between web clients and local WebSocket handlers

## Headless Runner

Executes Claude Code for improvise sessions:

1. Enriches prompt with accumulated context
2. Spawns `claude` CLI with `--print` and MCP bouncer config
3. Parses JSON output, estimates token usage
4. Supports stall detection (5min warning, 30min kill, 1hr hard cap)
5. Tool timeout enforcement via watchdog
6. Model selection (opus, sonnet, haiku)

## File Locations

```
~/.mstro/
├── session-token              # Local auth token
├── credentials.json           # Platform auth
├── client-id                  # Persistent UUID
├── config.json                # Settings (telemetry)
├── instances.json             # Running instance registry
├── autocomplete-frecency.json # File frecency data
├── mcp-config.json            # Generated MCP config for Claude
├── history/                   # Session history (one JSON per session)
└── logs/
    └── bouncer-audit.jsonl    # Bouncer decision log
```
