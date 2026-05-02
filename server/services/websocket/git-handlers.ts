// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { resolve } from 'node:path';
import { loadSkillPrompt } from '../plan/agent-loader.js';
import { handleGitCheckout, handleGitCreateBranch, handleGitDeleteBranch, handleGitListBranches } from './git-branch-handlers.js';
import { handleGitCommitDiff, handleGitDiff, handleGitShowCommit } from './git-diff-handlers.js';
import { handleGitDiscoverRepos, handleGitLog, handleGitSetDirectory } from './git-log-handlers.js';
import { handleGitPRMessage } from './git-pr-handlers.js';
import { handleGitCreateTag, handleGitListTags, handleGitPushTag } from './git-tag-handlers.js';
import { classifyHaikuFailure, executeGitCommand, type HaikuResult, logCommitMessageEvent, parseGitStatus, sendGitError, spawnHaikuWithPrompt, stripCoauthorLines, truncateDiff } from './git-utils.js';
import { handleGitWorktreeMessage } from './git-worktree-handlers.js';
import type { HandlerContext } from './handler-context.js';
import type { GitStatusResponse, WebSocketMessage, WSContext } from './types.js';

// Re-export utilities for backward compatibility (git-pr-handlers, git-worktree-handlers import from here)
export { detectGitProvider, executeGitCommand, parseGitStatus, sendGitError, spawnCheck, spawnHaikuWithPrompt, spawnWithOutput, stripCoauthorLines, truncateDiff, unquoteGitPath } from './git-utils.js';

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
    await handleGitPRMessage(ctx, ws, msg, tabId, gitDir, workingDir);
    return;
  }
  if (GIT_WORKTREE_TYPES.has(msg.type)) {
    await handleGitWorktreeMessage(ctx, ws, msg, tabId, gitDir, workingDir);
    return;
  }

  const handlers: Record<string, () => Promise<void>> = {
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
    gitCheckout: () => handleGitCheckout(ctx, ws, msg, tabId, gitDir, workingDir),
    gitCreateBranch: () => handleGitCreateBranch(ctx, ws, msg, tabId, gitDir),
    gitDeleteBranch: () => handleGitDeleteBranch(ctx, ws, msg, tabId, gitDir),
    gitDiff: () => handleGitDiff(ctx, ws, msg, tabId, gitDir),
    gitShowCommit: () => handleGitShowCommit(ctx, ws, msg, tabId, gitDir),
    gitCommitDiff: () => handleGitCommitDiff(ctx, ws, msg, tabId, gitDir),
    gitListTags: () => handleGitListTags(ctx, ws, tabId, gitDir),
    gitCreateTag: () => handleGitCreateTag(ctx, ws, msg, tabId, gitDir),
    gitPushTag: () => handleGitPushTag(ctx, ws, msg, tabId, gitDir),
  };
  await handlers[msg.type]?.();
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

  if (!stageAll && paths) {
    const resolvedRoot = resolve(workingDir);
    for (const p of paths) {
      if (!resolve(workingDir, p).startsWith(resolvedRoot)) {
        ctx.send(ws, { type: 'gitError', tabId, data: { error: `Path traversal not allowed: ${p}` } });
        return;
      }
    }
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

const MAX_COMMIT_MESSAGE_LENGTH = 10_000;

async function handleGitCommit(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  const message = msg.data?.message as string | undefined;
  if (!message) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Commit message is required' } });
    return;
  }
  if (message.length > MAX_COMMIT_MESSAGE_LENGTH) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: `Commit message too long (${message.length} chars, max ${MAX_COMMIT_MESSAGE_LENGTH})` } });
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

/** Tabs currently generating an AI commit message. Prevents double-clicks
 *  from spawning two `claude` subprocesses for the same tab and clobbering
 *  the UI when the second response arrives. Module-scoped so it survives
 *  HandlerContext lifecycle (one process per CLI machine). */
const inflightCommitMessage = new Set<string>();

const haikuSucceeded = (r: HaikuResult): boolean => r.exitCode === 0 && r.stdout.trim().length > 0;
// rate_limit is terminal because a 500ms retry hits the same window the API
// expects you to wait ~60s on; retrying just doubles user-perceived latency
// before we surface the "wait a minute" message.
const RETRY_TERMINAL_REASONS = new Set(['binary_missing', 'auth', 'rate_limit']);

