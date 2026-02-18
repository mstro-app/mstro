#!/usr/bin/env bash
# Copyright (c) 2025-present Mstro, Inc. All rights reserved.
# Licensed under the MIT License. See LICENSE file for details.

#
# Mstro Bouncer Gate - Claude Code Hook
#
# This hook intercepts Claude Code tool calls and routes them through
# the Mstro bouncer for security analysis before execution.
#
# Installation:
#   Run: npx mstro --configure-hooks
#
# Dependencies: Node.js (no jq or bun required)
#

set -euo pipefail

# Configuration - MSTRO_BOUNCER_CLI is set by configure-claude.js
BOUNCER_CLI="${MSTRO_BOUNCER_CLI:-}"
BOUNCER_TIMEOUT="${BOUNCER_TIMEOUT:-10}"
BOUNCER_LOG="${BOUNCER_LOG:-$HOME/.claude/logs/bouncer.log}"

# Ensure log directory exists
mkdir -p "$(dirname "$BOUNCER_LOG")"

# Read hook input from stdin (JSON format from Claude Code)
INPUT=$(cat)

# Use Node.js inline to parse JSON and handle logic (eliminates jq dependency)
RESULT=$(node --input-type=module -e "
import { spawn } from 'child_process';
import { appendFileSync } from 'fs';

const input = JSON.parse(process.argv[1]);
const bouncerCli = process.argv[2];
const timeout = parseInt(process.argv[3], 10) * 1000;
const logFile = process.argv[4];

const toolName = input.tool_name || input.toolName || 'unknown';
const toolInput = input.input || input.toolInput || {};

function log(msg) {
  const timestamp = new Date().toISOString();
  appendFileSync(logFile, \`[\${timestamp}] \${msg}\n\`);
}

function output(decision, reason) {
  console.log(JSON.stringify({ decision, reason }));
}

// Quick path for read-only operations
const readOnlyOps = ['Read', 'Glob', 'Grep', 'Search', 'List', 'WebFetch', 'WebSearch'];
if (readOnlyOps.includes(toolName)) {
  output('allow', 'Read-only operation');
  process.exit(0);
}

// Build operation string for logging
let operation = toolName + ': ';
if (toolName === 'Bash' && toolInput.command) {
  operation += toolInput.command;
} else if (['Write', 'Edit'].includes(toolName)) {
  operation += toolInput.file_path || toolInput.filePath || toolInput.path || JSON.stringify(toolInput);
} else {
  operation += JSON.stringify(toolInput);
}

log('Analyzing: ' + toolName);

// Check if bouncer CLI is available
if (bouncerCli) {
  try {
    const child = spawn('node', [bouncerCli], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeout
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    child.on('close', (code) => {
      if (stderr) log('Bouncer stderr: ' + stderr);

      if (code === 0 && stdout.trim()) {
        try {
          const result = JSON.parse(stdout.trim());
          log(result.decision + ': ' + operation + ' - ' + (result.reason || ''));
          console.log(stdout.trim());
        } catch {
          log('allow (parse error): ' + operation);
          output('allow', 'Bouncer response parse error, allowing');
        }
      } else {
        log('allow (bouncer error): ' + operation);
        output('allow', 'Bouncer error, allowing');
      }
    });

    child.on('error', (err) => {
      log('allow (spawn error): ' + operation + ' - ' + err.message);
      output('allow', 'Bouncer spawn error, allowing');
    });

  } catch (err) {
    log('allow (exception): ' + operation + ' - ' + err.message);
    output('allow', 'Bouncer exception, allowing');
  }
} else {
  // Fallback: critical threat pattern matching only
  const criticalPatterns = [
    { pattern: /rm\s+-rf\s+(\/|~)(\$|\s)/, reason: 'Critical threat: recursive delete of root or home' },
    { pattern: /:\(\)\{.*\}|:\(\)\{.*:\|:/, reason: 'Critical threat: fork bomb detected' },
    { pattern: /dd\s+if=\/dev\/zero\s+of=\/dev\/sd/, reason: 'Critical threat: disk overwrite' },
    { pattern: /mkfs\s+\/dev\/sd/, reason: 'Critical threat: filesystem format' },
    { pattern: />\s*\/dev\/sd/, reason: 'Critical threat: direct disk write' },
  ];

  for (const { pattern, reason } of criticalPatterns) {
    if (pattern.test(operation)) {
      log('DENIED: ' + operation + ' - ' + reason);
      output('deny', reason);
      process.exit(0);
    }
  }

  log('allow (fallback): ' + operation);
  output('allow', 'Basic pattern check passed');
}
" "$INPUT" "$BOUNCER_CLI" "$BOUNCER_TIMEOUT" "$BOUNCER_LOG" 2>> "$BOUNCER_LOG")

echo "$RESULT"
