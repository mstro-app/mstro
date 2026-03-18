# mstro

Run [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from any browser. The CLI runs locally on your machine and streams live sessions to [mstro.app](https://mstro.app) via a secure WebSocket relay.

**mstro** runs on your laptop, cloud VM, or CI server and connects to the mstro.app web interface. You write prompts in the browser, Claude Code runs in your terminal.

## How It Works

```
Browser (mstro.app)  <--WebSocket-->  Platform Server (relay)  <--WebSocket-->  mstro (your machine)
                                                                           |
                                                                      Claude Code CLI
```

1. `mstro` starts a local server and connects to the mstro.app platform
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
mstro                    # Logs in automatically on first run, then starts the server
```

Or without installing globally:

```bash
npx mstro-app            # Same thing — login + launch in one command
```

On first run, mstro will:
1. Open your browser to authenticate with your mstro.app account
2. Connect to the platform

Then open [mstro.app](https://mstro.app) in your browser. Your machine appears as a connected workspace. Start prompting.

## Security Bouncer

The Bouncer automatically approves or blocks tool calls during mstro sessions. It is not active for standalone Claude Code.

**Mstro sessions (headless)** get the full 2-layer system via MCP:

1. **Pattern matching** (<5ms): Known-safe operations are allowed instantly. Known-dangerous patterns (destructive commands, fork bombs) are blocked instantly.
2. **AI analysis** (~200-500ms): Ambiguous operations are reviewed by a fast AI model to determine if they look like legitimate development work or prompt injection.

## CLI Reference

### Commands

```bash
mstro                       # Start mstro (logs in automatically if needed)
mstro login                 # Re-authenticate or switch accounts
mstro logout                # Sign out
mstro whoami                # Show current user and device info
mstro status                # Show connection and auth status
mstro setup-terminal        # Enable web terminal (compiles native module)
mstro telemetry [on|off]    # Show/toggle anonymous telemetry
```

### Options

| Option | Description |
|--------|-------------|
| `-p, --port <port>` | Start on a specific port (default: 4101, auto-increments if busy) |
| `-w, --working-dir <dir>` | Set working directory |
| `-v, --verbose` | Verbose output |
| `--version` | Show version |
| `--help` | Show help |

## Multiple Instances

Run multiple mstro instances for different projects. Each auto-selects an available port:

```
$ mstro                           # Project A
$ mstro                           # Project B
```

Each instance appears as a separate workspace in the web interface.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Override server port |
| `BOUNCER_USE_AI` | Set to `false` to disable AI analysis layer |
| `MSTRO_TELEMETRY` | Set to `0` to disable telemetry |
| `PLATFORM_URL` | Platform server URL (default: `https://api.mstro.app`) |

## Config Files

mstro stores config in `~/.mstro/`:

| File | Purpose |
|------|---------|
| `~/.mstro/credentials.json` | Device auth token (created by `mstro login`) |

## Requirements

- **Node.js 18+**
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** installed and authenticated

### Optional: Web Terminal

The web terminal feature requires a native module (`node-pty`). mstro works without it — you just won't have the terminal tab in the browser.

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
