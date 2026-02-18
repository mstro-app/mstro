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
  }
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

  // ALL Write/Edit operations that aren't to /tmp go through context review
  // This is the key change: we review based on context, not blanket allow/deny
  {
    pattern: /^(Write|Edit):\s*(?!\/tmp\/|\/var\/tmp\/)/i,
    reason: 'File modification - verify aligns with user request'
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
 * Determine if operation requires AI context review
 *
 * The philosophy here is:
 * - SAFE_OPERATIONS: No review needed (read-only, temp files, build artifact cleanup)
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
  if (matchesPattern(operation, SAFE_OPERATIONS)) return false;
  if (matchesPattern(operation, CRITICAL_THREATS)) return false;

  if (matchesPattern(operation, NEEDS_AI_REVIEW)) {
    return !SAFE_RM_PATTERNS.some(p => p.test(operation));
  }

  if (/\$\{.*\}|\$\(.*\)/.test(operation) || /\*\*?/.test(operation)) return true;
  if (/^Bash:\s*\.\//.test(operation)) return true;

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
