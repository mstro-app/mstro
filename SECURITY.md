# Security

mstro lets Claude Code run without a human approving every tool call. That's a big responsibility, and we treat it like one. This document covers what we built, how we tested it, and where the limits are.

## Red Team Results

Before anything else, here's what the bouncer has actually been tested against. We didn't just write pattern matching and call it a day. We threw real attack payloads at it.

**402 tests across 5 test suites:**

| Suite | Tests | What it covers |
|-------|-------|---------------|
| `bouncer-adversarial.test.ts` | 66 | Red team payloads: evasion techniques, command chaining, encoding tricks, indirect injection |
| `bouncer-layer2.integration.test.ts` | 50 | Real AI analysis with statistical reliability (3 runs per test, 2/3 must pass) |
| `security-patterns.test.ts` | 40 | Layer 1 pattern matching, risk classification, sensitive path detection |
| `mcp-injection.test.ts` | 32 | MCP-specific attacks: tool poisoning, cross-origin escalation, rug-pulls |
| `bouncer-integration.test.ts` | 17 | End-to-end review flow, caching, error handling |

The adversarial suite is the one worth paying attention to. Those 66 tests are actual attack payloads, not toy examples. They cover things like base64-encoded reverse shells, chained commands that try to sneak past safe-command detection, obfuscated `curl | bash` variants, and indirect prompt injection through file contents.

