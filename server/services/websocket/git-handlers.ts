// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleGitCheckout, handleGitCreateBranch, handleGitDeleteBranch, handleGitListBranches } from './git-branch-handlers.js';
import { handleGitCommitDiff, handleGitDiff, handleGitShowCommit } from './git-diff-handlers.js';
import { handleGitDiscoverRepos, handleGitLog, handleGitSetDirectory } from './git-log-handlers.js';
import { handleGitPRMessage } from './git-pr-handlers.js';
import { handleGitCreateTag, handleGitListTags, handleGitPushTag } from './git-tag-handlers.js';
import { executeGitCommand, parseGitStatus, sendGitError, stripCoauthorLines } from './git-utils.js';
import { handleGitWorktreeMessage } from './git-worktree-handlers.js';
import type { HandlerContext } from './handler-context.js';
import type { GitStatusResponse, WebSocketMessage, WSContext } from './types.js';

// Re-export utilities for backward compatibility (git-pr-handlers, git-worktree-handlers import from here)
export { detectGitProvider, executeGitCommand, parseGitStatus, sendGitError, spawnCheck, spawnWithOutput, stripCoauthorLines, unquoteGitPath } from './git-utils.js';

// PR message types that route to git-pr-handlers
const GIT_PR_TYPES = new Set([
  'gitGetRemoteInfo', 'gitCreatePR', 'gitGeneratePRDescription',
]);

// Worktree/merge message types that route to git-worktree-handlers
const GIT_WORKTREE_TYPES = new Set([
  'gitWorktreeList', 'gitWorktreeCreate', 'gitWorktreeCreateAndAssign', 'gitWorktreeRemove',
  'tabWorktreeSwitch', 'gitWorktreePush', 'gitWorktreeCreatePR',
  'gitMergePreview', 'gitWorktreeMerge', 'gitMergeAbort', 'gitMergeComplete',
]);

/** Route git messages to appropriate sub-handler */
export async function handleGitMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  const gitDir = ctx.gitDirectories.get(tabId) || workingDir;

  if (GIT_PR_TYPES.has(msg.type)) {
    handleGitPRMessage(ctx, ws, msg, tabId, gitDir, workingDir);
    return;
  }
  if (GIT_WORKTREE_TYPES.has(msg.type)) {
    await handleGitWorktreeMessage(ctx, ws, msg, tabId, gitDir, workingDir);
    return;
  }

  const handlers: Record<string, () => void> = {
    gitStatus: () => handleGitStatus(ctx, ws, tabId, gitDir),
    gitStage: () => handleGitStage(ctx, ws, msg, tabId, gitDir),
    gitUnstage: () => handleGitUnstage(ctx, ws, msg, tabId, gitDir),
    gitCommit: () => handleGitCommit(ctx, ws, msg, tabId, gitDir),
    gitCommitWithAI: () => handleGitCommitWithAI(ctx, ws, msg, tabId, gitDir),
    gitPush: () => handleGitPush(ctx, ws, tabId, gitDir),
    gitPull: () => handleGitPull(ctx, ws, tabId, gitDir),
    gitLog: () => handleGitLog(ctx, ws, msg, tabId, gitDir),
    gitDiscoverRepos: () => handleGitDiscoverRepos(ctx, ws, tabId, workingDir),
    gitSetDirectory: () => handleGitSetDirectory(ctx, ws, msg, tabId, workingDir),
    gitListBranches: () => handleGitListBranches(ctx, ws, tabId, gitDir),
    gitCheckout: () => handleGitCheckout(ctx, ws, msg, tabId, gitDir),
    gitCreateBranch: () => handleGitCreateBranch(ctx, ws, msg, tabId, gitDir),
    gitDeleteBranch: () => handleGitDeleteBranch(ctx, ws, msg, tabId, gitDir),
    gitDiff: () => handleGitDiff(ctx, ws, msg, tabId, gitDir),
    gitShowCommit: () => handleGitShowCommit(ctx, ws, msg, tabId, gitDir),
    gitCommitDiff: () => handleGitCommitDiff(ctx, ws, msg, tabId, gitDir),
    gitListTags: () => handleGitListTags(ctx, ws, tabId, gitDir),
    gitCreateTag: () => handleGitCreateTag(ctx, ws, msg, tabId, gitDir),
    gitPushTag: () => handleGitPushTag(ctx, ws, msg, tabId, gitDir),
  };
  handlers[msg.type]?.();
}

