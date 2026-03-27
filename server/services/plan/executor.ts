// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Plan Executor — Wave-based execution with Claude Code Agent Teams.
 *
 * Reads the dependency DAG from .pm/, picks ALL unblocked issues per wave,
 * spawns a coordinator Claude session that uses Agent Teams to execute them
 * in parallel, then reconciles state and repeats for newly-unblocked issues.
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWithFileLogger } from '../../cli/headless/headless-logger.js';
import { HeadlessRunner } from '../../cli/headless/index.js';
import { generateMcpConfig } from '../../cli/headless/mcp-config.js';
import { resolveReadyToWork } from './dependency-resolver.js';
import { parsePlanDirectory, resolvePmDir } from './parser.js';
import { reconcileState } from './state-reconciler.js';
import type { Issue } from './types.js';

export type ExecutionStatus = 'idle' | 'starting' | 'executing' | 'paused' | 'stopping' | 'complete' | 'error';

export interface ExecutionMetrics {
  issuesCompleted: number;
  issuesAttempted: number;
  totalDuration: number;
  currentIssueId: string | null;
  /** IDs of issues being executed in the current wave */
  currentWaveIds: string[];
}

export class PlanExecutor extends EventEmitter {
  private status: ExecutionStatus = 'idle';
  private workingDir: string;
  private shouldStop = false;
  private shouldPause = false;
  private epicScope: string | null = null;
  private metrics: ExecutionMetrics = {
    issuesCompleted: 0,
    issuesAttempted: 0,
    totalDuration: 0,
    currentIssueId: null,
    currentWaveIds: [],
  };

  constructor(workingDir: string) {
    super();
    this.workingDir = workingDir;
  }

  getStatus(): ExecutionStatus {
    return this.status;
  }

  getMetrics(): ExecutionMetrics {
    return { ...this.metrics };
  }

  async startEpic(epicPath: string): Promise<void> {
    this.epicScope = epicPath;
    return this.start();
  }

  async start(): Promise<void> {
    if (this.status === 'executing' || this.status === 'starting') return;

    this.shouldStop = false;
    this.shouldPause = false;
    this.status = 'starting';
    this.emit('statusChanged', this.status);

    const startTime = Date.now();

    try {
      this.status = 'executing';
      this.emit('statusChanged', this.status);

      while (!this.shouldStop && !this.shouldPause) {
        const readyIssues = this.pickReadyIssues();
        if (readyIssues.length === 0) break;

        // Always use wave execution with Agent Teams — even for single issues.
        // Each teammate runs as a separate process with its own context window,
        // bouncer coverage via .mcp.json + PreToolUse hook, and disk persistence.
        await this.executeWave(readyIssues);
      }
    } catch (error) {
      this.status = 'error';
      this.emit('error', error instanceof Error ? error.message : String(error));
      return;
    }

    this.metrics.totalDuration = Date.now() - startTime;

    if (this.shouldPause) {
      this.status = 'paused';
    } else if (this.shouldStop) {
      this.status = 'idle';
    } else {
      this.status = 'complete';
    }
    this.emit('statusChanged', this.status);
  }

  pause(): void {
    this.shouldPause = true;
  }

  stop(): void {
    this.shouldStop = true;
  }

  resume(): Promise<void> {
    if (this.status !== 'paused') return Promise.resolve();
    this.shouldPause = false;
    return this.start();
  }

  // ── Wave execution (Agent Teams) ──────────────────────────────

  private async executeWave(issues: Issue[]): Promise<void> {
    const waveIds = issues.map(i => i.id);
    this.metrics.currentWaveIds = waveIds;
    this.metrics.issuesAttempted += issues.length;
    this.emit('waveStarted', { issueIds: waveIds });

    // Pre-approve tools so teammates don't hit interactive permission prompts
    this.installTeammatePermissions();

    // Install bouncer .mcp.json so Agent Teams teammates discover it
    this.installBouncerForSubagents();

    // Mark all wave issues as in_progress
    for (const issue of issues) {
      this.updateIssueFrontMatter(issue.path, 'in_progress');
    }

    const prompt = this.buildCoordinatorPrompt(issues);

    try {
      const runner = new HeadlessRunner({
        workingDir: this.workingDir,
        directPrompt: prompt,
        stallKillMs: 3_600_000,  // 60 min — waves run longer
        stallHardCapMs: 7_200_000, // 2 hr hard cap
        extraEnv: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        },
        outputCallback: (text: string) => {
          this.emit('output', { issueId: `wave[${waveIds.join(',')}]`, text });
        },
      });

      const result = await runWithFileLogger('pm-execute-wave', () => runner.run());

      if (!result.completed || result.error) {
        this.emit('waveError', {
          issueIds: waveIds,
          error: result.error || 'Wave did not complete successfully',
        });
      }

      // Check which issues the agents actually completed by reading disk
      this.reconcileWaveResults(issues);

    } catch (error) {
      this.emit('waveError', {
        issueIds: waveIds,
        error: error instanceof Error ? error.message : String(error),
      });
      this.revertIncompleteIssues(issues);
    }

