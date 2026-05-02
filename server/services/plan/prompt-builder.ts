// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Prompt Builder — Constructs the Agent Teams coordinator prompt.
 *
 * Builds a structured prompt for the team lead that spawns teammates
 * using Agent Teams, waits for completion, and verifies outputs.
 */

import { join } from 'node:path';
import type { Issue } from './types.js';

export interface CoordinatorPromptOptions {
  issues: Issue[];
  workingDir: string;
  pmDir: string | null;
  /** Board directory path when executing a board (e.g. /path/.mstro/pm/boards/BOARD-001). */
  boardDir: string | null;
  existingDocs: string[];
  resolveOutputPath: (issue: Issue) => string;
}

/**
 * Build the team lead prompt for a wave of issues.
 * Uses Agent Teams for true parallel execution — each teammate gets
 * its own context window and sends idle notifications when done.
 */
export function buildCoordinatorPrompt(options: CoordinatorPromptOptions): string {
  const { issues, workingDir, pmDir, boardDir, existingDocs, resolveOutputPath } = options;
  const outDir = resolveOutDir(workingDir, pmDir, boardDir);
  const teamName = `pm-wave-${Date.now()}`;

  const issueBlocks = issues.map(issue => buildIssueBlock(issue, existingDocs, resolveOutputPath)).join('\n\n---\n\n');
  const teammateSpawns = issues.map(issue => buildTeammateSpawn(issue, teamName, pmDir, existingDocs, resolveOutputPath)).join('\n\n');

  return assembleCoordinatorPrompt({ issues, workingDir, pmDir, outDir, teamName, issueBlocks, teammateSpawns });
}

function resolveOutDir(workingDir: string, pmDir: string | null, boardDir: string | null): string {
  if (boardDir) return join(boardDir, 'out');
  if (pmDir) return join(pmDir, 'out');
  return join(workingDir, '.mstro', 'pm', 'out');
}

function buildIssueBlock(
  issue: Issue,
  existingDocs: string[],
  resolveOutputPath: (issue: Issue) => string,
): string {
  const criteria = issue.acceptanceCriteria
    .map(c => `- [${c.checked ? 'x' : ' '}] ${c.text}`)
    .join('\n');

  const files = issue.filesToModify.length > 0
    ? `\nFiles to modify:\n${issue.filesToModify.map(f => `- ${f}`).join('\n')}`
    : '';

  const predecessorDocs = resolvePredecessorDocs(issue, existingDocs);
  const predecessorSection = predecessorDocs.length > 0
    ? `\nPredecessor outputs to read:\n${predecessorDocs.map(d => `- ${d}`).join('\n')}`
    : '';

  return `### ${issue.id}: ${issue.title}

**Type**: ${issue.type} | **Priority**: ${issue.priority} | **Estimate**: ${issue.estimate ?? 'unestimated'}

**Description**:
${issue.description}

**Acceptance Criteria**:
${criteria || 'No specific criteria defined.'}

**Technical Notes**:
${issue.technicalNotes || 'None'}
${files}${predecessorSection}

**Output file**: ${resolveOutputPath(issue)}`;
}

function buildTeammateSpawn(
  issue: Issue,
  teamName: string,
  pmDir: string | null,
  existingDocs: string[],
  resolveOutputPath: (issue: Issue) => string,
): string {
  const predecessorDocs = resolvePredecessorDocs(issue, existingDocs);
  const predInstr = predecessorDocs.length > 0
    ? `Read these predecessor output docs before starting: ${predecessorDocs.join(', ')}. `
    : '';

  const outputFile = resolveOutputPath(issue);

  const fileOwnership = issue.filesToModify.length > 0
    ? `\n> FILE OWNERSHIP: You own these files exclusively: ${issue.filesToModify.join(', ')}. Other teammates own all other files.`
    : '';

  return `Spawn teammate **${issue.id.toLowerCase()}** using the **Agent** tool with \`team_name: "${teamName}"\` and \`name: "${issue.id.toLowerCase()}"\`:
> ${predInstr}Work on issue ${issue.id}: ${issue.title}.
> Read the full spec at ${pmDir ? join(pmDir, issue.path) : issue.path}.
> Execute all acceptance criteria.
> Write all output and results to ${outputFile} — this is the handoff artifact for downstream issues.
> After writing output, update the issue front matter: change \`status: in_progress\` to \`status: done\`.
> The orchestrator manages STATE.md. Stay within this issue's scope.${fileOwnership}`;
}

