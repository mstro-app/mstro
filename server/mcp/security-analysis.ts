// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Security Analysis — Decision logic for routing operations through the bouncer.
 *
 * Uses pattern definitions from security-patterns.ts to classify operations and
 * determine whether they need AI context review.
 */

import {
  CRITICAL_THREATS,
  DEPLOY_PATTERNS,
  matchesPattern,
  NEEDS_AI_REVIEW,
  normalizeOperation,
  SAFE_OPERATIONS,
  SENSITIVE_PATHS,
  type SecurityPattern,
} from './security-patterns.js';

// ── Bash command introspection helpers ─────────────────────────

/** Check if a Bash command contains chain operators that could hide dangerous ops after a safe prefix. */
function containsChainOperators(operation: string): boolean {
  const commandPart = operation.replace(/^Bash:\s*/i, '');
  return /;|&&|\|\||\n/.test(commandPart);
}

/** Check if a Bash command pipes output to known exfiltration/network tools or shells. */
function containsDangerousPipe(operation: string): boolean {
  const commandPart = operation.replace(/^Bash:\s*/i, '');
  return /\|\s*(nc|netcat|ncat|curl|wget|scp|bash|sh)\b/i.test(commandPart);
}

/** Check if a Bash command redirects output to sensitive paths (append or overwrite). */
function containsSensitiveRedirect(operation: string): boolean {
  const commandPart = operation.replace(/^Bash:\s*/i, '');
  return />>?\s*~?\/?.*\/(authorized_keys|\.bashrc|\.bash_profile|\.zshrc|\.profile|\.ssh\/|\.aws\/|\.gnupg\/|ld\.so\.preload|crontab|sudoers)/i.test(commandPart)
    || />>?\s*\/etc\//i.test(commandPart);
}

/** Check if a Bash command contains subshell or backtick expansion (not simple ${VAR}). */
function containsBashExpansion(operation: string): boolean {
  const commandPart = operation.replace(/^Bash:\s*/i, '');
  return /`[^`]+`/.test(commandPart) || /\$\([^)]+\)/.test(commandPart);
}

/** Check if a Bash command contains any form of shell expansion: ${VAR}, $(...), or backticks. */
function containsAnyExpansion(operation: string): boolean {
  const cmd = operation.replace(/^Bash:\s*/i, '');
  return /\$\{[^}]+\}/.test(cmd) || /\$\([^)]+\)/.test(cmd) || /`[^`]+`/.test(cmd);
}

/** Check if expansion is safely used as an argument to a known-safe command prefix.
 *  e.g., "echo ${HOME}" or "cat ${FILE}" — the expansion can't change the command itself. */
