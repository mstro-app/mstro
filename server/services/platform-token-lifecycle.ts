// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Token Lifecycle — refresh, verify, and auth-expired signaling for the
 * platform device token. Extracted from PlatformConnection so the relay
 * lifecycle (sockets, reconnect, heartbeat) and the auth lifecycle (token
 * refresh, verify, expired-signal) can be reasoned about apart. The token
 * lifecycle has its own clock (24h periodic check), its own remote endpoints
 * (/refresh, /verify), and its own failure modes (revocation vs. transient
 * network error) — none of which need to be in PlatformConnection.
 */

import {
  getCredentials,
  shouldRefreshToken,
  updateCredentials,
} from './platform-credentials.js'

const PERIODIC_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface TokenLifecycleDeps {
  /** Platform base URL — used to compose /api/auth/device/{refresh,verify} */
  platformUrl: string
  /** Send a message upstream over the live relay socket (no-op if closed). */
  send: (message: unknown) => void
  /** Read the current relay connection ID at the moment auth-expired fires. */
  getConnectionId: () => string | null
}

export class TokenLifecycle {
  private intervalHandle: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: TokenLifecycleDeps) {}

  /**
   * Refresh the device token if it's older than the refresh interval.
   * Returns `true` if the token is (still) valid after this call, `false`
   * if refresh was attempted and rejected with an auth error — in which
   * case the caller should surface an auth-expired signal to the web
   * rather than silently reusing a dead token.
   */
  async maybeRefresh(): Promise<boolean> {
    const creds = getCredentials()
    if (!creds) return false
    if (!shouldRefreshToken(creds)) return true

    try {
      const response = await fetch(`${this.deps.platformUrl}/api/auth/device/refresh`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${creds.token}`,
          'Content-Type': 'application/json'
        }
      })

      if (response.ok) {
        const data = await response.json() as { accessToken: string }
        updateCredentials({
          token: data.accessToken,
          lastRefreshedAt: new Date().toISOString()
        })
        return true
      }
      if (response.status === 401 || response.status === 403) {
        console.warn(`[Platform] Token refresh failed — auth is expired (${response.status}). Run \`mstro login --force\`.`)
        this.notifyAuthExpired()
        return false
      }
      console.warn(`[Platform] Token refresh failed with status ${response.status}, will retry later`)
      return true
    } catch (err) {
      console.warn('[Platform] Token refresh error:', err)
      return true
    }
  }

  /**
   * Verify the current token against the platform. A rejection (401/403)
   * means the token is permanently invalid (revoked, signing-key rotation,
   * account deleted); the caller should stop looping reconnects and tell
   * the user to run `mstro login --force`.
   *
   * Returns `true` when the token is valid or the verification endpoint
   * is unreachable (we prefer false negatives to false positives — a
   * network blip shouldn't force a re-login).
   */
  async verify(): Promise<boolean> {
    const creds = getCredentials()
    if (!creds?.token) return false
    try {
      const response = await fetch(`${this.deps.platformUrl}/api/auth/device/verify`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${creds.token}` },
      })
      if (response.status === 401 || response.status === 403) {
        console.warn(`[Platform] Token verify rejected (${response.status}) — auth is expired.`)
        return false
      }
      return true
    } catch {
      // Network error: treat as "probably valid" so a flaky connection
      // doesn't force users to re-login. The WebSocket open itself will
      // catch a truly bad token via the 4001 path.
      return true
    }
  }

  /**
   * Surface an auth-expired condition to any paired web clients.
   *
   * Two cooperating paths deliver this signal — either alone is enough,
   * both together cover every timing edge:
   *
   *   1. **CLI-initiated (this method):** we detected a 401 from the
   *      `/refresh` or `/verify` endpoint *while the relay socket is
   *      still open*. The injected `send` pushes the message upstream so
   *      the server relays it to paired webs before the CLI closes.
   *      A no-op if the socket is already closed.
   *
   *   2. **Server-initiated:** when the platform closes a CLI socket
   *      with 4001 or 4008, `handleAuthClose` in `clientHandlers.ts`
   *      broadcasts the same `clientAuthExpired` to paired webs. This
   *      covers cases where the CLI never had a chance to detect the
   *      rejection itself (e.g. token revoked while the socket was idle,
   *      server-side token rotation).
   *
   * IMPORTANT: never route this through PlatformConnection's
   * `onRelayedMessage` callback — that callback feeds INCOMING web→CLI
   * requests into the local handler, which would treat
   * `clientAuthExpired` as an unknown inbound request.
   */
  notifyAuthExpired(): void {
    this.deps.send({
      type: 'clientAuthExpired',
      data: {
        connectionId: this.deps.getConnectionId(),
        message: 'The CLI\'s device token is invalid — run `mstro login --force` on the machine.',
      },
    })
  }

  /**
   * Best-effort token verification, fired in parallel with the socket
   * open so a slow verify endpoint never delays reconnect.
   *
   * Only runs when the token is stale enough that we'd be about to
   * refresh anyway — keeps the hot path free of an extra network call.
   * A truly-revoked token that slips past this check still hits 4001
   * on the WebSocket, which also triggers `notifyAuthExpired`.
   */
  maybeVerifyInParallel(): void {
    const creds = getCredentials()
    if (!creds || !shouldRefreshToken(creds)) return
    this.verify().then((valid) => {
      if (!valid) this.notifyAuthExpired()
    }).catch(() => { /* network error — rely on 4001 close path */ })
  }

  startPeriodicCheck(): void {
    this.intervalHandle = setInterval(() => {
      this.maybeRefresh()
    }, PERIODIC_CHECK_INTERVAL_MS)
  }

  stopPeriodicCheck(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }
}
