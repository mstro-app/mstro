// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Issue Prompt Builder — Constructs a prompt for a single headless Claude Code instance.
 *
 * Each issue gets its own independent Claude Code session. No Agent Teams,
 * no coordinator/teammate model — just one prompt per issue.
 */

import { join } from 'node:path';
import type { Issue } from './types.js';

export interface IssuePromptOptions {
  issue: Issue;
  workingDir: string;
  pmDir: string | null;
  /** Board directory path (e.g. /path/.pm/boards/BOARD-001). */
  boardDir: string | null;
  existingDocs: string[];
  outputPath: string;
}

/**
 * Build a self-contained prompt for one issue.
 * The resulting Claude Code session will work independently —
 * read the issue spec, execute acceptance criteria, write output, update status.
 */
export function buildIssuePrompt(options: IssuePromptOptions): string {
  const { issue, workingDir, pmDir, boardDir, existingDocs, outputPath } = options;

  const criteria = issue.acceptanceCriteria
    .map(c => `- [${c.checked ? 'x' : ' '}] ${c.text}`)
    .join('\n');

  const files = issue.filesToModify.length > 0
    ? `\n## Files to Modify\n${issue.filesToModify.map(f => `- ${f}`).join('\n')}`
    : '';

  const predecessorDocs = resolvePredecessorDocs(issue, existingDocs);
  const predecessorSection = predecessorDocs.length > 0
    ? `\n## Predecessor Outputs\nRead these before starting — they contain context from upstream issues:\n${predecessorDocs.map(d => `- ${d}`).join('\n')}`
    : '';

  const outDir = boardDir ? join(boardDir, 'out') : pmDir ? join(pmDir, 'out') : join(workingDir, '.mstro', 'pm', 'out');

  return `You are executing issue ${issue.id}: ${issue.title}.

## Project Directory
Working directory: ${workingDir}
Plan directory: ${pmDir || '.mstro/pm/'}

## Issue Specification

**ID**: ${issue.id}
**Title**: ${issue.title}
**Type**: ${issue.type} | **Priority**: ${issue.priority} | **Estimate**: ${issue.estimate ?? 'unestimated'}

### Description
${issue.description}

### Acceptance Criteria
${criteria || 'No specific criteria defined.'}

### Technical Notes
${issue.technicalNotes || 'None'}
${files}${predecessorSection}

## Your Task

1. Read the full issue spec at ${pmDir ? join(pmDir, issue.path) : issue.path}
2. Execute all acceptance criteria listed above
3. Write your output and results to **${outputPath}** — this is the handoff artifact for downstream issues
4. After writing output, update the issue front matter: change \`status: in_progress\` to \`status: done\`

## Rules

- Stay within this issue's scope. Do not modify files outside your assigned scope.
- The orchestrator manages STATE.md separately — do not edit STATE.md.
- Write all significant output to ${outDir}/ so downstream issues can reference it.
- If you cannot complete the issue, leave status as \`in_progress\` and document what blocked you in the output file.`;
}

/** Find predecessor output docs based on blockedBy dependencies. */
function resolvePredecessorDocs(issue: Issue, existingDocs: string[]): string[] {
  return issue.blockedBy
    .map(bp => {
      const blockerId = bp.replace(/^backlog\//, '').replace(/\.md$/, '');
      return existingDocs.find(d => d.toLowerCase().includes(blockerId.toLowerCase()));
    })
    .filter(Boolean) as string[];
}