interface AssembleArgs {
  issues: Issue[];
  workingDir: string;
  pmDir: string | null;
  outDir: string;
  teamName: string;
  issueBlocks: string;
  teammateSpawns: string;
}

function assembleCoordinatorPrompt(args: AssembleArgs): string {
  const { issues, workingDir, pmDir, outDir, teamName, issueBlocks, teammateSpawns } = args;
  const issueCount = issues.length;
  const plural = issueCount > 1 ? 's' : '';
  const checklist = issues.map(i => `- [ ] ${i.id.toLowerCase()}`).join('\n');
  const teammateNames = issues.map(i => `- \`${i.id.toLowerCase()}\``).join('\n');

  return `You are the team lead coordinating ${issueCount} issue${plural} using Agent Teams.

## Project Directory
Working directory: ${workingDir}
Plan directory: ${pmDir || '.mstro/pm/'}

## Issues to Execute

${issueBlocks}

## Execution Protocol — Agent Teams

All team coordination uses exactly two tools:
- **Agent** — spawn teammates (include \`team_name\` and \`name\` in each call)
- **SendMessage** — message teammates after they are spawned

### Step 1: Spawn all teammates in one message

Send a single message containing ${issueCount} **Agent** tool calls. Include \`team_name: "${teamName}"\` and a unique \`name\` in each call. The team starts automatically when the first teammate is spawned — the \`team_name\` parameter handles all setup.

${teammateSpawns}

### Step 2: Wait for every teammate to finish

After spawning, idle notifications arrive automatically as messages — you will be notified when each teammate finishes. Between notifications, you have nothing to do. Simply state that you are waiting and let the system deliver notifications to you.

Your first action after spawning all teammates: output a brief status message listing all teammates and confirming you are waiting for their idle notifications. Then wait.

Track completion against this checklist — proceed to Step 3 only after all are checked:
${checklist}

Exact teammate names for SendMessage (messages to any other name are silently dropped):
${teammateNames}

When you receive an idle notification from a teammate:
- Check off that teammate in the checklist above
- Verify their output file exists on disk using the **Read** tool

If 15 minutes pass without an idle notification from a specific teammate, send them a progress check via **SendMessage** using the exact name from the list above. After 5 more minutes with no response, check their output file and issue status on disk — if the output exists and status is \`done\`, mark them complete. Otherwise, update the issue status based on whatever partial work exists, then continue.

Staying active until all teammates finish is essential — when the lead exits, all teammate processes stop and their in-progress work is lost. When unsure whether a teammate is still working, keep waiting.

### Step 3: Verify outputs

Once every teammate has completed or been handled:
1. Verify each output file exists in ${outDir}/ using **Read** or **Glob**
2. Verify each issue's front matter status is \`done\`
3. For any missing output or status update, write it yourself
4. The orchestrator manages STATE.md separately — focus on output files and issue front matter only

### Step 4: Clean up and exit

After all outputs are verified:
- Send each remaining active teammate a shutdown message via **SendMessage**
- Then exit — the orchestrator handles the next wave

## Coordination Rules

- The team starts implicitly when you spawn the first teammate with \`team_name\`. Cleanup happens automatically when all teammates exit or the lead exits.
- Wait for idle notifications from all ${issueCount} teammates before exiting — this ensures all work is saved to disk.
- Each teammate writes its output to disk (the handoff artifact for downstream issues). Research kept only in conversation is lost when the teammate exits.
- Each teammate updates its issue front matter status to \`done\` when finished.
- One issue per teammate — each teammate stays within its assigned scope.
- Use only the exact teammate names listed above for SendMessage.`;
}

/** Find predecessor output docs that an issue should read based on its blockedBy dependencies. */
function resolvePredecessorDocs(issue: Issue, existingDocs: string[]): string[] {
  return issue.blockedBy
    .map(bp => {
      const blockerId = bp.replace(/^backlog\//, '').replace(/\.md$/, '');
      return existingDocs.find(d => d.toLowerCase().includes(blockerId.toLowerCase()));
    })
    .filter(Boolean) as string[];
}