/** Run Haiku with one retry on transient failures. Logs each attempt. */
async function runHaikuForCommitMessage(
  prompt: string, systemPrompt: string, workingDir: string,
  meta: { tabId: string; startedAt: number; diffBytes: number },
): Promise<{ result: HaikuResult; attempts: number }> {
  let result = await spawnHaikuWithPrompt(prompt, systemPrompt, workingDir);
  if (haikuSucceeded(result)) return { result, attempts: 1 };

  const first = classifyHaikuFailure(result);
  if (RETRY_TERMINAL_REASONS.has(first.reason)) return { result, attempts: 1 };

  logCommitMessageEvent(workingDir, {
    tabId: meta.tabId, attempt: 1, success: false, reason: first.reason,
    exitCode: result.exitCode, timedOut: result.timedOut,
    stderrTail: (result.stderr || '').trim().slice(-500),
    latencyMs: Date.now() - meta.startedAt, diffBytes: meta.diffBytes, willRetry: true,
  });
  await new Promise(r => setTimeout(r, 500));
  result = await spawnHaikuWithPrompt(prompt, systemPrompt, workingDir);
  return { result, attempts: 2 };
}

async function handleGitCommitWithAI(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  if (inflightCommitMessage.has(tabId)) {
    // Drop the duplicate request silently — the user already has one in
    // flight. Surfacing "already generating" as a toast is noisier than
    // just ignoring the click.
    return;
  }
  inflightCommitMessage.add(tabId);
  const startedAt = Date.now();

  try {
    const statusResult = await executeGitCommand(['status', '--porcelain=v1'], workingDir);
    const { staged } = parseGitStatus(statusResult.stdout);

    if (staged.length === 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'No staged changes to commit' } });
      return;
    }

    const diffResult = await executeGitCommand(['diff', '--cached'], workingDir);
    const logResult = await executeGitCommand(['log', '--oneline', '-5'], workingDir);

    const recentCommits = logResult.stdout.trim() || 'No recent commits';
    const stagedFiles = staged.map(f => `${f.status} ${f.path}`).join('\n');
    const diff = truncateDiff(diffResult.stdout);
    const diffBytes = diffResult.stdout.length;

    const prompt = loadSkillPrompt('commit-message', { recentCommits, stagedFiles, diff }, workingDir)
      ?? `You are generating a git commit message for the following staged changes.\n\nRECENT COMMIT MESSAGES (for style reference):\n${recentCommits}\n\nSTAGED FILES:\n${stagedFiles}\n\nDIFF OF STAGED CHANGES:\n${diff}\n\nGenerate a commit message: imperative mood, max 72 characters, focus on "why". Respond with ONLY the commit message.`;

    const systemPrompt = 'You are a commit message assistant. Respond with only the commit message, no preamble or explanation.';

    const { result, attempts } = await runHaikuForCommitMessage(prompt, systemPrompt, workingDir, { tabId, startedAt, diffBytes });

    if (!haikuSucceeded(result)) {
      const failure = classifyHaikuFailure(result);
      logCommitMessageEvent(workingDir, {
        tabId, attempt: attempts, success: false, reason: failure.reason,
        exitCode: result.exitCode, timedOut: result.timedOut,
        stderrTail: (result.stderr || '').trim().slice(-500),
        latencyMs: Date.now() - startedAt, diffBytes,
      });
      console.error(`[git] commit-message failed (${failure.reason}):`, result.stderr || 'no stderr');
      ctx.send(ws, { type: 'gitError', tabId, data: { error: failure.userMessage } });
      return;
    }

    const commitMessage = extractCommitMessage(result.stdout.trim());
    const autoCommit = !!msg.data?.autoCommit;

    logCommitMessageEvent(workingDir, {
      tabId, attempt: attempts, success: true,
      latencyMs: Date.now() - startedAt, diffBytes, autoCommit,
      messageLength: commitMessage.length,
    });

    ctx.send(ws, { type: 'gitCommitMessage', tabId, data: { message: commitMessage, autoCommit } });

    if (autoCommit) {
      const commitResult = await executeGitCommand(['commit', '-m', commitMessage], workingDir);
      if (commitResult.exitCode !== 0) {
        ctx.send(ws, { type: 'gitError', tabId, data: { error: commitResult.stderr || commitResult.stdout || 'Failed to commit' } });
        return;
      }

      const hashResult = await executeGitCommand(['rev-parse', '--short', 'HEAD'], workingDir);
      ctx.send(ws, { type: 'gitCommitted', tabId, data: { hash: hashResult.stdout.trim(), message: commitMessage } });
      handleGitStatus(ctx, ws, tabId, workingDir);
    }
  } catch (error: unknown) {
    sendGitError(ctx, ws, tabId, error);
  } finally {
    inflightCommitMessage.delete(tabId);
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
