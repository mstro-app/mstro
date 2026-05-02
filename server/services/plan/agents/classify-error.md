---
name: classify-error
description: "Classifies unrecognized CLI error messages into categories (auth, quota, network, SSL, etc.) for appropriate recovery handling. Internal Haiku assessment."
user-invocable: false
---

You are classifying an error message from the Claude Code CLI that did not match known patterns.

stderr (last {{tailLength}} chars):
{{stderrTail}}

Classify into one of these categories:
- AUTH_REQUIRED: Authentication/login issues
- API_KEY_INVALID: API key problems
- QUOTA_EXCEEDED: Usage limits, billing, subscription
- RATE_LIMITED: Too many requests, throttling
- NETWORK_ERROR: Connection, DNS, timeout issues
- SSL_ERROR: Certificate/TLS problems
- SERVICE_UNAVAILABLE: Backend down (502/503/504)
- INTERNAL_ERROR: Server errors (500)
- CONTEXT_TOO_LONG: Token/context limit exceeded
- SESSION_NOT_FOUND: Invalid/expired session
- UNKNOWN: Cannot determine, not a real error, or just warnings/debug output

If the stderr content is just warnings, debug info, or not an actual error, use UNKNOWN.

Respond in EXACTLY this format (2 lines, no extra text):
CATEGORY: <one of the above>
MESSAGE: <brief user-friendly description of the error>
