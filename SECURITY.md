# Security Policy

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly.

### How to Report

**Email:** bravo@mstro.app

**Please include:**
- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact assessment
- Any suggested fixes (optional)

### What to Expect

- **Acknowledgment:** Within 48 hours of your report
- **Initial Assessment:** Within 5 business days
- **Resolution Timeline:** Critical issues addressed within 7 days; others within 30 days
- **Disclosure:** We request 90 days before public disclosure to allow time for patching

### Scope

The following are in scope for security reports:

- Authentication and authorization bypasses
- Remote code execution
- Command injection vulnerabilities
- Credential exposure or leakage
- Cross-site scripting (XSS) in web interface
- Privilege escalation
- Security Bouncer bypasses (including pattern evasion and AI prompt injection)

### Out of Scope

- Denial of service attacks
- Social engineering
- Physical security issues
- Issues in third-party dependencies (report to upstream maintainers)
- Issues requiring physical access to a user's machine

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Security Architecture

### Local Server Security

Mstro runs a local HTTP/WebSocket server with the following protections:

- **Session Token Authentication:** All API and WebSocket connections require a cryptographically random session token generated at startup using `crypto.randomBytes(32)`
- **CORS Restrictions:** Production mode restricts origins to localhost only
- **No Remote Binding:** Server binds to `127.0.0.1` by default, not exposed to network

### Credential Storage

- Auth tokens stored at `~/.mstro/credentials.json` with file permissions `0600` (owner read/write only)
- Platform tokens transmitted via WebSocket message post-connection, not in URL parameters

## Security Bouncer

The Security Bouncer is a defense-in-depth system that protects against prompt injection attacks during mstro sessions. When Claude Code runs headless (without a human approving each tool call), the bouncer evaluates every operation before execution.

**The core question is not "Is this command dangerous?" but "Did a bad actor inject this, or did the user ask for it?"**

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
│  LAYER 2: AI Analysis  (~200–500ms)         │
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

Deterministic, zero-latency classification. No network calls, no AI — pure regex and string matching.

**Auto-allowed** (known-safe operations):
- File reads: `Read`, `Glob`, `Grep`
- Safe bash: `npm install`, `git status`, `cargo build`, `docker build`, `mkdir`, etc.
- Safe writes: files in home directories or `/tmp`
- Side-effect-free tools: `TodoWrite`, `AskUserQuestion`, `ExitPlanMode`

**Auto-denied** (catastrophic threats — never legitimate regardless of context):
- Recursive root/home deletion: `rm -rf /`, `rm -rf ~`
- Fork bombs: `:(){ :|:& };:`
- Disk destruction: `dd if=/dev/zero of=/dev/sda`, `mkfs.ext4 /dev/sda1`
- Obfuscated execution: `eval $(echo ... | base64 -d)`
- Direct device writes: `echo ... > /dev/sda`

**Routed to Layer 2** (ambiguous — needs context):
- `curl | bash` piped execution
- `sudo` commands
- Writes to system paths (`/etc/`, `/usr/bin/`)
- Operations involving shell variable expansion
- Reverse shells, data exfiltration patterns, cloud metadata access

**Guard functions** prevent evasion of safe-operation matching:
- Chain operators (`&&`, `||`, `;`) in otherwise-safe commands
- Dangerous pipes (`| nc`, `| curl`, `| bash`)
- Shell expansion (`$()`, `` ` ` ``, `${}`) in non-trivial contexts
- Sensitive redirects (`>> ~/.ssh/authorized_keys`, `>> /etc/crontab`)

### Layer 2: AI Analysis

When Layer 1 can't decide, a fast AI model (Claude Haiku) evaluates the operation in context:

- **What the user asked for** — is this operation related to the conversation?
- **Injection indicators** — does it look like hidden instructions from a webpage, file, or API response?
- **Data sensitivity** — is it accessing credentials, keys, or secrets?
- **Destination analysis** — is data being sent to external servers?

The AI defaults to **allow** — the user is actively working with Claude, and most operations are legitimate. It only denies when the operation clearly looks like malicious injection.

### Audit Logging

Every bouncer decision is logged to stderr with structured output:

```
[SecurityAudit] 2026-03-25T12:00:00.000Z 🚫 DENY [pattern-critical] (1ms)
  Operation: rm -rf /
  Confidence: 99%
  Reasoning: 🚨 CRITICAL THREAT: Recursive deletion of root filesystem
```

## MITRE ATT&CK Coverage

The bouncer's test suite maps defenses to [MITRE ATT&CK](https://attack.mitre.org/) techniques. This table shows what the bouncer detects and which layer handles it.