For the AI layer, we use statistical reliability testing. Each test runs 3 times against real Claude Haiku, and at least 2 out of 3 runs have to pass. This is the same approach used by academic agent security benchmarks like [AgentDojo](https://arxiv.org/abs/2406.13352) and [InjecAgent](https://arxiv.org/abs/2403.02691). LLMs are non-deterministic, so you have to test that way.

### MITRE ATT&CK Coverage

Every defense maps to a [MITRE ATT&CK](https://attack.mitre.org/) technique ID.

| Technique | Name | Layer | Action |
|-----------|------|-------|--------|
| [T1059.004](https://attack.mitre.org/techniques/T1059/004/) | Unix Shell, reverse shells, `curl\|bash` | L1 Pattern | Blocked |
| [T1059.006](https://attack.mitre.org/techniques/T1059/006/) | Python/Perl reverse shells | L1 Pattern | Blocked |
| [T1485](https://attack.mitre.org/techniques/T1485/) | Data Destruction, `rm -rf /` | L1 Pattern | Blocked |
| [T1561.002](https://attack.mitre.org/techniques/T1561/002/) | Disk Wipe, `dd`, `mkfs` | L1 Pattern | Blocked |
| [T1499.004](https://attack.mitre.org/techniques/T1499/004/) | Endpoint DoS, fork bombs | L1 Pattern | Blocked |
| [T1222](https://attack.mitre.org/techniques/T1222/) | File Permissions Modification, `chmod 000 /` | L1 Pattern | Blocked |
| [T1041](https://attack.mitre.org/techniques/T1041/) | Exfiltration Over C2 Channel | L1+L2 | Blocked |
| [T1048](https://attack.mitre.org/techniques/T1048/) | Exfiltration Over Alternative Protocol, `nc`, `scp` | L1+L2 | Blocked |
| [T1567](https://attack.mitre.org/techniques/T1567/) | Exfiltration Over Web Service, webhooks, APIs | L2 AI | Blocked |
| [T1552.005](https://attack.mitre.org/techniques/T1552/005/) | Cloud Instance Metadata (IMDS), `169.254.169.254` | L1+L2 | Blocked |
| [T1098.004](https://attack.mitre.org/techniques/T1098/004/) | SSH Authorized Keys manipulation | L1 Pattern | Blocked |
| [T1546.004](https://attack.mitre.org/techniques/T1546/004/) | Unix Shell Config Modification, `.bashrc`, `.zshrc` | L1 Pattern | Blocked |
| [T1053.003](https://attack.mitre.org/techniques/T1053/003/) | Cron persistence, `crontab` writes | L1 Pattern | Blocked |
| [T1574.006](https://attack.mitre.org/techniques/T1574/006/) | Dynamic Linker Hijacking, `ld.so.preload` | L1 Pattern | Blocked |
| [T1543](https://attack.mitre.org/techniques/T1543/) | Create/Modify System Process | L1+L2 | Blocked |
| [T1548](https://attack.mitre.org/techniques/T1548/) | Abuse Elevation Control, `sudo` | L1 Pattern | Reviewed |
| [T1027](https://attack.mitre.org/techniques/T1027/) | Obfuscated Files, base64/hex encoded payloads | L1+L2 | Blocked |
| [T1140](https://attack.mitre.org/techniques/T1140/) | Deobfuscate/Decode to shell execution | L1 Pattern | Blocked |
| [T1195.002](https://attack.mitre.org/techniques/T1195/002/) | Supply Chain, malicious package registries | L2 AI | Blocked |
| [T1496](https://attack.mitre.org/techniques/T1496/) | Resource Hijacking, cryptominer installation | L1+L2 | Blocked |
| [T1036](https://attack.mitre.org/techniques/T1036/) | Masquerading, MCP tool poisoning, rug-pulls | L2 AI | Detected |
| [T1204.002](https://attack.mitre.org/techniques/T1204/002/) | User Execution: Malicious File | L1 Pattern | Reviewed |

**Blocked** means the operation is denied outright or requires AI confirmation before it can proceed. **Reviewed** means it gets flagged for AI analysis and Layer 2 makes the call. **Detected** means the suspicious pattern is identified and logged, but may be allowed with low confidence.

## Security Bouncer

The bouncer is a defense-in-depth system that sits between Claude Code and your machine. When Claude runs through mstro (without a human approving each tool call), the bouncer evaluates every single operation before it executes.

The question it's trying to answer isn't "is this command dangerous?" It's "did a bad actor inject this, or did the user actually ask for it?"

### How It Works

```
Tool call from Claude Code
         │
         ▼
┌─────────────────────────────────────────────┐
│  LAYER 1: Pattern Matching  (<5ms)          │
│                                             │
│  Known-safe (npm install, git status, etc.) │
│  ──► ALLOW instantly                        │
│                                             │
│  Catastrophic (rm -rf /, fork bombs, etc.)  │
│  ──► DENY instantly                         │
│                                             │
│  Everything else ──► Layer 2                │
├─────────────────────────────────────────────┤
│  LAYER 2: AI Analysis  (~200-500ms)         │
│                                             │
│  A fast AI model evaluates:                 │
│  • Does this match what the user asked for? │
│  • Does it look like prompt injection?      │
│  • Is data being exfiltrated?               │
│                                             │
│  ──► ALLOW / DENY with confidence score     │
└─────────────────────────────────────────────┘
```

### Layer 1: Pattern Matching

Deterministic, zero-latency classification. No network calls, no AI. Just regex and string matching.

**Auto-allowed** (known-safe operations):
- File reads: `Read`, `Glob`, `Grep`
- Safe bash: `npm install`, `git status`, `cargo build`, `docker build`, `mkdir`, etc.
- Safe writes: files in home directories or `/tmp`
- Side-effect-free tools: `TodoWrite`, `AskUserQuestion`, `ExitPlanMode`

**Auto-denied** (catastrophic threats, never legitimate regardless of context):
- Recursive root/home deletion: `rm -rf /`, `rm -rf ~`
- Fork bombs: `:(){ :|:& };:`
- Disk destruction: `dd if=/dev/zero of=/dev/sda`, `mkfs.ext4 /dev/sda1`
- Obfuscated execution: `eval $(echo ... | base64 -d)`
- Direct device writes: `echo ... > /dev/sda`

**Routed to Layer 2** (ambiguous, needs context):
- `curl | bash` piped execution
- `sudo` commands
- Writes to system paths (`/etc/`, `/usr/bin/`)
- Operations involving shell variable expansion
- Reverse shells, data exfiltration patterns, cloud metadata access

**Guard functions** that prevent evasion of safe-operation matching:
- Chain operators (`&&`, `||`, `;`) in otherwise-safe commands
- Dangerous pipes (`| nc`, `| curl`, `| bash`)
- Shell expansion (`$()`, `` ` ` ``, `${}`) in non-trivial contexts
- Sensitive redirects (`>> ~/.ssh/authorized_keys`, `>> /etc/crontab`)

### Layer 2: AI Analysis

When Layer 1 can't make the call, a fast AI model (Claude Haiku) evaluates the operation in context. It looks at:

- **What the user asked for.** Is this operation related to the conversation?
- **Injection indicators.** Does it look like hidden instructions from a webpage, file, or API response?
- **Data sensitivity.** Is it accessing credentials, keys, or secrets?
- **Destination analysis.** Is data being sent to external servers?

The AI defaults to allow. The user is actively working with Claude, and most operations are legitimate. It only denies when the operation clearly looks like malicious injection.

### Audit Logging

Every bouncer decision gets logged to stderr with structured output:

```
[SecurityAudit] 2026-03-25T12:00:00.000Z DENY [pattern-critical] (1ms)
  Operation: rm -rf /
  Confidence: 99%
  Reasoning: CRITICAL THREAT: Recursive deletion of root filesystem
```

## Local Server Security

Mstro runs a local HTTP/WebSocket server with these protections:

- **Session token authentication.** All API and WebSocket connections require a cryptographically random session token generated at startup using `crypto.randomBytes(32)`.
- **CORS restrictions.** Production mode restricts origins to localhost only.
- **No remote binding.** The server binds to `127.0.0.1` by default. It's not exposed to the network.

### Credential Storage

- Auth tokens are stored at `~/.mstro/credentials.json` with file permissions `0600` (owner read/write only).
- Platform tokens are transmitted via WebSocket message after connection, not in URL parameters.

## Known Limitations

We'd rather be upfront about what the bouncer doesn't cover than let you find out the hard way.

1. **Novel zero-day attacks.** Layer 1 patterns catch known threat signatures. A genuinely new obfuscation technique could slip past pattern matching. Layer 2 AI adds a second line of defense but it's not perfect either.

2. **Content-level injection.** The bouncer evaluates the operation (e.g., "Write: /tmp/config.json"), not the content being written. If someone hides malicious content inside a file write to a safe path, the bouncer won't catch that.

3. **Multi-step attacks.** Each operation gets evaluated on its own. A sequence of individually harmless operations that combine into something dangerous (write a script, then execute it) may not get caught unless the execution step itself matches a pattern.

4. **Local-only scope.** The bouncer protects tool execution during mstro headless sessions. It doesn't protect against attacks on the platform server, web interface, or WebSocket relay. Those have their own separate security controls.

5. **AI confidence thresholds.** Layer 2 defaults to allow for ambiguous operations. If an attacker crafts something that looks enough like normal development work, it may get an allow decision with moderate confidence.

6. **Standalone Claude Code.** The bouncer is only active during mstro sessions. If you run Claude Code directly in your terminal, the bouncer isn't involved and Claude Code's own permission system applies instead.

## Security Best Practices

1. **Keep mstro updated.** Run `npm update -g mstro-app` regularly. Bouncer patterns get updated with each release.
2. **Review bouncer logs.** Check stderr output or `~/.claude/logs/` for blocked operations.
3. **Secure your machine.** mstro inherits your local machine's security posture. Use disk encryption and keep your OS updated.
4. **Use strong authentication.** Secure your mstro.app account with a strong password.
5. **Watch for anomalies.** If you see unexpected `DENY` entries in bouncer logs, investigate where they came from.

## Reporting a Vulnerability

If you find a security issue, please report it responsibly.

**Email:** bravo@mstro.app

**Include:**
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fixes (optional but appreciated)

**What to expect:**
- Acknowledgment within 48 hours
- Initial assessment within 5 business days
- Critical issues addressed within 7 days, others within 30 days
- We ask for 90 days before public disclosure so we have time to patch

**In scope:** auth bypasses, remote code execution, command injection, credential exposure, XSS, privilege escalation, bouncer bypasses (including pattern evasion and AI prompt injection).

**Out of scope:** denial of service, social engineering, physical security, third-party dependency issues (report those upstream), anything requiring physical access to a user's machine.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Security Changelog

| Version | Change |
|---------|--------|
| 0.1.48+ | Added 14 new Layer 1 patterns: reverse shells, cloud IMDS, persistence, encoded payloads, supply chain |
| 0.1.48+ | Added `containsSensitiveRedirect()` guard for `>> authorized_keys` style attacks |
| 0.1.48+ | Expanded `containsDangerousPipe()` to catch `\| bash` and `\| sh` evasion |
| 0.1.48+ | Added statistical reliability testing for Layer 2 (3x runs, 2/3 threshold) |
| 0.1.48+ | MITRE ATT&CK technique mapping across all test suites |
| 0.1.47  | Fixed critical command injection vulnerability (migrated `exec` to `spawn`) |
| 0.1.47  | Added mandatory session token authentication |
| 0.1.47  | Removed sensitive information from `/health` endpoint |
| 0.1.47  | Sanitized error messages with error IDs |

## Telemetry and Privacy

See [PRIVACY.md](./PRIVACY.md) for details on data collection and how to opt out.

Error reports sent to Sentry are sanitized to remove sensitive information. IP addresses are stripped before storage.

---

Copyright (c) 2025-present Mstro, Inc. All rights reserved.
