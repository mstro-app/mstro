// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Output Utilities
 *
 * Utilities for processing and parsing Claude CLI output.
 */

/**
 * Extract clean output from Claude response
 */
export function extractCleanOutput(rawOutput: string): string {
  // When using stream-json format, filter out all JSON lines
  // since we already streamed the actual content via callbacks
  const lines = rawOutput.split('\n');
  const cleanLines = lines.filter(line => {
    const trimmed = line.trim();
    // Filter out JSON lines (system, stream_event, assistant, user, result)
    if (trimmed.startsWith('{') && trimmed.includes('"type"')) {
      return false;
    }
    return trimmed.length > 0;
  });

  return cleanLines.join('\n')
    .replace(/\x1b\[[0-9;]*m/g, '') // ANSI color codes
    .replace(/\r\n/g, '\n') // Normalize line endings
    .trim();
}

/**
 * Estimate tokens from output
 */
export function estimateTokensFromOutput(output: string): number {
  return Math.floor(output.length / 4);
}

/**
 * Extract modified files from output (simplified)
 */
export function extractModifiedFiles(output: string): string[] {
  // This is a simplified version. In production, would parse actual file operations
  const filePattern = /(?:wrote|modified|created|edited)\s+(?:file\s+)?['"]?([^\s'"]+\.[a-z0-9]+)['"]?/gi;
  const matches = output.matchAll(filePattern);
  const files = new Set<string>();

  for (const match of matches) {
    files.add(match[1]);
  }

  return Array.from(files);
}

/**
 * Error patterns for detecting Claude Code errors in stderr
 */
export const ERROR_PATTERNS = [
  // Authentication errors - most common user-facing issue
  { pattern: /not logged in|login required|must be authenticated|session.*expired|token.*invalid|token.*expired/i,
    message: 'Claude Code authentication required. Please run "claude login" in your terminal to authenticate.',
    errorCode: 'AUTH_REQUIRED' },
  { pattern: /account.*not.*found|user.*not.*found/i,
    message: 'Claude account not found. Please verify your account at claude.ai.',
    errorCode: 'ACCOUNT_NOT_FOUND' },
  // API/subscription errors
  { pattern: /api key|invalid key|unauthorized|forbidden.*api/i,
    message: 'API key error. Please check your Claude Code configuration.',
    errorCode: 'API_KEY_INVALID' },
  { pattern: /quota exceeded|usage.*limit|billing.*issue|payment.*required|subscription.*expired/i,
    message: 'Usage quota or subscription issue. Please check your account billing at claude.ai.',
    errorCode: 'QUOTA_EXCEEDED' },
  { pattern: /rate limit|too many requests|429|throttl/i,
    message: 'Rate limit exceeded. Please wait a moment before trying again.',
    errorCode: 'RATE_LIMITED' },
  // Network errors
  { pattern: /no internet|network error|connection refused|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|socket hang up/i,
    message: 'Network error. Please check your internet connection.',
    errorCode: 'NETWORK_ERROR' },
  { pattern: /SSL|certificate|TLS|CERT_/i,
    message: 'SSL/TLS certificate error. Please check your network configuration.',
    errorCode: 'SSL_ERROR' },
  // Model/service errors
  { pattern: /model not found|model unavailable|service unavailable|503|502|504/i,
    message: 'Claude service temporarily unavailable. Please try again in a few moments.',
    errorCode: 'SERVICE_UNAVAILABLE' },
  { pattern: /internal server error|500/i,
    message: 'Claude service encountered an internal error. Please try again.',
    errorCode: 'INTERNAL_ERROR' },
  // Context/session errors
  { pattern: /context.*too.*long|context.*limit|token.*limit.*exceeded/i,
    message: 'Context too long. Please start a new session or reduce prompt size.',
    errorCode: 'CONTEXT_TOO_LONG' },
  { pattern: /session.*not.*found|invalid.*session/i,
    message: 'Session not found. Starting a new session may help.',
    errorCode: 'SESSION_NOT_FOUND' },
];

/**
 * Check stderr for known error patterns and return the first match
 */
export function detectErrorInStderr(stderrBuffer: string): { message: string; errorCode: string } | null {
  for (const { pattern, message, errorCode } of ERROR_PATTERNS) {
    if (pattern.test(stderrBuffer)) {
      return { message, errorCode };
    }
  }
  return null;
}