export async function handleGitStatus(ctx: HandlerContext, ws: WSContext, tabId: string, workingDir: string): Promise<void> {
  try {
    const statusResult = await executeGitCommand(['status', '--porcelain=v1'], workingDir);
    if (statusResult.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: statusResult.stderr || statusResult.stdout || 'Failed to get git status' } });
      return;
    }

    const branchResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
    const branch = branchResult.stdout.trim() || 'HEAD';

    let ahead = 0;
    let behind = 0;
    let hasUpstream = false;
    const trackingResult = await executeGitCommand(['rev-list', '--left-right', '--count', `${branch}...@{u}`], workingDir);
    if (trackingResult.exitCode === 0) {
      hasUpstream = true;
      const parts = trackingResult.stdout.trim().split(/\s+/);
      ahead = parseInt(parts[0], 10) || 0;
      behind = parseInt(parts[1], 10) || 0;
    } else {
      const localResult = await executeGitCommand(['rev-list', '--count', 'HEAD'], workingDir);
      if (localResult.exitCode === 0) {
        ahead = parseInt(localResult.stdout.trim(), 10) || 0;
      }
    }

    const { staged, unstaged, untracked } = parseGitStatus(statusResult.stdout);

    const response: GitStatusResponse = {
      branch,
      isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
      staged,
      unstaged,
      untracked,
      ahead,
      behind,
      hasUpstream,
    };

    ctx.send(ws, { type: 'gitStatus', tabId, data: response });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

async function handleGitStage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  const stageAll = !!msg.data?.stageAll;
  const paths = msg.data?.paths as string[] | undefined;

  if (!stageAll && (!paths || paths.length === 0)) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: 'No paths specified for staging' } });
    return;
  }

  try {
    const args = stageAll ? ['add', '-A'] : ['add', '--', ...paths!];
    const result = await executeGitCommand(args, workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || result.stdout || 'Failed to stage files' } });
      return;
    }

    ctx.send(ws, { type: 'gitStaged', tabId, data: { paths: paths || [] } });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

async function handleGitUnstage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  const paths = msg.data?.paths as string[] | undefined;
  if (!paths || paths.length === 0) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: 'No paths specified for unstaging' } });
    return;
  }

  try {
    const result = await executeGitCommand(['reset', 'HEAD', '--', ...paths], workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || result.stdout || 'Failed to unstage files' } });
      return;
    }

    ctx.send(ws, { type: 'gitUnstaged', tabId, data: { paths } });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

