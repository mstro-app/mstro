// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Deploy AI Service
 *
 * Core service managing Deploy AI execution. Every execution is gated on the
 * developer's Anthropic API key — subscription (OAuth) auth is rejected.
 *
 * The API key is injected into each spawned Claude Code process via `extraEnv`
 * and is never logged or sent to the platform server.
 */

import { createDecipheriv, scryptSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { HeadlessRunner } from '../../cli/headless/runner.js';
import type { HeadlessConfig, SessionResult, ToolUseEvent } from '../../cli/headless/types.js';
import { getCredentials } from '../platform-credentials.js';

// ========== Credential Detection ==========

/**
 * Credential types returned by readOwnerApiCredential().
 *
 * - 'api-key': Developer has an explicit Anthropic API key (env var or stored).
 *              This is the ONLY type that allows Deploy execution.
 * - 'oauth':   Developer is authenticated via Claude subscription (platform creds
 *              exist but no API key). Deploy rejects this.
 * - null:      No authentication found at all. Deploy rejects this.
 */
export type OwnerCredentialResult =
  | { type: 'api-key'; key: string; source: 'env' | 'stored' }
  | { type: 'oauth' }
  | null;

const DEPLOY_CREDENTIALS_PATH = join(homedir(), '.mstro', 'deploy-credentials.json');

interface StoredDeployCredentials {
  iv: string;
  authTag: string;
  encrypted: string;
  lastFour: string;
}

/**
 * Derive the encryption key from machine-specific secret.
 * Must match the derivation used by IS-026 (credential storage).
 */
function deriveEncryptionKey(salt: string): Buffer {
  const machineSecret = `${hostname()}${userInfo().username}`;
  return scryptSync(machineSecret, salt, 32);
}

/**
 * Decrypt a stored API key from ~/.mstro/deploy-credentials.json.
 */
function decryptStoredKey(stored: StoredDeployCredentials): string | null {
  try {
    const iv = Buffer.from(stored.iv, 'hex');
    const authTag = Buffer.from(stored.authTag, 'hex');
    const key = deriveEncryptionKey(stored.iv); // salt = iv for simplicity
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(stored.encrypted, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return decrypted;
  } catch {
    return null;
  }
}

/**
 * Read the owner's API credential. Resolution order:
 *   1. ANTHROPIC_API_KEY environment variable
 *   2. Locally encrypted storage (~/.mstro/deploy-credentials.json)
 *   3. Platform credentials exist (OAuth/subscription) -> { type: 'oauth' }
 *   4. Nothing -> null
 *
 * Deploy ONLY proceeds if result.type === 'api-key'.
 */
export function readOwnerApiCredential(): OwnerCredentialResult {
  // 1. Check environment variable (highest priority)
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.trim().length > 0) {
    return { type: 'api-key', key: envKey.trim(), source: 'env' };
  }

  // 2. Check locally encrypted storage
  if (existsSync(DEPLOY_CREDENTIALS_PATH)) {
    try {
      const raw = readFileSync(DEPLOY_CREDENTIALS_PATH, 'utf-8');
      const stored: StoredDeployCredentials = JSON.parse(raw);
      if (stored.encrypted && stored.iv && stored.authTag) {
        const decrypted = decryptStoredKey(stored);
        if (decrypted) {
          return { type: 'api-key', key: decrypted, source: 'stored' };
        }
      }
    } catch {
      // Corrupted credentials file — fall through
    }
  }

  // 3. Platform credentials exist -> user has subscription (OAuth) but no API key
  const platformCreds = getCredentials();
  if (platformCreds) {
    return { type: 'oauth' };
  }

  // 4. No authentication at all
  return null;
}

// ========== Deploy Error ==========

const DEPLOY_API_KEY_ERROR =
  'Deploy requires an Anthropic API key. Add your key in Deploy \u2192 AI Config or set ANTHROPIC_API_KEY in your environment.';

export class DeployApiKeyError extends Error {
  constructor() {
    super(DEPLOY_API_KEY_ERROR);
    this.name = 'DeployApiKeyError';
  }
}

// ========== Deploy Session Types ==========

export interface DeployExecutionOptions {
  /** Unique identifier for this deployment */
  deploymentId: string;
  /** The prompt/task to execute */
  prompt: string;
  /** Working directory for the Claude Code instance */
  workingDir: string;
  /** Optional model override */
  model?: string;
  /** Callback for streaming output */
  outputCallback?: (text: string) => void;
  /** Callback for thinking output */
  thinkingCallback?: (text: string) => void;
  /** Callback for tool use events */
  toolUseCallback?: (event: ToolUseEvent) => void;
  /** Tools to disallow in this session */
  disallowedTools?: string[];
}

export interface DeploySession {
  id: string;
  deploymentId: string;
  runner: HeadlessRunner;
  startedAt: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface DeployExecutionResult {
  sessionId: string;
  completed: boolean;
  error?: string;
  totalTokens: number;
  assistantResponse?: string;
  durationMs: number;
}

// ========== Deploy AI Service (Singleton) ==========

const MAX_CONCURRENT_SESSIONS_PER_DEPLOYMENT = 3;
const MAX_TOTAL_SESSIONS = 10;

export class DeployAiService extends EventEmitter {
  private static instance: DeployAiService | null = null;
  private sessions: Map<string, DeploySession> = new Map();

  private constructor() {
    super();
  }

  static getInstance(): DeployAiService {
    if (!DeployAiService.instance) {
      DeployAiService.instance = new DeployAiService();
    }
    return DeployAiService.instance;
  }

  /**
   * Execute a deploy AI task. Hard-gates on API key authentication.
   *
   * @throws DeployApiKeyError if credential type is 'oauth' or null
   */
  async execute(options: DeployExecutionOptions): Promise<DeployExecutionResult> {
    const startTime = Date.now();
    const sessionId = `deploy-${options.deploymentId}-${Date.now()}`;

    // ===== CRITICAL: API key auth enforcement =====
    const credential = readOwnerApiCredential();

    if (!credential || credential.type !== 'api-key') {
      throw new DeployApiKeyError();
    }

    const deployApiKey = credential.key;
    // ===== END auth gate =====

    // Enforce concurrency limits
    this.enforceSessionLimits(options.deploymentId);

    // Create isolated HeadlessRunner with the developer's API key injected.
    // deployMode activates additional Security Bouncer patterns for end-user-driven sessions.
    const runnerConfig: Partial<HeadlessConfig> = {
      workingDir: options.workingDir,
      directPrompt: options.prompt,
      model: options.model,
      outputCallback: options.outputCallback,
      thinkingCallback: options.thinkingCallback,
      toolUseCallback: options.toolUseCallback,
      disallowedTools: options.disallowedTools,
      extraEnv: { ANTHROPIC_API_KEY: deployApiKey },
      verbose: false,
      deployMode: true,
    };

    const runner = new HeadlessRunner(runnerConfig);

    const session: DeploySession = {
      id: sessionId,
      deploymentId: options.deploymentId,
      runner,
      startedAt: startTime,
      status: 'running',
    };

    this.sessions.set(sessionId, session);
    this.emit('sessionStart', { sessionId, deploymentId: options.deploymentId });

    try {
      const result: SessionResult = await runner.run();

      session.status = result.completed ? 'completed' : 'failed';

      const executionResult: DeployExecutionResult = {
        sessionId,
        completed: result.completed,
        error: result.error,
        totalTokens: result.totalTokens,
        assistantResponse: result.assistantResponse,
        durationMs: Date.now() - startTime,
      };

      this.emit('sessionComplete', {
        sessionId,
        deploymentId: options.deploymentId,
        completed: result.completed,
        durationMs: executionResult.durationMs,
      });

      return executionResult;
    } catch (error: unknown) {
      session.status = 'failed';
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.emit('sessionError', {
        sessionId,
        deploymentId: options.deploymentId,
        error: errorMessage,
      });

      return {
        sessionId,
        completed: false,
        error: errorMessage,
        totalTokens: 0,
        durationMs: Date.now() - startTime,
      };
    } finally {
      // Cleanup: remove from active sessions after a brief delay
      // to allow status queries on recently-completed sessions
      setTimeout(() => {
        this.sessions.delete(sessionId);
      }, 30_000);
    }
  }

  /**
   * Stop a specific deploy session.
   */
  stopSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'running') {
      return false;
    }

    session.runner.cleanup();
    session.status = 'cancelled';

    this.emit('sessionCancelled', {
      sessionId,
      deploymentId: session.deploymentId,
    });

    return true;
  }

  /**
   * Stop all sessions for a specific deployment.
   */
  stopDeployment(deploymentId: string): number {
    let stopped = 0;
    for (const [, session] of this.sessions) {
      if (session.deploymentId === deploymentId && session.status === 'running') {
        session.runner.cleanup();
        session.status = 'cancelled';
        stopped++;
      }
    }
    return stopped;
  }

  /**
   * Get the current status of a deploy session.
   */
  getSession(sessionId: string): DeploySession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active sessions for a deployment.
   */
  getDeploymentSessions(deploymentId: string): DeploySession[] {
    const result: DeploySession[] = [];
    for (const session of this.sessions.values()) {
      if (session.deploymentId === deploymentId) {
        result.push(session);
      }
    }
    return result;
  }

  /**
   * Count active (running) sessions for a deployment.
   */
  getActiveSessionCount(deploymentId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.deploymentId === deploymentId && session.status === 'running') {
        count++;
      }
    }
    return count;
  }

  /**
   * Cleanup all sessions — call on process exit.
   */
  cleanup(): void {
    for (const session of this.sessions.values()) {
      if (session.status === 'running') {
        session.runner.cleanup();
        session.status = 'cancelled';
      }
    }
    this.sessions.clear();
  }

  /**
   * Sweep completed/failed sessions that have exceeded the retention window.
   */
  sweepStaleSessions(): number {
    let swept = 0;
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.status !== 'running' && now - session.startedAt > 60_000) {
        this.sessions.delete(sessionId);
        swept++;
      }
    }
    return swept;
  }

  // ========== Internal ==========

  private enforceSessionLimits(deploymentId: string): void {
    const activeForDeployment = this.getActiveSessionCount(deploymentId);
    if (activeForDeployment >= MAX_CONCURRENT_SESSIONS_PER_DEPLOYMENT) {
      throw new Error(
        `Deployment ${deploymentId} has reached the maximum of ${MAX_CONCURRENT_SESSIONS_PER_DEPLOYMENT} concurrent sessions.`
      );
    }

    let totalActive = 0;
    for (const session of this.sessions.values()) {
      if (session.status === 'running') totalActive++;
    }
    if (totalActive >= MAX_TOTAL_SESSIONS) {
      throw new Error(
        `Maximum total concurrent deploy sessions (${MAX_TOTAL_SESSIONS}) reached. Wait for existing sessions to complete.`
      );
    }
  }
}
