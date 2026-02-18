# mstro

Luxurious remote workspace for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Run AI-powered coding sessions from any browser while Claude executes locally on any of your machines.

**mstro** is the CLI client for [mstro.app](https://mstro.app). It runs on your machine (laptop, cloud VM, CI server) and connects to the mstro.app web interface via a secure relay. You write prompts in the browser, Claude Code runs in your terminal.

**Get started at [mstro.app](https://mstro.app)** — create an account, then install this CLI to connect your machine.

## How It Works

```
Browser (mstro.app)  <--WebSocket-->  Platform Server (relay)  <--WebSocket-->  mstro (your machine)
                                                                           |
                                                                      Claude Code CLI
```

1. `mstro` starts a local server and connects to the mstro.app platform server
2. You open [mstro.app](https://mstro.app) in any browser and see your connected machine
3. Prompts you send in the browser are relayed to your machine
4. Claude Code runs locally with full access to your project files
5. Output streams back to the browser in real-time

Run Claude Code on a powerful remote machine and interact with it from your phone, tablet, or any device with a browser.

## Installation

```bash
npm install -g mstro-app
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` CLI available in your PATH).

## Quick Start

```bash
mstro login              # Authenticate this device with your mstro.app account
mstro                    # Start mstro in your project directory
```

On first run, mstro will offer to set up the **Security Bouncer** - a tool permission manager that protects against dangerous operations. Say yes.

Then open [mstro.app](https://mstro.app) in your browser. Your machine appears as a connected "orchestra." Start prompting.

## Security Bouncer

The Bouncer replaces the default human-in-the-loop approval model with an agent-in-the-loop approach. An AI reviewer is better suited to evaluate tool calls than a human — it has full context on what should and shouldn't run, responds in milliseconds instead of interrupting your flow, and frees you up to focus on higher-level work while Claude Code executes autonomously. The result is faster, safer workflows without the constant approval prompts. 

The bouncer hook is installed globally at `~/.claude/hooks/bouncer.sh` and applies to all Claude Code sessions, but the level of protection depends on how Claude Code is running:

**Mstro sessions (headless)** get the full 2-layer system:

1. **Pattern matching** (<5ms): Known-safe operations are allowed instantly. Known-dangerous patterns (destructive commands, fork bombs) are blocked instantly.
2. **AI analysis** (~200-500ms): Ambiguous operations are reviewed by a fast AI model to determine if they look like legitimate development work or prompt injection.

**Claude Code terminal REPL** (`claude`) gets 1-layer protection:

1. **Pattern matching only**: Blocks critical threats (fork bombs, `rm -rf /`, disk overwrites). Allows everything else. The AI analysis layer requires a running mstro server.

### Configure

The bouncer is set up automatically on first run. To reconfigure or install manually:

```bash
mstro configure-hooks
```

This installs a hook at `~/.claude/hooks/bouncer.sh` and registers it in `~/.claude/settings.json`.

Set `BOUNCER_USE_AI=false` to disable the AI analysis layer (pattern matching only).

## CLI Reference

### Commands

```bash
mstro                       # Start the client server
mstro login                 # Authenticate this device with mstro.app
mstro logout                # Sign out
mstro whoami                # Show current user and device info
mstro status                # Show connection and auth status
mstro setup-terminal        # Enable web terminal (compiles native module)
mstro configure-hooks       # Install/reconfigure Security Bouncer
```

### Options

| Option | Description |
|--------|-------------|
| `-p, --port <port>` | Start on a specific port (default: 4101, auto-increments if busy) |
| `-w, --working-dir <dir>` | Set working directory |
| `-v, --verbose` | Verbose output |
| `--dev` | Connect to local platform at localhost:4102 |
| `--version` | Show version |
| `--help` | Show help |

## Multiple Instances

Run multiple mstro instances for different projects. Each auto-selects an available port:

```
$ mstro                           # Project A → port 4101
$ mstro                           # Project B → port 4102
```

Each instance appears as a separate orchestra in the web interface.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Override server port |
| `BOUNCER_USE_AI` | Set to `false` to disable AI analysis layer |
| `PLATFORM_URL` | Platform server URL (default: `https://api.mstro.app`) |

## Config Files

mstro stores config in `~/.mstro/`:

| File | Purpose |
|------|---------|
| `~/.mstro/credentials.json` | Device auth token (created by `mstro login`) |
| `~/.claude/hooks/bouncer.sh` | Security Bouncer hook |
| `~/.claude/logs/bouncer.log` | Bouncer audit log |

## Requirements

- **Node.js 18+**
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** installed and authenticated

### Optional: Web Terminal

The web terminal feature requires a native module (`node-pty`). mstro works without it - you just won't have the terminal tab in the browser.

On first run, mstro will automatically attempt to compile `node-pty`. If your system has build tools installed, it just works. If not, mstro will let you know what to install:

- **macOS**: `xcode-select --install`
- **Linux (Debian/Ubuntu)**: `sudo apt install build-essential python3`
- **Linux (Fedora/RHEL)**: `sudo dnf install gcc-c++ make python3`
- **Windows**: `npm install -g windows-build-tools`

After installing build tools, run:

```bash
mstro setup-terminal
```

### Optional: Persistent Terminals

Install [tmux](https://github.com/tmux/tmux) for terminal sessions that survive restarts:

```bash
# macOS
brew install tmux

# Debian/Ubuntu
sudo apt install tmux
```

## Links

- **Web App**: [mstro.app](https://mstro.app)
- **GitHub**: [github.com/mstro-app/mstro](https://github.com/mstro-app/mstro)

## Telemetry

Mstro collects anonymous error reports and usage data to improve the software. No personal data or code is collected.

```bash
mstro telemetry off    # Disable telemetry
mstro telemetry on     # Enable telemetry
```

See [PRIVACY.md](./PRIVACY.md) for details.

## License

MIT