    // Clean up temporary configs
    this.uninstallBouncerForSubagents();
    this.uninstallTeammatePermissions();

    // Reconcile STATE.md after wave
    reconcileState(this.workingDir);
    this.emit('stateUpdated');
    this.metrics.currentWaveIds = [];
  }

  /**
   * After a wave, check each issue's status on disk.
   * The coordinator agent is instructed to mark issues as done via front matter,
   * so we trust the disk state and update metrics accordingly.
   */
  private reconcileWaveResults(issues: Issue[]): void {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return;

    for (const issue of issues) {
      const fullPath = join(pmDir, issue.path);
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const statusMatch = content.match(/^status:\s*(\S+)/m);
        const currentStatus = statusMatch?.[1] ?? 'unknown';

        if (currentStatus === 'done') {
          this.metrics.issuesCompleted++;
          this.emit('issueCompleted', issue);
        } else if (currentStatus === 'in_progress') {
          // Agent didn't finish — check if output doc exists (partial completion)
          const outputDoc = this.findOutputDoc(issue.id);
          if (outputDoc) {
            // Output was written but status not updated — mark done
            this.updateIssueFrontMatter(issue.path, 'done');
            this.metrics.issuesCompleted++;
            this.emit('issueCompleted', issue);
          } else {
            // Genuinely incomplete — revert to prior status
            this.updateIssueFrontMatter(issue.path, issue.status);
            this.emit('issueError', {
              issueId: issue.id,
              error: 'Issue did not complete during wave execution',
            });
          }
        }
      } catch {
        // File read error — treat as incomplete
        this.emit('issueError', { issueId: issue.id, error: 'Could not read issue file after wave' });
      }
    }
  }

  /**
   * Look for an output document matching an issue ID in .pm/docs/.
   */
  private findOutputDoc(issueId: string): string | null {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return null;
    const docsDir = join(pmDir, 'docs');
    if (!existsSync(docsDir)) return null;

    try {
      const files = readdirSync(docsDir);
      const prefix = issueId.toLowerCase();
      const match = files.find(f => f.toLowerCase().startsWith(prefix) && f.endsWith('.md'));
      return match ? join(docsDir, match) : null;
    } catch {
      return null;
    }
  }

  // ── Issue picking ─────────────────────────────────────────────

  private pickReadyIssues(): Issue[] {
    const fullState = parsePlanDirectory(this.workingDir);
    if (!fullState) {
      this.emit('error', 'No .pm/ directory found');
      return [];
    }
    if (fullState.state.paused) {
      this.emit('error', 'Project is paused');
      return [];
    }
    const readyIssues = resolveReadyToWork(fullState.issues, this.epicScope ?? undefined);
    if (readyIssues.length === 0) {
      this.emit('complete', this.epicScope ? 'All epic issues are done or blocked' : 'All work is done or blocked');
    }
    return readyIssues;
  }

  // ── Prompt building ───────────────────────────────────────────

  /**
   * Build the team lead prompt for a wave of issues.
   * Uses Agent Teams (TeamCreate/SendMessage) for true parallel execution
   * as separate processes — each teammate gets its own context window.
   */
  private buildCoordinatorPrompt(issues: Issue[]): string {
    const pmDir = resolvePmDir(this.workingDir);
    const docsDir = pmDir ? join(pmDir, 'docs') : '.pm/docs';

    // Collect existing output docs that issues may need as input
    const existingDocs = this.listExistingDocs();

    const issueBlocks = issues.map(issue => {
      const criteria = issue.acceptanceCriteria
        .map(c => `- [${c.checked ? 'x' : ' '}] ${c.text}`)
        .join('\n');

      const files = issue.filesToModify.length > 0
        ? `\nFiles to modify:\n${issue.filesToModify.map(f => `- ${f}`).join('\n')}`
        : '';

      // Find predecessor output docs this issue should read
      const predecessorDocs = issue.blockedBy
        .map(bp => {
          const blockerId = bp.replace(/^backlog\//, '').replace(/\.md$/, '');
          return existingDocs.find(d => d.toLowerCase().includes(blockerId.toLowerCase()));
        })
        .filter(Boolean) as string[];

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

**Output file**: ${docsDir}/${issue.id}-${this.slugify(issue.title)}.md`;
    }).join('\n\n---\n\n');

    const teammateNames = issues.map(i => i.id.toLowerCase()).join(', ');
    const teamName = `pm-wave-${Date.now()}`;

    const teammateSpawns = issues.map(issue => {
      const predecessorDocs = issue.blockedBy
        .map(bp => {
          const blockerId = bp.replace(/^backlog\//, '').replace(/\.md$/, '');
          return existingDocs.find(d => d.toLowerCase().includes(blockerId.toLowerCase()));
        })
        .filter(Boolean) as string[];

      const predInstr = predecessorDocs.length > 0
        ? `Read these predecessor output docs before starting: ${predecessorDocs.join(', ')}. `
        : '';

      const outputFile = `${docsDir}/${issue.id}-${this.slugify(issue.title)}.md`;

      return `Spawn teammate **${issue.id.toLowerCase()}** using the **Agent** tool with \`team_name: "${teamName}"\` and \`name: "${issue.id.toLowerCase()}"\`:
> ${predInstr}Work on issue ${issue.id}: ${issue.title}.
> Read the full spec at ${pmDir ? join(pmDir, issue.path) : issue.path}.
> Execute all acceptance criteria.
> CRITICAL: Write ALL output/results to ${outputFile} — this is the handoff artifact for downstream issues.
> After writing output, update the issue front matter: change \`status: in_progress\` to \`status: done\`.
> Do not modify STATE.md. Do not work on anything outside this issue's scope.`;
    }).join('\n\n');

    return `You are the team lead coordinating ${issues.length} issue${issues.length > 1 ? 's' : ''} using Agent Teams.

## Project Directory
Working directory: ${this.workingDir}
Plan directory: ${pmDir || '.pm/'}

## Issues to Execute

${issueBlocks}

## Execution Protocol — Agent Teams

### Step 1: Create the team

Use **TeamCreate** to create a team named \`${teamName}\`.

### Step 2: Spawn teammates

Spawn all ${issues.length} teammates in parallel using the **Agent** tool with \`team_name\` and \`name\` parameters. Send a single message with ${issues.length} Agent tool calls.

${teammateSpawns}

### Step 3: Monitor completion

After spawning all teammates, poll for completion:
1. Use **SendMessage** to each teammate (${teammateNames}) asking for status
2. A teammate is done when its output file exists on disk AND the issue status is \`done\`
3. If a teammate reports completion, verify by reading the output file yourself
4. If a teammate is struggling, provide guidance via SendMessage

### Step 4: Verify and clean up

Once all teammates report done:
1. Verify each output file exists in ${docsDir}/
2. Verify each issue's front matter status is \`done\`
3. If any teammate failed to write output or update status, do it yourself
4. Use **TeamDelete** to clean up the team \`${teamName}\`
5. Do NOT modify STATE.md — the orchestrator handles that

## Critical Rules

- Create ONE team with TeamCreate, then spawn teammates with Agent(team_name="${teamName}", name="...").
- Each teammate MUST write its output to disk. Research only in conversation is LOST.
- Each teammate MUST update the issue front matter status to \`done\`.
- One issue per teammate — no cross-issue work.
- Do not exit until ALL teammates have completed and output files are verified.`;
  }

  /**
   * Revert issues that stayed in_progress after a failed wave.
   */
  private revertIncompleteIssues(issues: Issue[]): void {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return;
    for (const issue of issues) {
      const fullPath = join(pmDir, issue.path);
      try {
        const content = readFileSync(fullPath, 'utf-8');
        if (content.match(/^status:\s*in_progress$/m)) {
          this.updateIssueFrontMatter(issue.path, issue.status);
        }
      } catch { /* file may be gone */ }
    }
  }

  // ── Teammate permissions ─────────────────────────────────────

  /** Saved content of any pre-existing .claude/settings.json so we can restore it */
  private savedClaudeSettings: string | null = null;
  private claudeSettingsInstalled = false;

  /**
   * Pre-approve tools in project .claude/settings.json so Agent Teams
   * teammates can work without interactive permission prompts.
   * Teammates are separate processes that inherit the lead's permission
   * settings. Without pre-approved tools, they hit interactive prompts
   * that can't be answered in headless/background mode (known bug #25254).
   */
  private installTeammatePermissions(): void {
    const claudeDir = join(this.workingDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.json');

    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    // Tools that teammates may need during execution
    const requiredPermissions = [
      'Bash',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
      'Agent',
    ];

    try {
      // Save existing settings
      if (existsSync(settingsPath)) {
        this.savedClaudeSettings = readFileSync(settingsPath, 'utf-8');
        const existing = JSON.parse(this.savedClaudeSettings);

        // Merge permissions into existing settings
        if (!existing.permissions) existing.permissions = {};
        if (!existing.permissions.allow) existing.permissions.allow = [];

        for (const tool of requiredPermissions) {
          if (!existing.permissions.allow.includes(tool)) {
            existing.permissions.allow.push(tool);
          }
        }

        writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
      } else {
        this.savedClaudeSettings = null;
        writeFileSync(settingsPath, JSON.stringify({
          permissions: { allow: requiredPermissions },
        }, null, 2));
      }
      this.claudeSettingsInstalled = true;
    } catch {
      // Non-fatal — teammates may hit permission prompts
    }
  }

  /**
   * Restore original .claude/settings.json after wave execution.
   */
  private uninstallTeammatePermissions(): void {
    if (!this.claudeSettingsInstalled) return;
    const settingsPath = join(this.workingDir, '.claude', 'settings.json');

    try {
      if (this.savedClaudeSettings !== null) {
        writeFileSync(settingsPath, this.savedClaudeSettings);
      } else {
        unlinkSync(settingsPath);
      }
    } catch {
      // Best effort
    }

    this.savedClaudeSettings = null;
    this.claudeSettingsInstalled = false;
  }

  // ── Bouncer propagation for sub-agents ─────────────────────

  /** Saved content of any pre-existing .mcp.json so we can restore it */
  private savedMcpJson: string | null = null;
  private mcpJsonInstalled = false;

  /**
   * Write .mcp.json in the working directory so Agent Teams teammates
   * (separate processes) auto-discover the bouncer MCP server.
   * This is essential — teammates don't inherit --mcp-config or
   * --permission-prompt-tool from the team lead. .mcp.json project-level
   * discovery + global PreToolUse hooks are the two bouncer paths for teammates.
   *
   * Also generates ~/.mstro/mcp-config.json for the team lead (--mcp-config).
   */
  private installBouncerForSubagents(): void {
    const mcpJsonPath = join(this.workingDir, '.mcp.json');

    // Generate the standard MCP config (for parent --mcp-config)
    generateMcpConfig(this.workingDir);

    // Read the generated config and write it as .mcp.json for sub-agent discovery
    try {
      const generatedPath = generateMcpConfig(this.workingDir);
      if (!generatedPath) return;

      const mcpConfig = readFileSync(generatedPath, 'utf-8');

      // Save any existing .mcp.json
      if (existsSync(mcpJsonPath)) {
        this.savedMcpJson = readFileSync(mcpJsonPath, 'utf-8');

        // Merge: add bouncer to existing config
        const existing = JSON.parse(this.savedMcpJson);
        const generated = JSON.parse(mcpConfig);
        existing.mcpServers = {
          ...existing.mcpServers,
          'mstro-bouncer': generated.mcpServers['mstro-bouncer'],
        };
        writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2));
      } else {
        writeFileSync(mcpJsonPath, mcpConfig);
      }

      this.mcpJsonInstalled = true;
    } catch {
      // Non-fatal: parent has MCP via --mcp-config, teammates fall back to PreToolUse hooks
    }
  }

  /**
   * Restore or remove .mcp.json after execution.
   */
  private uninstallBouncerForSubagents(): void {
    if (!this.mcpJsonInstalled) return;
    const mcpJsonPath = join(this.workingDir, '.mcp.json');

    try {
      if (this.savedMcpJson !== null) {
        // Restore the original
        writeFileSync(mcpJsonPath, this.savedMcpJson);
      } else {
        // We created it — remove it
        unlinkSync(mcpJsonPath);
      }
    } catch {
      // Best effort cleanup
    }

    this.savedMcpJson = null;
    this.mcpJsonInstalled = false;
  }

  // ── Helpers ───────────────────────────────────────────────────

  private listExistingDocs(): string[] {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return [];
    const docsDir = join(pmDir, 'docs');
    if (!existsSync(docsDir)) return [];

    try {
      return readdirSync(docsDir, { recursive: true })
        .filter((f): f is string => typeof f === 'string' && f.endsWith('.md'))
        .map(f => join(docsDir, f));
    } catch {
      return [];
    }
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  private updateIssueFrontMatter(issuePath: string, newStatus: string): void {
    const pmDir = resolvePmDir(this.workingDir);
    if (!pmDir) return;
    const fullPath = join(pmDir, issuePath);
    try {
      let content = readFileSync(fullPath, 'utf-8');
      content = content.replace(/^(status:\s*).+$/m, `$1${newStatus}`);
      writeFileSync(fullPath, content, 'utf-8');
    } catch {
      // Ignore errors — file may have been moved
    }
  }
}
