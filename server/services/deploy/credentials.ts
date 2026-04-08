// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Deploy Credentials — AES-256-GCM encrypted API key storage.
 *
 * Stores the developer's Anthropic API key at ~/.mstro/deploy-credentials.json,
 * encrypted with a machine-specific secret (hostname + username).
 *
 * The key derivation and storage format must remain compatible with
 * deploy-ai-service.ts which reads credentials at execution time.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

const DEPLOY_CREDENTIALS_PATH = join(homedir(), '.mstro', 'deploy-credentials.json');

// ── Validation rate limiter (max 10 attempts per minute) ────

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const validationTimestamps: number[] = [];

/**
 * Check if a validation attempt is allowed under the rate limit.
 * Returns true if allowed, false if rate-limited.
 */
export function checkValidationRateLimit(): boolean {
  const now = Date.now();
  // Prune timestamps outside the window
  while (validationTimestamps.length > 0 && validationTimestamps[0]! < now - RATE_LIMIT_WINDOW_MS) {
    validationTimestamps.shift();
  }
  if (validationTimestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }
  validationTimestamps.push(now);
  return true;
}

interface StoredDeployCredentials {
  iv: string;
  authTag: string;
  encrypted: string;
  lastFour: string;
}

/**
 * Derive the encryption key from machine-specific secret.
 * Must match the derivation used by deploy-ai-service.ts.
 */
function deriveEncryptionKey(salt: string): Buffer {
  const machineSecret = `${hostname()}${userInfo().username}`;
  return scryptSync(machineSecret, salt, 32);
}

/**
 * Encrypt an API key with AES-256-GCM.
 */
function encryptKey(apiKey: string): StoredDeployCredentials {
  const iv = randomBytes(16);
  const key = deriveEncryptionKey(iv.toString('hex')); // salt = iv hex for simplicity
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(apiKey, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    encrypted,
    lastFour: apiKey.slice(-4),
  };
}

/**
 * Decrypt a stored API key.
 */
function decryptKey(stored: StoredDeployCredentials): string | null {
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
 * Store an encrypted API key to ~/.mstro/deploy-credentials.json.
 * Creates the directory if it doesn't exist. File is mode 0600.
 */
export function storeApiKey(apiKey: string): { lastFour: string } {
  const stored = encryptKey(apiKey);
  const dir = dirname(DEPLOY_CREDENTIALS_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(DEPLOY_CREDENTIALS_PATH, JSON.stringify(stored, null, 2), {
    mode: 0o600,
  });
  return { lastFour: stored.lastFour };
}

/**
 * Read and decrypt the stored API key. Returns null if missing or corrupted.
 */
export function readApiKey(): string | null {
  if (!existsSync(DEPLOY_CREDENTIALS_PATH)) {
    return null;
  }
  try {
    const raw = readFileSync(DEPLOY_CREDENTIALS_PATH, 'utf-8');
    const stored: StoredDeployCredentials = JSON.parse(raw);
    if (!stored.encrypted || !stored.iv || !stored.authTag) {
      return null;
    }
    return decryptKey(stored);
  } catch {
    return null;
  }
}

/**
 * Get API key status without exposing the key.
 * Checks env var first (highest priority), then stored credentials.
 */
export function getApiKeyStatus(): { status: 'valid' | 'missing'; lastFour?: string; source?: 'env' | 'stored' } {
  // 1. Check environment variable (highest priority)
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.trim().length > 0) {
    return {
      status: 'valid',
      lastFour: envKey.trim().slice(-4),
      source: 'env',
    };
  }

  // 2. Check stored credentials
  if (!existsSync(DEPLOY_CREDENTIALS_PATH)) {
    return { status: 'missing' };
  }
  try {
    const raw = readFileSync(DEPLOY_CREDENTIALS_PATH, 'utf-8');
    const stored: StoredDeployCredentials = JSON.parse(raw);
    if (!stored.encrypted || !stored.iv || !stored.authTag) {
      return { status: 'missing' };
    }
    // Verify we can still decrypt (machine identity unchanged)
    const decrypted = decryptKey(stored);
    if (!decrypted) {
      return { status: 'missing' };
    }
    return { status: 'valid', lastFour: stored.lastFour, source: 'stored' };
  } catch {
    return { status: 'missing' };
  }
}

/**
 * Delete stored API key.
 */
export function deleteApiKey(): void {
  if (existsSync(DEPLOY_CREDENTIALS_PATH)) {
    unlinkSync(DEPLOY_CREDENTIALS_PATH);
  }
}

/**
 * Validate an Anthropic API key by calling GET /v1/models.
 * Returns true if the key is valid, false otherwise.
 */
export async function validateAnthropicKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
