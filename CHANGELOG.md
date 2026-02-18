# Changelog

## 0.1.47 (2026-02-01)

- Fix critical command injection vulnerability in git service (execFile instead of exec)
- Add mandatory session token authentication for local server API and WebSocket
- Move platform auth token from URL query params to post-connection message
- Remove sensitive information from /health endpoint
- Sanitize error messages with error IDs for server-side tracking
- Fix CORS configuration for production
- Fix require('fs') mixed with ESM imports in handler.ts
- Remove Bun dependency from postinstall
- Add TypeScript build pipeline and prepublishOnly safety net
- Add comprehensive test suite (git, auth, health, WebSocket)
- Add release script for version bumping and changelog generation