| Technique | Name | Layer | Action |
|-----------|------|-------|--------|
| [T1059.004](https://attack.mitre.org/techniques/T1059/004/) | Unix Shell — reverse shells, `curl\|bash` | L1 Pattern | Blocked |
| [T1059.006](https://attack.mitre.org/techniques/T1059/006/) | Python/Perl reverse shells | L1 Pattern | Blocked |
| [T1485](https://attack.mitre.org/techniques/T1485/) | Data Destruction — `rm -rf /` | L1 Pattern | Blocked |
| [T1561.002](https://attack.mitre.org/techniques/T1561/002/) | Disk Wipe — `dd`, `mkfs` | L1 Pattern | Blocked |
| [T1499.004](https://attack.mitre.org/techniques/T1499/004/) | Endpoint DoS — fork bombs | L1 Pattern | Blocked |
| [T1222](https://attack.mitre.org/techniques/T1222/) | File Permissions Modification — `chmod 000 /` | L1 Pattern | Blocked |
| [T1041](https://attack.mitre.org/techniques/T1041/) | Exfiltration Over C2 Channel | L1+L2 | Blocked |
| [T1048](https://attack.mitre.org/techniques/T1048/) | Exfiltration Over Alternative Protocol — `nc`, `scp` | L1+L2 | Blocked |
| [T1567](https://attack.mitre.org/techniques/T1567/) | Exfiltration Over Web Service — webhooks, APIs | L2 AI | Blocked |
| [T1552.005](https://attack.mitre.org/techniques/T1552/005/) | Cloud Instance Metadata (IMDS) — `169.254.169.254` | L1+L2 | Blocked |
| [T1098.004](https://attack.mitre.org/techniques/T1098/004/) | SSH Authorized Keys manipulation | L1 Pattern | Blocked |
| [T1546.004](https://attack.mitre.org/techniques/T1546/004/) | Unix Shell Config Modification — `.bashrc`, `.zshrc` | L1 Pattern | Blocked |
| [T1053.003](https://attack.mitre.org/techniques/T1053/003/) | Cron persistence — `crontab` writes | L1 Pattern | Blocked |
| [T1574.006](https://attack.mitre.org/techniques/T1574/006/) | Dynamic Linker Hijacking — `ld.so.preload` | L1 Pattern | Blocked |
| [T1543](https://attack.mitre.org/techniques/T1543/) | Create/Modify System Process | L1+L2 | Blocked |
| [T1548](https://attack.mitre.org/techniques/T1548/) | Abuse Elevation Control — `sudo` | L1 Pattern | Reviewed |
| [T1027](https://attack.mitre.org/techniques/T1027/) | Obfuscated Files — base64/hex encoded payloads | L1+L2 | Blocked |
| [T1140](https://attack.mitre.org/techniques/T1140/) | Deobfuscate/Decode to shell execution | L1 Pattern | Blocked |
| [T1195.002](https://attack.mitre.org/techniques/T1195/002/) | Supply Chain — malicious package registries | L2 AI | Blocked |
| [T1496](https://attack.mitre.org/techniques/T1496/) | Resource Hijacking — cryptominer installation | L1+L2 | Blocked |
| [T1036](https://attack.mitre.org/techniques/T1036/) | Masquerading — MCP tool poisoning, rug-pulls | L2 AI | Detected |
| [T1204.002](https://attack.mitre.org/techniques/T1204/002/) | User Execution: Malicious File | L1 Pattern | Reviewed |

**Legend:**
- **Blocked** — operation is denied or requires AI confirmation before proceeding
- **Reviewed** — operation is flagged for AI analysis (Layer 2 decides allow/deny)
- **Detected** — suspicious pattern is identified and logged; may allow with low confidence

### Test Coverage

The bouncer is validated by **402 tests** across 4 test suites:

| Suite | Tests | What it covers |
|-------|-------|---------------|
| `security-patterns.test.ts` | 40 | Layer 1 pattern matching, risk classification, sensitive path detection |
| `bouncer-adversarial.test.ts` | 66 | Red team payloads: evasion, chaining, encoding, indirect injection |
| `mcp-injection.test.ts` | 32 | MCP-specific attacks: tool poisoning, cross-origin escalation, rug-pulls |
| `bouncer-layer2.integration.test.ts` | 50 | Real AI analysis with statistical reliability (3 runs per test, 2/3 must pass) |
| `bouncer-integration.test.ts` | 17 | End-to-end review flow, caching, error handling |

Layer 2 integration tests use **statistical reliability testing**: each AI judgment test runs 3 times against real Claude Haiku, requiring at least 2/3 passes. This accounts for LLM non-determinism — the same approach used by academic benchmarks ([AgentDojo](https://arxiv.org/abs/2406.13352), [InjecAgent](https://arxiv.org/abs/2403.02691)).

## Known Limitations

Transparency about what the bouncer does **not** cover:

1. **Novel zero-day attacks.** Layer 1 patterns only catch known threat signatures. Novel obfuscation techniques may bypass pattern matching. Layer 2 AI provides defense-in-depth but is not infallible.

2. **Content-level injection.** The bouncer evaluates the *operation* (e.g., "Write: /tmp/config.json"), not the *content* being written. Malicious content inside a file write to a safe path will not trigger the bouncer.

3. **Multi-step attacks.** Each operation is evaluated independently. A sequence of individually-benign operations that combine into an attack (e.g., write a script, then execute it) may not be caught unless the execution step matches a pattern.

4. **Local-only scope.** The bouncer protects tool execution during mstro headless sessions. It does not protect against attacks on the platform server, web interface, or WebSocket relay — those have separate security controls.

5. **AI confidence thresholds.** Layer 2 defaults to allow for ambiguous operations. An attacker who crafts an operation that looks sufficiently "developer-like" may receive an allow decision with moderate confidence.

6. **Standalone Claude Code.** The bouncer is only active during mstro sessions (headless mode via MCP). If you run Claude Code directly in your terminal, the bouncer is not involved — Claude Code's own permission system applies.

## Security Best Practices for Users

1. **Keep mstro updated:** `npm update -g mstro-app` — bouncer patterns are updated with each release
2. **Review bouncer logs:** Check stderr output or `~/.claude/logs/` for blocked operations
3. **Secure your machine:** mstro inherits your local machine's security posture — use disk encryption, keep OS updated
4. **Use strong authentication:** Secure your mstro.app account with a strong password
5. **Monitor for anomalies:** If you see unexpected `DENY` entries in bouncer logs, investigate the source

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
