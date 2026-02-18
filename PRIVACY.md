# Mstro Privacy Policy

**Effective Date:** February 2026

## Overview

Mstro, Inc. ("we", "us", "our") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard information when you use the Mstro CLI and related services.

## Information We Collect

### 1. Account Information
When you create an account, we collect:
- Email address
- Name (optional)
- Device identifiers (for authentication)

### 2. Telemetry Data (Anonymous)
By default, Mstro collects anonymous telemetry to improve the software:

**Error Reporting (via Sentry):**
- Stack traces and error messages
- Mstro version and environment
- Operating system and architecture
- Node.js version

**Usage Analytics (via PostHog):**
- Feature usage patterns
- Session duration
- Command frequency

**What we DO NOT collect:**
- File contents or source code
- API keys or credentials
- Personal identifying information in error reports
- IP addresses (stripped before storage)

### 3. Session Data
When using mstro.app:
- Orchestra configurations
- Session metadata
- Connection timestamps

## How to Opt Out of Telemetry

You can disable all telemetry at any time:

```bash
mstro telemetry off

# Or via environment variable
export MSTRO_TELEMETRY=0
```

When telemetry is disabled:
- No error reports are sent to Sentry
- No usage analytics are sent to PostHog
- Core functionality remains unchanged

## How We Use Your Information

We use collected information to:
- Provide and maintain the Mstro service
- Identify and fix bugs and crashes
- Improve software performance and features
- Communicate service updates and changes
- Ensure security and prevent abuse

## Data Sharing

We do not sell your personal information. We may share data with:

- **Service Providers:** Third-party services that help operate Mstro (e.g., Sentry for error tracking, PostHog for analytics)
- **Legal Requirements:** When required by law or to protect our rights
- **Business Transfers:** In connection with a merger or acquisition

## Data Retention

- **Account Data:** Retained while your account is active
- **Telemetry Data:** Retained for up to 90 days
- **Error Reports:** Retained for up to 30 days

## Data Security

We implement appropriate security measures including:
- Encryption in transit (TLS/HTTPS)
- Secure credential storage (chmod 600)
- Regular security audits
- Minimal data collection principles

## Your Rights

Depending on your jurisdiction, you may have rights to:
- Access your personal data
- Correct inaccurate data
- Delete your data
- Export your data
- Opt out of data collection

To exercise these rights, contact us at the information below.

## Children's Privacy

Mstro is not intended for users under 13 years of age. We do not knowingly collect information from children.

## International Users

Mstro is operated from the United States. By using the service, you consent to the transfer of your information to the United States.

## Changes to This Policy

We may update this Privacy Policy periodically. We will notify users of significant changes through the CLI or our website.

## Open Source

Mstro CLI is open source under the MIT License. You can review the code at:
https://github.com/mstro-app/mstro

## Contact Us

For privacy-related questions or concerns:
- Website: https://mstro.app
- GitHub: https://github.com/mstro-app/mstro/issues

---

Copyright (c) 2025-present Mstro, Inc. All rights reserved.
