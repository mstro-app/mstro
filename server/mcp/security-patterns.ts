// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Security Patterns - Single Source of Truth
 *
 * Consolidated pattern definitions for fast-path security checks.
 * All pattern-based security decisions use this module to avoid duplication.
 *
 * PHILOSOPHY:
 * - Most operations should be evaluated by CONTEXT, not by path or extension
 * - Only truly catastrophic operations (rm -rf /, fork bombs) are auto-denied
 * - Sensitive operations (system paths, credentials) get AI review with context
 * - The question is: "Does this operation make sense given user intent?"
 */

import { resolve } from 'node:path';

export interface SecurityPattern {
  pattern: RegExp;
  reason?: string;
}

/**
 * Sensitive paths that require AI context review
 * These aren't auto-denied - they need context analysis to determine intent
 */
export const SENSITIVE_PATHS: SecurityPattern[] = [
  // System directories - might be legitimate (e.g., user asked to configure something)
  { pattern: /^(Write|Edit):\s*\/etc\//i, reason: 'System configuration - verify user intent' },
  { pattern: /^(Write|Edit):\s*\/(bin|sbin|usr\/bin|usr\/sbin)\//i, reason: 'System binaries - verify user intent' },
  { pattern: /^(Write|Edit):\s*\/boot\//i, reason: 'Boot directory - verify user intent' },
  { pattern: /^(Write|Edit):\s*\/root\//i, reason: 'Root home - verify user intent' },
  { pattern: /^(Write|Edit):\s*\/System\//i, reason: 'macOS system - verify user intent' },
  { pattern: /^(Write|Edit):\s*\/Library\/(LaunchDaemons|LaunchAgents)\//i, reason: 'macOS launch services - verify user intent' },

  // Credential/security files - high sensitivity, need clear user intent
  { pattern: /^(Write|Edit):\s*.*\/\.ssh\//i, reason: 'SSH configuration - verify user intent' },
  { pattern: /^(Write|Edit):\s*.*\/\.gnupg\//i, reason: 'GPG keys - verify user intent' },
  { pattern: /^(Write|Edit):\s*.*\/\.aws\/(credentials|config)/i, reason: 'AWS credentials - verify user intent' },
  { pattern: /^(Write|Edit):\s*.*\/(\.env|\.env\.local|\.env\.production)$/i, reason: 'Environment secrets - verify user intent' },

  // Shell profiles - common legitimate edits but also attack vector
  { pattern: /^(Write|Edit):\s*.*\/(\.bash_profile|\.bashrc|\.zshrc|\.profile|\.zprofile)$/i, reason: 'Shell profile - verify user intent' },
];

/**
 * Critical threats - auto-deny regardless of context
 *
 * These are NOT about "dangerous commands" but about commands that:
 * 1. Are NEVER legitimate in any dev workflow
 * 2. Have catastrophic, irreversible consequences
 * 3. The cost of false positive (blocking) is negligible
 *
 * Note: Most "dangerous" commands (curl|bash, rm -rf, sudo) go to Haiku
 * for context review. Only truly never-legitimate commands are here.
 */
export const CRITICAL_THREATS: SecurityPattern[] = [
  // Deleting root or home - no legitimate dev task requires this
  // If user really wants this, they can run it manually outside Claude
  {
    pattern: /rm\s+-rf\s+(\/|~)($|\s)/i,
    reason: 'Deleting root (/) or home (~) directory is never a legitimate dev task'
  },
  {
    pattern: /:\(\)\{.*\}|:\(\)\{.*:\|:/i,
    reason: 'Fork bomb detected - would cause system resource exhaustion'
  },
  {
    pattern: /dd\s+if=\/dev\/zero\s+of=\/dev\/sd/i,
    reason: 'Attempting to overwrite disk device - would destroy data'
  },
  {
    pattern: /mkfs\./i,
    reason: 'Attempting to format filesystem - would destroy all data'
  },
  {
    pattern: /eval.*\$\(.*base64.*\)/i,
    reason: 'Obfuscated code execution via base64 - common malware technique'
  },
  {
    pattern: />\s*\/dev\/sd[a-z]/i,
    reason: 'Direct write to disk device - would corrupt filesystem'
  },
  {
    pattern: /chmod\s+000\s+\//i,
    reason: 'Attempting to make system directories inaccessible'
  },
  // Reverse shells - never legitimate in a dev workflow
  {
    pattern: /\/dev\/tcp\//i,
    reason: 'Reverse shell via /dev/tcp - classic backdoor technique'
  },
  {
    pattern: /\bnc\b.*-[elp].*\b\d+\b/i,
    reason: 'Netcat listener/reverse shell - common backdoor technique'
  },
  // NOTE: curl|bash is NOT here - it goes to Haiku for context review
  // The question is "did a bad actor inject this?" not "is curl|bash dangerous?"
];

/**
 * Safe operations that can be immediately allowed (confidence: 95%)
 * These are read-only or obviously safe operations that don't need context review
 */
export const SAFE_OPERATIONS: SecurityPattern[] = [
  // Read operations are always safe - no side effects
  { pattern: /^Read:/i },
  { pattern: /^Glob:/i },
  { pattern: /^Grep:/i },

  // Write/Edit to user home directory or subdirectories - user requested, allow it
  // Excludes system paths which go through critical threats check
  { pattern: /^Write:\s*\/Users\/[^/]+\//i },  // macOS home dirs - Write
  { pattern: /^Edit:\s*\/Users\/[^/]+\//i },   // macOS home dirs - Edit
  { pattern: /^Write:\s*\/home\/[^/]+\//i },   // Linux home dirs - Write
  { pattern: /^Edit:\s*\/home\/[^/]+\//i },    // Linux home dirs - Edit

  // Safe bash commands - common development workflows
  // NOTE: curl|bash goes to Haiku for context review, not auto-allowed
  { pattern: /^Bash:\s*(npm|yarn|pnpm|bun)\s+(install|ci|run|test|build|dev|start|lint|format)($|\s)/i },
  { pattern: /^Bash:\s*git\s+(status|log|diff|show|branch|clone|pull|fetch|add|stash|checkout)($|\s)/i },
  { pattern: /^Bash:\s*docker\s+(build|run|ps|logs|compose|images)($|\s)/i },
  { pattern: /^Bash:\s*(pytest|cargo\s+(build|test|run|check)|go\s+(build|test|run|mod))($|\s)/i },
  { pattern: /^Bash:\s*(mkdir|cd|ls|pwd|cat|head|tail|wc|sort|uniq|grep|find|which|echo|env)($|\s)/i },

  // Cleanup of build artifacts - always safe, commonly requested
  { pattern: /^Bash:\s*rm\s+-rf\s+(\.\/)?node_modules($|\s)/i },
  { pattern: /^Bash:\s*rm\s+-rf\s+(\.\/)?dist($|\s)/i },
  { pattern: /^Bash:\s*rm\s+-rf\s+(\.\/)?build($|\s)/i },
  { pattern: /^Bash:\s*rm\s+-rf\s+(\.\/)?\.cache($|\s)/i },
  { pattern: /^Bash:\s*rm\s+-rf\s+(\.\/)?\.next($|\s)/i },
  { pattern: /^Bash:\s*rm\s+-rf\s+(\.\/)?target($|\s)/i },
  { pattern: /^Bash:\s*rm\s+-rf\s+(\.\/)?__pycache__($|\s)/i },

  // Write/Edit to temp directories - ephemeral, low risk
  { pattern: /^(Write|Edit):\s*\/tmp\//i },
  { pattern: /^(Write|Edit):\s*\/var\/tmp\//i },

  // Side-effect-free tools - no dangerous operations possible
  { pattern: /^(ExitPlanMode|EnterPlanMode|TodoWrite|AskUserQuestion):/i },
];

/**
 * Patterns that trigger AI context review
 * These operations need context analysis to determine if they align with user intent
 *
 * The AI should consider:
 * 1. Did the user explicitly request this operation?
 * 2. Does it make sense given the task at hand?
 * 3. Is the content/action appropriate for the target?
 */
export const NEEDS_AI_REVIEW: SecurityPattern[] = [
  // Remote code execution patterns
  {
    pattern: /(curl|wget).*\|.*(?:bash|sh)/i,
    reason: 'Pipe to shell - verify source is trusted and user intended this'
  },

  // Elevated privileges
  {
    pattern: /sudo/i,
    reason: 'Elevated privileges - verify user intended this action'
  },

  // Destructive operations (except safe build artifact cleanup)
  {
    pattern: /rm\s+-rf/i,
    reason: 'Recursive deletion - verify target matches user intent'
  },

  // Data exfiltration patterns — piping data to network tools
  {
    pattern: /\|\s*(nc|netcat|ncat)\b/i,
    reason: 'Pipe to netcat - potential data exfiltration'
  },
  {
    pattern: /\bscp\b.*@/i,
    reason: 'SCP to remote host - potential data exfiltration'
  },
  {
    pattern: /\|\s*curl\b/i,
    reason: 'Pipe to curl - potential data exfiltration'
  },
  {
    pattern: /curl\b.*-d\s*@/i,
    reason: 'Curl with file upload - potential data exfiltration'
  },

  // ALL Write/Edit operations that aren't to /tmp go through context review
  // This is the key change: we review based on context, not blanket allow/deny
  {
    pattern: /^(Write|Edit):\s*(?!\/tmp\/|\/var\/tmp\/)/i,
    reason: 'File modification - verify aligns with user request'
  },

  // Reverse shells and bind shells — network-connected interactive shells
  {
    pattern: /\/dev\/tcp\//i,
    reason: 'Potential reverse shell via /dev/tcp'
  },
  {
    pattern: /\b(nc|netcat|ncat)\b.*-e\s/i,
    reason: 'Netcat with -e flag - potential reverse shell'
  },
  {
    pattern: /\bsocket\b.*\bconnect\b.*\b(dup2|subprocess|exec)\b/i,
    reason: 'Programmatic reverse shell pattern (socket+connect+exec)'
  },
  {
    pattern: /\bperl\b.*\bsocket\b.*\bexec\b/i,
    reason: 'Perl reverse shell pattern'
  },

  // Encoded/obfuscated payloads piped to shell or eval
  {
    pattern: /\b(base64|base32)\b.*-d.*\|\s*(bash|sh)\b/i,
    reason: 'Decoded payload piped to shell - obfuscated command execution'
  },
  {
    pattern: /\\x[0-9a-f]{2}.*\|\s*(bash|sh)\b/i,
    reason: 'Hex-encoded payload piped to shell'
  },
  {
    pattern: /\bexec\b.*\b(base64|b64decode)\b/i,
    reason: 'Exec with base64 decoding - obfuscated code execution'
  },
  {
    pattern: /\bprintf\b.*\\x[0-9a-f].*\|\s*(bash|sh)\b/i,
    reason: 'Printf hex payload piped to shell'
  },

  // Cloud metadata / SSRF — accessing cloud instance credentials
  {
    pattern: /169\.254\.169\.254/i,
    reason: 'AWS/Azure IMDS access - potential credential theft'
  },
  {
    pattern: /metadata\.google\.internal/i,
    reason: 'GCP metadata access - potential credential theft'
  },

  // Persistence — writing to shell profiles, cron, authorized_keys via echo/append
  {
    pattern: />>\s*~?\/?.*\/(authorized_keys|\.bashrc|\.bash_profile|\.zshrc|\.profile)/i,
    reason: 'Appending to sensitive file - potential persistence mechanism'
  },
  {
    pattern: /\bld\.so\.preload\b/i,
    reason: 'LD_PRELOAD injection - shared library hijacking'
  },

  // wget with file upload
  {
    pattern: /wget\b.*--post-file/i,
    reason: 'wget file upload - potential data exfiltration'
  },

  // pip install from custom index (supply chain attack)
  {
    pattern: /pip\b.*--index-url\s+https?:\/\/(?!pypi\.org)/i,
    reason: 'pip install from non-PyPI index - potential supply chain attack'
  },

  // MCP server manipulation
  {
    pattern: /\bclaude\b.*\bmcp\b.*\badd\b/i,
    reason: 'Adding MCP server - verify source is trusted'
  },
];

/**
 * Check if operation matches any pattern in array
 */
export function matchesPattern(operation: string, patterns: SecurityPattern[]): SecurityPattern | null {
  for (const pattern of patterns) {
    if (pattern.pattern.test(operation)) {
      return pattern;
    }
  }
  return null;
}

/**
 * Normalize file paths in Write/Edit/Read operations to resolve .. traversal.
 * Prevents path traversal attacks like "Write: /home/user/../../etc/passwd"
 * from matching safe home-directory patterns.
 */
export function normalizeOperation(operation: string): string {
  const match = operation.match(/^(Write|Edit|Read):\s*(\S+)/i);
  if (match?.[2].includes('..')) {
    const [, tool, rawPath] = match;
    const normalizedPath = resolve(rawPath);
    return `${tool}: ${normalizedPath}`;
  }
  return operation;
}

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
const SAFE_RM_PATTERNS = [
  /rm\s+-rf\s+(\.\/)?node_modules($|\s)/i,
  /rm\s+-rf\s+(\.\/)?dist($|\s)/i,
  /rm\s+-rf\s+(\.\/)?build($|\s)/i,
  /rm\s+-rf\s+(\.\/)?\.cache($|\s)/i,
  /rm\s+-rf\s+(\.\/)?\.next($|\s)/i,
  /rm\s+-rf\s+(\.\/)?target($|\s)/i,
  /rm\s+-rf\s+(\.\/)?__pycache__($|\s)/i,
];

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

  if (matchesPattern(op, SAFE_OPERATIONS)) {
    // Safe bash commands must not contain chain operators, dangerous pipes,
    // or subshell/backtick expansion that could hide dangerous operations.
    // A safe prefix (e.g., "git clone") with chain operators (&&, ;, ||)
    // means the full command isn't necessarily safe — route to AI review.
    if (/^Bash:/i.test(op) && (
      containsChainOperators(op) ||
      containsDangerousPipe(op) ||
      containsBashExpansion(op) ||
      containsSensitiveRedirect(op)
    )) {
      return true;
    }
    return false;
  }

  if (matchesPattern(op, CRITICAL_THREATS)) return false;

  if (matchesPattern(op, NEEDS_AI_REVIEW)) {
    return !SAFE_RM_PATTERNS.some(p => p.test(op));
  }

  // Glob patterns and script execution are concerning in Bash commands
  if (/^Bash:/.test(op)) {
    if (/\*\*?/.test(op)) return true;
    if (/^Bash:\s*\.\//.test(op)) return true;
  }

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
      isDestructive: false, // Not inherently destructive, just sensitive
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
  // NOTE: Write/Edit are NOT flagged as risky - they're normal dev operations
  if (/rm\s+-rf/i.test(operation)) {
    // Check if it's actually safe (build artifacts, temp)
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
