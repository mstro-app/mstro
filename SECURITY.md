# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

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
- Security Bouncer bypasses

### Out of Scope

- Denial of service attacks
- Social engineering
- Physical security issues
- Issues in third-party dependencies (report to upstream maintainers)
- Issues requiring physical access to a user's machine

## Security Architecture

### Local Server Security

Mstro runs a local HTTP/WebSocket server with the following protections:

- **Session Token Authentication:** All API and WebSocket connections require a cryptographically random session token generated at startup using `crypto.randomBytes(32)`
- **CORS Restrictions:** Production mode restricts origins to localhost only
- **No Remote Binding:** Server binds to `127.0.0.1` by default, not exposed to network

### Credential Storage

- Auth tokens stored at `~/.mstro/credentials.json` with file permissions `0600` (owner read/write only)
- Platform tokens transmitted via WebSocket message post-connection, not in URL parameters

### Security Bouncer

The Security Bouncer provides defense-in-depth for Claude Code tool execution:

1. **Pattern Matching Layer:** Instant blocking of known-dangerous operations (fork bombs, destructive commands, disk overwrites)
2. **AI Analysis Layer:** Ambiguous operations reviewed by AI for prompt injection and malicious intent

Audit logs are written to `~/.claude/logs/bouncer.log`.

### Recent Security Improvements (v0.1.47)

- Fixed critical command injection vulnerability (migrated from `exec` to `spawn` with argument arrays)
- Added mandatory session token authentication
- Removed sensitive information from `/health` endpoint
- Sanitized error messages with error IDs for server-side tracking

## Security Best Practices for Users

1. **Keep mstro updated:** Run `npm update -g mstro` regularly
2. **Enable the Security Bouncer:** Accept the setup prompt on first run
3. **Review bouncer logs:** Check `~/.claude/logs/bouncer.log` for blocked operations
4. **Secure your machine:** mstro inherits your local machine's security posture
5. **Use strong authentication:** Secure your mstro.app account with a strong password

## Telemetry and Privacy

See [PRIVACY.md](./PRIVACY.md) for details on data collection and how to opt out.

Error reports sent to Sentry are sanitized to remove sensitive information. IP addresses are stripped before storage.

---

Copyright (c) 2025-present Mstro, Inc. All rights reserved.
