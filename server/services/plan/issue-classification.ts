// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import type { Issue } from './types.js';

/**
 * Determine whether an issue is a code task (modifies source files) or a
 * document task (produces written output like research, design, plans).
 *
 * Uses the issue's `outputType` field when explicitly set. Falls back to
 * inferring from `filesToModify` — entries prefixed with "Output:" are
 * output path hints, not source files to edit.
 */
export function resolveIsCodeTask(issue: Issue): boolean {
  if (issue.outputType === 'code') return true;
  if (issue.outputType === 'document') return false;

  // auto: infer from filesToModify, filtering out Output:-prefixed entries
  const codeFiles = issue.filesToModify.filter(f => !f.match(/^Output:/i));
  return codeFiles.length > 0;
}
