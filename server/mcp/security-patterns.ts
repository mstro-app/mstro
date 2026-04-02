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
 *
 * Analysis logic (requiresAIReview, classifyRisk) lives in security-analysis.ts
 * and is re-exported here for backward compatibility.
 */

import { resolve } from 'node:path';

// Re-export analysis functions for backward compatibility
export { classifyRisk, isSensitivePath, requiresAIReview } from './security-analysis.js';

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
  {
    pattern: /\/dev\/tcp\//i,
    reason: 'Reverse shell via /dev/tcp - classic backdoor technique'
  },
  {
    pattern: /\bnc\b.*-[elp].*\b\d+\b/i,
    reason: 'Netcat listener/reverse shell - common backdoor technique'
  },
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

  // Write/Edit to user home directory or subdirectories
  { pattern: /^Write:\s*\/Users\/[^/]+\//i },
  { pattern: /^Edit:\s*\/Users\/[^/]+\//i },
  { pattern: /^Write:\s*\/home\/[^/]+\//i },
  { pattern: /^Edit:\s*\/home\/[^/]+\//i },

  // Safe bash commands - common development workflows
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

  // Write/Edit to temp directories
  { pattern: /^(Write|Edit):\s*\/tmp\//i },
  { pattern: /^(Write|Edit):\s*\/var\/tmp\//i },

  // Side-effect-free tools
  { pattern: /^(ExitPlanMode|EnterPlanMode|TodoWrite|AskUserQuestion):/i },

  // Additional common dev commands
  { pattern: /^Bash:\s*(tsc|tsx|node|bun|deno|npx|bunx)\s/i },
  { pattern: /^Bash:\s*(vitest|jest|mocha|tap)\s/i },
  { pattern: /^Bash:\s*(biome|eslint|prettier|tslint)\s+(check|lint|format)/i },
  { pattern: /^Bash:\s*(make|cmake|ninja|meson)($|\s)/i },
  { pattern: /^Bash:\s*git\s+(commit|push|tag|remote|rebase|merge|cherry-pick|reset|revert)($|\s)/i },
  { pattern: /^Bash:\s*git\s+(worktree|submodule|config|clean|gc)($|\s)/i },
  { pattern: /^Bash:\s*(uname|hostname|whoami|id|groups|uptime|df|du|free|top|ps|lsof|stat|file|readlink)($|\s)/i },
  { pattern: /^Bash:\s*(mv|cp|touch|ln|basename|dirname|realpath|mktemp|xargs|tee|tr|cut|paste|comm|diff|patch)($|\s)/i },
  { pattern: /^Bash:\s*(tar|gzip|gunzip|zip|unzip|bzip2)\s/i },
  { pattern: /^Bash:\s*(ruby|python3?|php|java|javac|scala|kotlinc|swift|rustc|gcc|g\+\+|clang)\s/i },
  { pattern: /^Bash:\s*(pip|pip3|gem|bundle|composer|maven|gradle|sbt|cargo|rustup)\s/i },
  { pattern: /^Bash:\s*(gh|hub)\s+(pr|issue|repo|release|run|api)\s/i },
  { pattern: /^Bash:\s*(flyctl|fly)\s+(status|logs|ssh|deploy|apps|machines|secrets)($|\s)/i },
  { pattern: /^Bash:\s*(terraform|tofu)\s+(init|plan|apply|validate|fmt|show|output)($|\s)/i },
  { pattern: /^Bash:\s*wc($|\s)/i },

  // WebFetch/WebSearch are inherently read-only
  { pattern: /^WebFetch:/i },
  { pattern: /^WebSearch:/i },

  // Agent and NotebookEdit are orchestration-only
  { pattern: /^Agent:/i },
  { pattern: /^NotebookEdit:/i },
];

/**
 * Patterns that trigger AI context review
 * These operations need context analysis to determine if they align with user intent
 */
export const NEEDS_AI_REVIEW: SecurityPattern[] = [
  // Remote code execution patterns
  {
    pattern: /(curl|wget).*\|.*(?:bash|sh)/i,
    reason: 'Pipe to shell - verify source is trusted and user intended this'
  },

  // Elevated privileges
  { pattern: /sudo/i, reason: 'Elevated privileges - verify user intended this action' },

  // Destructive operations (except safe build artifact cleanup)
  { pattern: /rm\s+-rf/i, reason: 'Recursive deletion - verify target matches user intent' },

  // Data exfiltration patterns
  { pattern: /\|\s*(nc|netcat|ncat)\b/i, reason: 'Pipe to netcat - potential data exfiltration' },
  { pattern: /\bscp\b.*@/i, reason: 'SCP to remote host - potential data exfiltration' },
  { pattern: /\|\s*curl\b/i, reason: 'Pipe to curl - potential data exfiltration' },
  { pattern: /curl\b.*-d\s*@/i, reason: 'Curl with file upload - potential data exfiltration' },

  // ALL Write/Edit operations that aren't to /tmp go through context review
  {
    pattern: /^(Write|Edit):\s*(?!\/tmp\/|\/var\/tmp\/)/i,
    reason: 'File modification - verify aligns with user request'
  },

  // Reverse shells and bind shells
  { pattern: /\/dev\/tcp\//i, reason: 'Potential reverse shell via /dev/tcp' },
  { pattern: /\b(nc|netcat|ncat)\b.*-e\s/i, reason: 'Netcat with -e flag - potential reverse shell' },
  {
    pattern: /\bsocket\b.*\bconnect\b.*\b(dup2|subprocess|exec)\b/i,
    reason: 'Programmatic reverse shell pattern (socket+connect+exec)'
  },
  { pattern: /\bperl\b.*\bsocket\b.*\bexec\b/i, reason: 'Perl reverse shell pattern' },

  // Encoded/obfuscated payloads piped to shell or eval
  {
    pattern: /\b(base64|base32)\b.*-d.*\|\s*(bash|sh)\b/i,
    reason: 'Decoded payload piped to shell - obfuscated command execution'
  },
  { pattern: /\\x[0-9a-f]{2}.*\|\s*(bash|sh)\b/i, reason: 'Hex-encoded payload piped to shell' },
  { pattern: /\bexec\b.*\b(base64|b64decode)\b/i, reason: 'Exec with base64 decoding - obfuscated code execution' },
  {
    pattern: /\bprintf\b.*\\x[0-9a-f].*\|\s*(bash|sh)\b/i,
    reason: 'Printf hex payload piped to shell'
  },

  // Cloud metadata / SSRF
  { pattern: /169\.254\.169\.254/i, reason: 'AWS/Azure IMDS access - potential credential theft' },
  { pattern: /metadata\.google\.internal/i, reason: 'GCP metadata access - potential credential theft' },

  // Persistence mechanisms
  {
    pattern: />>\s*~?\/?.*\/(authorized_keys|\.bashrc|\.bash_profile|\.zshrc|\.profile)/i,
    reason: 'Appending to sensitive file - potential persistence mechanism'
  },
  { pattern: /\bld\.so\.preload\b/i, reason: 'LD_PRELOAD injection - shared library hijacking' },

  // wget with file upload
  { pattern: /wget\b.*--post-file/i, reason: 'wget file upload - potential data exfiltration' },

  // pip install from custom index (supply chain attack)
  {
    pattern: /pip\b.*--index-url\s+https?:\/\/(?!pypi\.org)/i,
    reason: 'pip install from non-PyPI index - potential supply chain attack'
  },

  // MCP server manipulation
  { pattern: /\bclaude\b.*\bmcp\b.*\badd\b/i, reason: 'Adding MCP server - verify source is trusted' },
];

// ── Utility functions ─────────────────────────────────────────

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