function isSafeExpansionUse(operation: string): boolean {
  const cmd = operation.replace(/^Bash:\s*/i, '').trim();
  // If the expansion IS the command (first token), it's never safe
  if (/^(\$\{|\$\(|`)/.test(cmd)) return false;
  // Safe command prefixes where expansion as an argument is harmless
  const safePrefix = /^(echo|printf|cat|ls|pwd|whoami|date|env|printenv|test|true|false)\s/i;
  return safePrefix.test(cmd);
}

// ── Deploy Mode Detection ────────────────────────────────────

/**
 * Check if the bouncer is running in deploy mode.
 * Set by the MCP config when spawned for deploy (board/headless) executions.
 * Deploy mode activates additional security patterns for end-user-driven sessions.
 */
export function isDeployMode(): boolean {
  return process.env.BOUNCER_DEPLOY_MODE === 'true';
}

// ── Bash compound-command safety check ──────────────────────

/** Return true if a Bash command contains compound constructs that could hide dangerous ops. */
function bashHasUnsafeCompoundOps(op: string): boolean {
  return containsChainOperators(op) ||
    containsDangerousPipe(op) ||
    containsBashExpansion(op) ||
    containsSensitiveRedirect(op);
}

/** Return true if a Bash command contains glob or script execution patterns. */
function bashHasConcerningPatterns(op: string): boolean {
  if (/\*\*?/.test(op)) return true;
  if (/^Bash:\s*\.\//.test(op)) return true;
  return false;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Safe rm patterns used for exempting build artifact cleanup from AI review.
 */
const SAFE_RM_PATTERNS = [
  /rm\s+-rf\s+(\.\/)?node_modules($|\s)/i,
  /rm\s+-rf\s+(\.\/)?dist($|\s)/i,
  /rm\s+-rf\s+(\.\/)?build($|\s)/i,
  /rm\s+-rf\s+(\.\/)?\.cache($|\s)/i,
  /rm\s+-rf\s+(\.\/)?\.next($|\s)/i,
  /rm\s+-rf\s+(\.\/)?target($|\s)/i,
  /rm\s+-rf\s+(\.\/)?__pycache__($|\s)/i,
];

/**
 * Determine if operation requires AI context review
 *
 * The philosophy here is:
 * - SENSITIVE_PATHS: Always require review (credentials, system configs)
 * - SAFE_OPERATIONS: No review needed, UNLESS the bash command contains
 *   chain operators, dangerous pipes, or subshell/backtick expansion
 * - CRITICAL_THREATS: Auto-deny, no review (catastrophic operations)
 * - Everything else: AI reviews context to determine if it matches user intent
 */
export function requiresAIReview(operation: string): boolean {
  // Normalize paths to prevent .. traversal bypass
  const op = normalizeOperation(operation);

  // Check sensitive paths BEFORE safe operations — prevents home-dir
  // safe pattern from masking .ssh, .aws, .bashrc, etc.
  if (matchesPattern(op, SENSITIVE_PATHS)) return true;

  // Bash commands with any shell expansion (${VAR}, $(...), backticks) are
  // opaque — the bouncer can't predict what they expand to at runtime.
  // Route to AI review BEFORE checking CRITICAL_THREATS or SAFE_OPERATIONS,
  // UNLESS the command is clearly safe (expansion is just an argument to a
  // known-safe prefix like "echo ${HOME}").
  if (/^Bash:/i.test(op) && containsAnyExpansion(op) && !isSafeExpansionUse(op)) {
    return true;
  }

  // Deploy-specific patterns: when running in deploy mode (end-user driven),
  // additional operations are flagged for AI review. These take precedence
  // over safe operations because deploy context has stricter requirements.
  if (isDeployMode() && matchesPattern(op, DEPLOY_PATTERNS)) {
    return true;
  }

  if (matchesPattern(op, SAFE_OPERATIONS)) {
    // Safe bash commands must not contain chain operators, dangerous pipes,
    // or subshell/backtick expansion that could hide dangerous operations.
    if (/^Bash:/i.test(op) && bashHasUnsafeCompoundOps(op)) return true;
    return false;
  }

  if (matchesPattern(op, CRITICAL_THREATS)) return false;

  if (matchesPattern(op, NEEDS_AI_REVIEW)) {
    return !SAFE_RM_PATTERNS.some(p => p.test(op));
  }

  // Glob patterns and script execution are concerning in Bash commands
  if (/^Bash:/.test(op) && bashHasConcerningPatterns(op)) return true;

  return false;
}

/**
 * Check if operation targets a sensitive path
 * Used to provide additional context to AI reviewer
 */
export function isSensitivePath(operation: string): SecurityPattern | null {
  return matchesPattern(operation, SENSITIVE_PATHS);
}

/**
 * Classify operation risk level for context-aware review
 *
 * Risk levels indicate how much scrutiny the AI should apply:
 * - critical: Catastrophic if wrong (rm -rf /, fork bombs) - auto-deny
 * - high: Needs clear user intent (sudo, sensitive paths, credentials)
 * - medium: Normal file operations - verify matches user request
 * - low: Safe operations - minimal review needed
 */
export function classifyRisk(operation: string): {
  isDestructive: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  reasons: string[];
} {
  // Critical threats are auto-denied
  const criticalThreat = matchesPattern(operation, CRITICAL_THREATS);
  if (criticalThreat) {
    return {
      isDestructive: true,
      riskLevel: 'critical',
      reasons: [criticalThreat.reason || 'Critical threat detected']
    };
  }

  // Sensitive paths need high scrutiny but aren't auto-denied
  const sensitivePath = matchesPattern(operation, SENSITIVE_PATHS);
  if (sensitivePath) {
    return {
      isDestructive: false,
      riskLevel: 'high',
      reasons: [sensitivePath.reason || 'Sensitive path - requires clear user intent']
    };
  }

  // Other patterns that need elevated review
  const elevatedPatterns: SecurityPattern[] = [
    { pattern: /sudo/i, reason: 'Elevated privileges requested' },
    { pattern: /DROP\s+(TABLE|DATABASE)/i, reason: 'Database deletion' },
    { pattern: /chmod\s+777/i, reason: 'Dangerous permissions' },
    { pattern: /(curl|wget).*\|.*(bash|sh)/i, reason: 'Remote code execution' },
    { pattern: /pkill|killall/i, reason: 'Process termination' },
    { pattern: /\|\s*(nc|netcat|ncat)\b/i, reason: 'Data exfiltration via netcat' },
    { pattern: /\bscp\b.*@/i, reason: 'Data exfiltration via SCP' },
    { pattern: /curl\b.*-d\s*@/i, reason: 'Data exfiltration via curl file upload' },
  ];

  for (const pattern of elevatedPatterns) {
    if (pattern.pattern.test(operation)) {
      return {
        isDestructive: true,
        riskLevel: 'high',
        reasons: [pattern.reason || 'Elevated risk operation']
      };
    }
  }

  // Medium risk: only recursive deletions outside safe dirs
  if (/rm\s+-rf/i.test(operation)) {
    if (matchesPattern(operation, SAFE_OPERATIONS)) {
      return { isDestructive: false, riskLevel: 'low', reasons: [] };
    }
    return {
      isDestructive: true,
      riskLevel: 'medium',
      reasons: ['Recursive deletion']
    };
  }

  return {
    isDestructive: false,
    riskLevel: 'low',
    reasons: []
  };
}
