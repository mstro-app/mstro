# mstro

Run [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from any browser. Your code stays on your machine, mstro bridges your computer and your browser through a secure connection.

> **Get started in 30 seconds:**
>
> ```bash
> npx mstro-app
> ```
>
> Open [mstro.app](https://mstro.app) in your browser. Start prompting.

## What Is This?

mstro is for developers who use Claude Code and want to:

- **Work from any device**: start on your desktop, continue from your phone or tablet
- **Use a powerful machine remotely**: run Claude on a beefy server, interact from a lightweight laptop
- **Stop babysitting permissions**: mstro's Security Bouncer handles tool approvals automatically so you can kick off long-running tasks and walk away knowing Claude will keep working until the job is done
- **Share live sessions**: let a teammate watch or collaborate in real time

If you haven't used Claude Code before, [start here](https://docs.anthropic.com/en/docs/claude-code).

## How It Works

1. Start mstro on a computer with your project files (one command in the terminal)
2. Open [mstro.app](https://mstro.app) in any browser, your machine appears as a workspace
3. Type a prompt in the browser, and mstro works on your code directly on your machine
4. Results stream back to your browser in real time

Your code never leaves your computer. The browser is just a window into what's happening.

## Prerequisites

- **Node.js 18+**: check with `node --version` ([download](https://nodejs.org/) if needed)
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** installed and signed in, you should be able to run `claude` in your terminal

## Installation

```bash
npm install -g mstro-app
```

Or skip the install and run directly:

```bash
npx mstro-app
```

## Quick Start

```bash
mstro
```

On first run, mstro opens your browser so you can sign in to your mstro.app account. Once connected, open [mstro.app](https://mstro.app), your machine appears as a workspace. Start a conversation with Claude right from your browser.

Run multiple instances for different projects. Each auto-selects an available port and appears as a separate workspace on [mstro.app](https://mstro.app)

Stop with Ctrl+C.

## CLI Reference

Running `mstro` with no arguments starts a local server on port 4101 (auto-increments if busy), connects to the relay server, and runs in the foreground.

### Commands

```bash
mstro                       # Start mstro (auto-authenticates if needed)
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

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Override server port |
| `BOUNCER_USE_AI` | Set to `false` to disable AI analysis layer |
| `MSTRO_TELEMETRY` | Set to `0` to disable telemetry |

### Config Files

mstro stores config in `~/.mstro/`:

| File | Purpose |
|------|---------|
| `~/.mstro/credentials.json` | Device auth token (created by `mstro login`) |

## Security

When you use Claude Code through mstro, you don't need to sit there approving every file write and shell command. The Security Bouncer makes those decisions for you, and it's been tested more rigorously than any human clicking "Allow" ever could be.

The bouncer runs two layers of checks on every tool call: fast pattern matching that instantly blocks known threats (like `rm -rf /` or reverse shells) and an AI analysis layer that catches the subtle stuff like prompt injection and data exfiltration. It's validated against 400+ tests covering 22 MITRE ATT&CK techniques, including adversarial red teaming with real attack payloads.

The result: you can trust mstro to run unattended and make better, more consistent security decisions than the "click Allow and hope for the best" workflow that most developers have normalized.

For full details on architecture, threat model, red team results, and vulnerability reporting see **[SECURITY.md](./SECURITY.md)**.

## Optional Setup

### Web Terminal

The web terminal lets you use a full terminal in your browser. mstro works without it, if you don't set it up you just won't have the terminal tab.

On first run, mstro automatically tries to compile the required native module. If your system has build tools, it just works. If not, install them first:

- **macOS**: `xcode-select --install`
- **Linux (Debian/Ubuntu)**: `sudo apt install build-essential python3`
- **Linux (Fedora/RHEL)**: `sudo dnf install gcc-c++ make python3`
- **Windows**: `npm install -g windows-build-tools`

Then run:

```bash
mstro setup-terminal
```

### Persistent Terminals

Install [tmux](https://github.com/tmux/tmux) for terminal sessions that survive restarts:

```bash
# macOS
brew install tmux

# Debian/Ubuntu
sudo apt install tmux
```

## Troubleshooting

**`claude` not found** — Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and make sure you can run `claude` in your terminal.

**Port conflict** — mstro auto-increments, but you can force a port with `mstro -p 4200`.

**Machine not appearing in web app** — Run `mstro status` to verify the platform connection.

**node-pty build fails** — Install build tools for your OS (see Optional Setup above), then run `mstro setup-terminal`.

## Uninstall

```bash
npm uninstall -g mstro-app
rm -rf ~/.mstro
```

## Telemetry and Privacy

Mstro collects anonymous error reports and usage data to improve the software. No personal data or code is collected. See [PRIVACY.md](./PRIVACY.md) for details.

```bash
mstro telemetry off    # Disable
mstro telemetry on     # Enable
```

## Links

- **Web App**: [mstro.app](https://mstro.app)
- **GitHub**: [github.com/mstro-app/mstro](https://github.com/mstro-app/mstro)
- **Security**: [SECURITY.md](./SECURITY.md) — bouncer architecture, threat model, vulnerability reporting

## License

MIT
