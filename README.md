<div align="center">

<img src="https://mstro.app/mstro-icon.svg" alt="Mstro" width="96" height="96" />

# Mstro

*Browser-based IDE and AI agent orchestration for Claude Code.*

[![npm version](https://img.shields.io/npm/v/mstro-app?style=flat-square&color=000)](https://www.npmjs.com/package/mstro-app)
[![npm downloads](https://img.shields.io/npm/dm/mstro-app?style=flat-square&color=000)](https://www.npmjs.com/package/mstro-app)
[![Node version](https://img.shields.io/node/v/mstro-app?style=flat-square)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-PolyForm--NC-blue?style=flat-square)](./LICENSE)
[![Built for Claude Code](https://img.shields.io/badge/built%20for-Claude%20Code-orange?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)

[Website](https://mstro.app) · [Blog](https://mstro.app/blog) · [Compare](https://mstro.app/compare) · [Security](./SECURITY.md)

</div>

<div align="center">
  <img src="https://mstro.app/screenshots/chat-desktop.png" alt="Mstro chat and IDE running in the browser" width="900" />
</div>

---

Run Claude Code in parallel across git worktrees, auto-approve safe tools with the Security Bouncer, and control long-running AI work from any device at [mstro.app](https://mstro.app). Your code never leaves your computer.

> **Free for the first 1,000 users.** No credit card. Bring your own Anthropic API key.

---

## Quick Start

> **Start in 30 seconds:**
>
> ```bash
> curl -fsSL install.mstro.app | sh
> ```
>
> Then run `mstro` in any project directory. Open [mstro.app](https://mstro.app). Start building.

**Prerequisites:**

- Node.js 18+ (check with `node --version`, [download here](https://nodejs.org/))
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and signed in. `claude` must work in your terminal

**Install:**

```bash
curl -fsSL install.mstro.app | sh
```

The installer detects bun, pnpm, or npm and installs the CLI globally. Or with npm directly:

```bash
npm install -g mstro-app
```

Then run the CLI in any project directory:

```bash
mstro
```

On first run, mstro opens your browser to sign in. Once connected, open [mstro.app](https://mstro.app) — your machine appears as a workspace.

Run `mstro` on multiple machines. Each one appears as a separate workspace.

Stop with `Ctrl+C`.

---

## What Mstro Does

**1. Browser-based IDE for remote machines.** Open [mstro.app](https://mstro.app) and connect to Claude Code running on your laptop, cloud VMs, or servers. Chat, edit files, use git, run terminals. All from any browser, on any device. Your code stays on your hardware.

**2. Long-running AI tasks without babysitting.** Start a complex task and walk away. The Security Bouncer handles every permission decision automatically. A three-layer watchdog detects stalls, kills frozen processes, and recovers. Come back to finished work.

**3. One prompt to a full kanban board of parallel AI agents.** Describe what you want. The PM board breaks it into a kanban board of tasks, then AI agent teams execute them in parallel on separate git worktrees. Track progress in real time. What takes a solo developer a week ships in hours.

**4. One prompt to an autonomous business.** The long-term direction: self-managing AI-powered businesses that optimize for profit. Today Mstro ships the agent orchestration layer that makes it possible.

---

## Features

| Feature | What it does |
|---------|-------------|
| **Chat** | Parallel AI conversation tabs with file autocomplete and drag-and-drop context |
| **PM Board** | One prompt becomes a kanban board. AI agent teams build features in parallel on separate git worktrees |
| **Quality** | Automated linting, complexity analysis, and AI code review before shipping |
| **Files** | Browse, edit, search, and diff files on any connected machine with syntax highlighting |
| **Git** | Stage, commit, push, and create PRs — AI writes commit messages |
| **Terminal** | Full PTY shell access to any machine from your browser |
| **Shared Apps** | Invite others with view-only, project control, or full machine access |

## How It Works

```
Browser (mstro.app) <--WS--> Platform Server (relay) <--WS--> mstro CLI (your machine) --> Claude Code
```

Your code never leaves your computer. The browser is a window into what's happening on your machines.

---

## Security

The Security Bouncer makes permission decisions so you don't have to sit there clicking "Allow."

Two layers:

1. **Pattern matching** (<5ms): instantly blocks known threats like `rm -rf /` and reverse shells
2. **AI analysis** (~200-500ms): catches prompt injection and data exfiltration

Validated against 400+ tests covering 22 MITRE ATT&CK techniques.

For the full architecture, threat model, red-team results, and vulnerability reporting, see **[SECURITY.md](./SECURITY.md)**.

### Autonomous Execution

Three safety layers run continuously during AI sessions:

- **Security Bouncer**: 2-layer tool approval (pattern matching + Haiku AI) via MCP
- **Stall Assessor**: heuristic + AI analysis detects stuck processes
- **Tool Watchdog**: per-tool adaptive timeouts using RFC 6298 EMA, with custom profiles for long-running operations (WebFetch 3m, Bash 5m, Task 15m)

---

## PM Board

The PM board turns a single prompt into a managed project:

1. Describe what you want to build
2. AI generates a kanban board with prioritized issues
3. AI agent teams execute issues in parallel on separate git worktrees
4. Track progress in real time — see each agent's output, status, and artifacts
5. Review quality before merging

Configurable parallel execution (max concurrent agents), custom review criteria per board, and board-scoped artifacts (progress logs, output files, review results).

<details>
<summary><strong>Custom Review Agents</strong> — override review prompts per board</summary>

When a task moves to "In Review", an AI review agent checks the work. There are three built-in agents:

| Agent | When used | What it checks |
|-------|-----------|----------------|
| `review-code` | Task modifies source files | Acceptance criteria, bugs, security, code quality |
| `review-quality` | Task produces non-code output | Acceptance criteria, content accuracy, completeness, structure |
| `review-custom` | Board has custom review criteria | Acceptance criteria + your custom criteria |

**Quick customization.** Click the gear icon on the "In Review" column header to set review criteria for the board. Works for code, writing, research, design, whatever.

**Full prompt control.** Drop a markdown agent file into your board's `agents/` directory to replace the default review prompt entirely:

```
.mstro/pm/boards/BOARD-001/
  board.md
  agents/
    review-code.md      # Override code review for this board
    review-quality.md   # Override non-code review for this board
    review-custom.md    # Override custom criteria review for this board
```

Agent files are markdown with YAML frontmatter and `{{variable}}` placeholders:

```markdown
---
name: review-code
description: Custom code review for my project
type: review
variables: [issue_id, issue_title, files_modified, acceptance_criteria, output_path]
checks: [criteria_met, code_quality, no_obvious_bugs]
---

You are a reviewer for {{issue_title}}.

## Files Modified
{{files_modified}}

## Acceptance Criteria
{{acceptance_criteria}}

(your custom instructions here)

Output EXACTLY one JSON object on its own line (no markdown fencing):
{"passed": true, "checks": [{"name": "criteria_met", "passed": true, "details": "..."}]}
```

<details>
<summary>Available template variables</summary>

| Variable | Available in | Description |
|----------|-------------|-------------|
| `issue_id` | All agents | Issue ID (e.g., ISS-001) |
| `issue_title` | All agents | Issue title |
| `acceptance_criteria` | All agents | Formatted acceptance criteria checklist |
| `files_modified` | review-code | List of modified file paths |
| `output_path` | review-code, review-quality | Path to output artifact |
| `issue_spec_path` | review-quality | Path to the issue spec file |
| `context_section` | review-custom | Files or output section (depends on task type) |
| `review_criteria` | review-custom | Board-level review criteria text |
| `read_instruction` | review-custom | Read instruction (changes based on task type) |

</details>

Resolution order: board agent file > system default > hardcoded fallback. If there's no board override, the built-in agents run.

</details>

## Quality

Quality analysis runs across your codebase:

- **Tool detection**: auto-detects linters and analyzers for your ecosystem (Node, Python, Rust, Go, Swift, Kotlin)
- **Automated scanning**: runs detected tools with progress tracking
- **AI code review**: Claude reviews code for architecture violations, SOLID principles, security, and performance
- **Severity scoring**: findings tagged with severity, category, file paths, and line numbers
- **Automated fixes**: AI can fix identified issues with progress tracking

---

## CLI Reference

```bash
mstro                       # Start (auto-authenticates)
mstro login                 # Authenticate or switch accounts
mstro logout                # Sign out
mstro whoami                # Show user and device info
mstro status                # Show connection status
mstro setup-terminal        # Enable web terminal (compiles native module)
mstro telemetry [on|off]    # Toggle anonymous telemetry
```

### Options

| Flag | Description |
|------|-------------|
| `-p, --port <port>` | Start on a specific port (default: 4101, auto-increments if busy) |
| `-w, --working-dir <dir>` | Set working directory |
| `-v, --verbose` | Verbose output |
| `--version` | Show version |
| `--help` | Show help |

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Override server port |
| `BOUNCER_USE_AI` | `false` to disable AI analysis layer |
| `MSTRO_TELEMETRY` | `0` to disable telemetry |

### Config Files

Stored in `~/.mstro/`:

| File | Purpose |
|------|---------|
| `credentials.json` | Device auth token (created by `mstro login`) |
| `settings.json` | Model selection, preferences |
| `session-registry.json` | Tab-to-session mapping |

---

## Architecture

<details>
<summary><strong>Source layout</strong> — full file tree of subsystems</summary>

```
server/
  index.ts                          # Hono app entry, port detection, WebSocket setup
  services/
    websocket/handler.ts            # Main WebSocket message router
    websocket/*-handlers.ts         # Domain handlers (session, plan, quality, git, terminal, files)
    plan/executor.ts                # PM board execution engine
    plan/composer.ts                # AI prompt composition for boards
    plan/review-gate.ts             # Quality gates for board execution
    plan/agent-loader.ts            # Review agent prompt loader (layered resolution)
    plan/agents/                    # System default review agent prompts (markdown)
    terminal/pty-manager.ts         # PTY session management
    platform.ts                     # WebSocket connection to platform server
  cli/
    headless/runner.ts              # Claude Code orchestrator
    headless/stall-assessor.ts      # 2-layer stall detection (heuristic + Haiku AI)
    headless/tool-watchdog.ts       # Per-tool adaptive timeouts (RFC 6298 EMA)
    improvisation-session-manager.ts # Session orchestration, retry, checkpoints
  mcp/
    server.ts                       # MCP server (stdio transport)
    bouncer-integration.ts          # 2-layer security (patterns + Haiku AI)
    security-patterns.ts            # Threat/safe pattern matching
bin/
  mstro.js                          # CLI entry point
  commands/                         # login, logout, status, whoami, config
```

</details>

### Key Subsystems

- **Headless Runner**: spawns Claude Code processes with MCP bouncer integration, manages lifecycle
- **Improvisation Session Manager**: session orchestration, retry with context recovery, checkpoint-and-retry on tool timeouts
- **Security Bouncer**: MCP-integrated 2-layer tool approval (see [SECURITY.md](./SECURITY.md))
- **PM Board Executor**: parallel board execution with wave-based scheduling and quality gates
- **PTY Manager**: terminal session management with tmux support and subscriber model
- **Session Registry**: tab-to-session persistence across WebSocket disconnects

---

## Optional Setup

### Web Terminal

The terminal tab requires a native module. Mstro tries to compile it automatically on first run. If it fails, install build tools first:

- **macOS**: `xcode-select --install`
- **Linux (Debian/Ubuntu)**: `sudo apt install build-essential python3`
- **Linux (Fedora/RHEL)**: `sudo dnf install gcc-c++ make python3`
- **Windows**: `npm install -g windows-build-tools`

Then run `mstro setup-terminal`.

### Persistent Terminals

Install [tmux](https://github.com/tmux/tmux) for sessions that survive restarts:

```bash
# macOS
brew install tmux
# Debian/Ubuntu
sudo apt install tmux
```

## Development

```bash
cd cli
npm install
npm run dev          # Dev server with tsx (port 4101)
npm run test         # vitest
npm run check        # tsc + vitest + biome + npm audit
npm run build        # tsc -p tsconfig.build.json
```

The CLI runs on Node.js with tsx in development (no build step). Hono serves HTTP and WebSocket. Biome handles linting. Published as ESM.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `claude` not found | Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and sign in |
| Port conflict | `mstro -p 4200` or let it auto-increment |
| Machine not appearing | Run `mstro status` to verify connection |
| node-pty build fails | Install build tools (see Optional Setup), then `mstro setup-terminal` |

## Uninstall

```bash
npm uninstall -g mstro-app
rm -rf ~/.mstro
```

---

## Links

- **Web App**: [mstro.app](https://mstro.app)
- **Blog**: [mstro.app/blog](https://mstro.app/blog) — essays on AI agent orchestration, parallel agents, and shipping with Claude Code
- **Compare**: [mstro.app/compare](https://mstro.app/compare) — how Mstro compares to Cursor, Claude Code, Copilot, Codex, JetBrains, and more
- **Security**: [SECURITY.md](./SECURITY.md) — bouncer architecture, threat model, red teaming, vulnerability reporting

## License

PolyForm Noncommercial License 1.0.0. See [LICENSE](./LICENSE).

You can view, modify, and distribute the source code for any **noncommercial** purpose — personal study, hobby projects, research, evaluation, and use by charitable, educational, public-research, public-safety, environmental, or government organizations. Any commercial use, including offering a commercial product or service derived from this code, requires a separate commercial license from Mstro.

For commercial licensing inquiries, contact bravo@mstro.app.