async function handleGitCommit(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  const message = msg.data?.message as string | undefined;
  if (!message) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Commit message is required' } });
    return;
  }

  try {
    const result = await executeGitCommand(['commit', '-m', message], workingDir);
    if (result.exitCode !== 0) {
      let errorMsg = result.stderr || result.stdout || 'Failed to commit';
      if (errorMsg.includes('nothing to commit') || errorMsg.includes('no changes added')) {
        errorMsg = 'No changes staged for commit. Use "Stage" to add files before committing.';
        handleGitStatus(ctx, ws, tabId, workingDir);
      }
      ctx.send(ws, { type: 'gitError', tabId, data: { error: errorMsg } });
      return;
    }

    const hashResult = await executeGitCommand(['rev-parse', '--short', 'HEAD'], workingDir);
    const hash = hashResult.stdout.trim();

    ctx.send(ws, { type: 'gitCommitted', tabId, data: { hash, message } });
    handleGitStatus(ctx, ws, tabId, workingDir);
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

async function handleGitCommitWithAI(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const statusResult = await executeGitCommand(['status', '--porcelain=v1'], workingDir);
    const { staged } = parseGitStatus(statusResult.stdout);

    if (staged.length === 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'No staged changes to commit' } });
      return;
    }

    const diffResult = await executeGitCommand(['diff', '--cached'], workingDir);
    const diff = diffResult.stdout;

    const logResult = await executeGitCommand(['log', '--oneline', '-5'], workingDir);
    const recentCommits = logResult.stdout.trim();

    const tempDir = join(workingDir, '.mstro', 'tmp');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    let truncatedDiff = diff;
    if (diff.length > 8000) {
      truncatedDiff = `${diff.slice(0, 4000)}\n\n... [diff truncated] ...\n\n${diff.slice(-3500)}`;
    }

    const prompt = `You are generating a git commit message for the following staged changes.

RECENT COMMIT MESSAGES (for style reference):
${recentCommits || 'No recent commits'}

STAGED FILES:
${staged.map(f => `${f.status} ${f.path}`).join('\n')}

DIFF OF STAGED CHANGES:
${truncatedDiff}

Generate a commit message following these rules:
1. First line: imperative mood, max 72 characters (e.g., "Add user authentication", "Fix memory leak in parser")
2. If the changes are complex, add a blank line then bullet points explaining the key changes
3. Focus on the "why" not just the "what"
4. Match the style of recent commits if possible
5. No emojis unless the repo already uses them

Respond with ONLY the commit message, nothing else.`;

    const promptFile = join(tempDir, `commit-msg-${Date.now()}.txt`);
    writeFileSync(promptFile, prompt);

    const systemPrompt = 'You are a commit message assistant. Respond with only the commit message, no preamble or explanation.';

    const args = [
      '--print',
      '--model', 'haiku',
      '--system-prompt', systemPrompt,
      promptFile
    ];

    const claude = spawn('claude', args, {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    claude.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    claude.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    claude.on('close', async (code: number | null) => {
      try {
        unlinkSync(promptFile);
      } catch {
        // Ignore cleanup errors
      }

      if (code !== 0 || !stdout.trim()) {
        console.error('[WebSocketImproviseHandler] Claude commit message error:', stderr || 'No output');
        ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Failed to generate commit message' } });
        return;
      }

      const commitMessage = extractCommitMessage(stdout.trim());
      const autoCommit = !!msg.data?.autoCommit;

      ctx.send(ws, { type: 'gitCommitMessage', tabId, data: { message: commitMessage, autoCommit } });

      if (msg.data?.autoCommit) {
        const commitResult = await executeGitCommand(['commit', '-m', commitMessage], workingDir);
        if (commitResult.exitCode !== 0) {
          ctx.send(ws, { type: 'gitError', tabId, data: { error: commitResult.stderr || commitResult.stdout || 'Failed to commit' } });
          return;
        }

        const hashResult = await executeGitCommand(['rev-parse', '--short', 'HEAD'], workingDir);
        const hash = hashResult.stdout.trim();

        ctx.send(ws, { type: 'gitCommitted', tabId, data: { hash, message: commitMessage } });
        handleGitStatus(ctx, ws, tabId, workingDir);
      }
    });

    claude.on('error', (err: Error) => {
      console.error('[WebSocketImproviseHandler] Failed to spawn Claude for commit:', err);
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Failed to generate commit message' } });
    });

    setTimeout(() => {
      claude.kill();
    }, 30000);

  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

function extractCommitMessage(output: string): string {
  const patterns = [
    /(?:here'?s?\s+(?:the\s+)?commit\s+message:?\s*\n+)([\s\S]+)/i,
    /(?:commit\s+message:?\s*\n+)([\s\S]+)/i,
    /(?:suggested\s+commit\s+message:?\s*\n+)([\s\S]+)/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1]) {
      return stripCoauthorLines(match[1].trim());
    }
  }

  const paragraphs = output.split(/\n\n+/).filter(p => p.trim());

  if (paragraphs.length <= 1) {
    return stripCoauthorLines(output.trim());
  }

  const firstParagraph = paragraphs[0].trim();
  const firstLine = firstParagraph.split('\n')[0].trim();

  const reasoningPatterns = [
    /^(Now|Based|Looking|After|Here|Let me|I\s+(can|will|see|notice|'ll|would))/i,
    /^The\s+\w+\s+(file|changes?|commit|diff)/i,
    /\b(I can|I will|I'll|let me|analyzing|looking at)\b/i,
  ];

  const looksLikeReasoning = reasoningPatterns.some(p => p.test(firstParagraph));
  const firstLineTooLong = firstLine.length > 80;
  const endsWithPeriod = firstLine.endsWith('.');

  if (looksLikeReasoning || (firstLineTooLong && endsWithPeriod)) {
    const commitMessage = paragraphs.slice(1).join('\n\n').trim();
    const extractedFirstLine = commitMessage.split('\n')[0].trim();
    if (extractedFirstLine.length > 0 && extractedFirstLine.length <= 100) {
      return stripCoauthorLines(commitMessage);
    }
  }

  if (paragraphs.length >= 2) {
    const secondParagraph = paragraphs[1].trim();
    const secondFirstLine = secondParagraph.split('\n')[0].trim();

    if (secondFirstLine.length <= 72 &&
        /^[A-Z][a-z]/.test(secondFirstLine) &&
        !secondFirstLine.endsWith('.')) {
      return stripCoauthorLines(paragraphs.slice(1).join('\n\n').trim());
    }
  }

  return stripCoauthorLines(output.trim());
}

async function handleGitPush(ctx: HandlerContext, ws: WSContext, tabId: string, workingDir: string): Promise<void> {
  try {
    const branchResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
    const branch = branchResult.stdout.trim();

    const upstreamCheck = await executeGitCommand(['rev-parse', '--abbrev-ref', `${branch}@{u}`], workingDir);
    const hasUpstream = upstreamCheck.exitCode === 0;

    const pushArgs = hasUpstream ? ['push'] : ['push', '-u', 'origin', branch];
    const result = await executeGitCommand(pushArgs, workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || result.stdout || 'Failed to push' } });
      return;
    }

    ctx.send(ws, { type: 'gitPushed', tabId, data: { output: result.stdout || result.stderr } });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}

async function handleGitPull(ctx: HandlerContext, ws: WSContext, tabId: string, workingDir: string): Promise<void> {
  try {
    const result = await executeGitCommand(['pull'], workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || result.stdout || 'Failed to pull' } });
      return;
    }

    ctx.send(ws, { type: 'gitPulled', tabId, data: { output: result.stdout || result.stderr } });
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  }
}
