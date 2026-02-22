// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Sandbox Utilities
 *
 * Environment sanitization for sandboxed shared sessions.
 * Used by both PTY manager (terminal) and Claude invoker (prompts)
 * to restrict shared users to the project directory.
 */

/** Env var prefixes that may contain secrets or grant access outside the project */
const BLOCKED_PREFIXES = [
  'AWS_',
  'GITHUB_',
  'GH_',
  'NPM_',
  'DOCKER_',
  'SSH_',
  'GPG_',
  'AZURE_',
  'GCP_',
  'GOOGLE_',
  'OPENAI_',
  'ANTHROPIC_',
  'STRIPE_',
  'TWILIO_',
  'SENDGRID_',
  'DATADOG_',
  'SENTRY_',
  'SLACK_',
  'DISCORD_',
];

/** Specific env vars that may contain secrets or sensitive paths */
const BLOCKED_KEYS = new Set([
  'HISTFILE',
  'LESSHISTFILE',
  'MYSQL_PWD',
  'PGPASSWORD',
  'PGPASSFILE',
  'REDIS_URL',
  'DATABASE_URL',
  'MONGO_URI',
  'MONGODB_URI',
  'SECRET_KEY',
  'API_KEY',
  'API_SECRET',
  'ACCESS_TOKEN',
  'REFRESH_TOKEN',
  'PRIVATE_KEY',
  'JWT_SECRET',
]);

/**
 * Create a sanitized environment for sandboxed execution.
 * Strips sensitive env vars and sets HOME to the project directory.
 */
export function sanitizeEnvForSandbox(
  env: NodeJS.ProcessEnv,
  workingDir: string
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (BLOCKED_KEYS.has(key)) continue;
    if (BLOCKED_PREFIXES.some(p => key.startsWith(p))) continue;
    result[key] = value;
  }

  // Override HOME to project directory so `cd ~` stays sandboxed
  result.HOME = workingDir;
  // Marker so scripts can detect sandboxed execution
  result.MSTRO_SANDBOXED = '1';

  return result;
}
