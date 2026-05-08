// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Runtime Info
 *
 * Holds process-wide singletons that are known after server startup but
 * needed by code paths (e.g. the headless runner / MCP config generator)
 * that don't have a natural reference to the Hono app or instance registry.
 *
 * Specifically: the port the CLI server is bound to. We need it so the MCP
 * bouncer subprocess can call back into us via HTTP for AskUserQuestion.
 *
 * Set once at server startup (see `server/index.ts`).
 */

let currentPort: number | undefined;

export function setCurrentMstroPort(port: number): void {
  currentPort = port;
}

export function getCurrentMstroPort(): number | undefined {
  return currentPort;
}
