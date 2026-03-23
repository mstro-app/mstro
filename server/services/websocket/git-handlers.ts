// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleGitPRMessage } from './git-pr-handlers.js';
import { handleGitWorktreeMessage } from './git-worktree-handlers.js';
import type { HandlerContext } from './handler-context.js';
import type { GitBranchEntry, GitDirectorySetResponse, GitFileStatus, GitLogEntry, GitRepoInfo, GitReposDiscoveredResponse, GitStatusResponse, GitTagEntry, WebSocketMessage, WSContext } from './types.js';

/** Detect git provider from remote URL */
export function detectGitProvider(remoteUrl: string): 'github' | 'gitlab' | 'unknown' {
  if (remoteUrl.includes('github.com')) return 'github';
  if (remoteUrl.includes('gitlab.com') || remoteUrl.includes('gitlab')) return 'gitlab';
  return 'unknown';
}

/** Execute a git command and return stdout */
export function executeGitCommand(args: string[], workingDir: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const git = spawn('git', args, {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    git.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    git.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    git.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    git.on('error', (err: Error) => {
      resolve({ stdout: '', stderr: err.message, exitCode: 1 });
    });
  });
}

/** Map of simple escape sequences to their character values */
const ESCAPE_CHARS: Record<string, string> = {
  '\\': '\\',
  '"': '"',
  'n': '\n',
  't': '\t',
  'r': '\r',
};

/** Check if position i starts an octal escape sequence (\nnn) */
function isOctalEscape(str: string, i: number): boolean {
  return i + 3 < str.length &&
    /[0-7]/.test(str[i + 1]) &&
    /[0-7]{2}/.test(str.slice(i + 2, i + 4));
}

/**
 * Unquote a git-quoted path (C-style quoting)
 */
export function unquoteGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) {
    return path;
  }

  const inner = path.slice(1, -1);
  let result = '';
  let i = 0;

  while (i < inner.length) {
    if (inner[i] !== '\\' || i + 1 >= inner.length) {
      result += inner[i];
      i++;
      continue;
    }

    const next = inner[i + 1];
    const escaped = ESCAPE_CHARS[next];

    if (escaped !== undefined) {
      result += escaped;
      i += 2;
    } else if (isOctalEscape(inner, i)) {
      result += String.fromCharCode(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 4;
    } else {
      result += inner[i];
      i++;
    }
  }

  return result;
}

/** Parse git status --porcelain output into structured format */
export function parseGitStatus(porcelainOutput: string): { staged: GitFileStatus[]; unstaged: GitFileStatus[]; untracked: GitFileStatus[] } {
  const staged: GitFileStatus[] = [];
  const unstaged: GitFileStatus[] = [];
  const untracked: GitFileStatus[] = [];

  const lines = porcelainOutput.split('\n').filter(line => line.length >= 4);

  for (const line of lines) {
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const rawPath = line.slice(3);

    const path = unquoteGitPath(rawPath);

    let filePath = path;
    let originalPath: string | undefined;
    if (rawPath.includes(' -> ')) {
      const parts = rawPath.split(' -> ');
      originalPath = unquoteGitPath(parts[0]);
      filePath = unquoteGitPath(parts[1]);
    }

    if (indexStatus === '?' && workTreeStatus === '?') {
      untracked.push({ path: filePath, status: '?', staged: false });
      continue;
    }

    if (indexStatus !== ' ' && indexStatus !== '?') {
      staged.push({ path: filePath, status: indexStatus as GitFileStatus['status'], staged: true, originalPath });
    }

    if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
      unstaged.push({ path: filePath, status: workTreeStatus as GitFileStatus['status'], staged: false, originalPath });
    }
  }

  return { staged, unstaged, untracked };
}

/** Check if a binary runs successfully (exit code 0) */
export function spawnCheck(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/** Spawn a process and capture stdout/stderr */
export function spawnWithOutput(bin: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    proc.on('error', (err: Error) => resolve({ stdout: '', stderr: err.message, exitCode: 1 }));
  });
}

/**
 * Strip injected coauthor/attribution lines from a commit message.
 */
export function stripCoauthorLines(message: string): string {
  const lines = message.split('\n');
  const markers = ['co-authored', 'authored-by', 'haiku', 'noreply@anthropic.com'];
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (markers.some(m => lower.includes(m))) {
      if (result.length > 0 && result[result.length - 1].trim() === '') {
        result.pop();
      }
      continue;
    }
    result.push(lines[i]);
  }
  if (result.length === 0) return '';
  return result.join('\n').trimEnd();
}

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
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
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
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
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
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
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
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
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
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
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
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
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
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitLog(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  const limit = msg.data?.limit ?? 10;

  try {
    const result = await executeGitCommand([
      'log',
      `-${limit}`,
      '--format=%H|%h|%s|%an|%aI'
    ], workingDir);

    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || result.stdout || 'Failed to get log' } });
      return;
    }

    const entries: GitLogEntry[] = result.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, shortHash, subject, author, date] = line.split('|');
      const cleanSubject = stripCoauthorLines(subject || '') || subject || '';
      return { hash, shortHash, subject: cleanSubject, author, date };
    });

    ctx.send(ws, { type: 'gitLog', tabId, data: { entries } });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

/** Directories to skip when scanning for git repos */
const SKIP_DIRS = ['node_modules', 'vendor', '.git'];

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.includes(name);
}

async function getRepoBranch(repoPath: string): Promise<string | undefined> {
  const result = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

async function scanForGitRepos(dir: string, depth: number, maxDepth: number, repos: GitRepoInfo[]): Promise<void> {
  if (depth > maxDepth) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (shouldSkipDir(name)) continue;

    const fullPath = join(dir, name);
    const gitPath = join(fullPath, '.git');

    if (existsSync(gitPath)) {
      repos.push({ path: fullPath, name, branch: await getRepoBranch(fullPath) });
    } else {
      await scanForGitRepos(fullPath, depth + 1, maxDepth, repos);
    }
  }
}

async function handleGitDiscoverRepos(ctx: HandlerContext, ws: WSContext, tabId: string, workingDir: string): Promise<void> {
  try {
    const repos: GitRepoInfo[] = [];
    const rootIsGitRepo = existsSync(join(workingDir, '.git'));

    if (rootIsGitRepo) {
      repos.push({
        path: workingDir,
        name: workingDir.split('/').pop() || workingDir,
        branch: await getRepoBranch(workingDir),
      });
    } else {
      await scanForGitRepos(workingDir, 1, 3, repos);
    }

    const response: GitReposDiscoveredResponse = {
      repos,
      rootIsGitRepo,
      selectedDirectory: ctx.gitDirectories.get(tabId) || null,
    };

    ctx.send(ws, { type: 'gitReposDiscovered', tabId, data: response });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitSetDirectory(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  const directory = msg.data?.directory as string | undefined;

  if (!directory) {
    ctx.gitDirectories.delete(tabId);
    const response: GitDirectorySetResponse = {
      directory: workingDir,
      isValid: existsSync(join(workingDir, '.git')),
    };
    ctx.send(ws, { type: 'gitDirectorySet', tabId, data: response });
    handleGitStatus(ctx, ws, tabId, workingDir);
    return;
  }

  const gitPath = join(directory, '.git');
  const isValid = existsSync(gitPath);

  if (isValid) {
    ctx.gitDirectories.set(tabId, directory);
  }

  const response: GitDirectorySetResponse = {
    directory,
    isValid,
  };

  ctx.send(ws, { type: 'gitDirectorySet', tabId, data: response });

  if (isValid) {
    handleGitStatus(ctx, ws, tabId, directory);
    handleGitLog(ctx, ws, { type: 'gitLog', data: { limit: 5 } }, tabId, directory);
  }
}

async function handleGitListBranches(ctx: HandlerContext, ws: WSContext, tabId: string, workingDir: string): Promise<void> {
  try {
    const result = await executeGitCommand(
      ['branch', '-a', '--format=%(refname:short)|%(objectname:short)|%(upstream:short)|%(HEAD)'],
      workingDir
    );
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to list branches' } });
      return;
    }

    const currentBranchResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
    const currentBranch = currentBranchResult.stdout.trim() || 'HEAD';

    const branches: GitBranchEntry[] = result.stdout.trim().split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [name, shortHash, upstream, head] = line.split('|');
        const isRemote = name.includes('/') && (name.startsWith('origin/') || name.includes('remotes/'));
        return {
          name: name.trim(),
          shortHash: shortHash?.trim() || '',
          isRemote,
          isCurrent: head?.trim() === '*',
          upstream: upstream?.trim() || undefined,
        };
      })
      .filter(b => b.name !== 'origin/HEAD');

    ctx.send(ws, { type: 'gitBranchList', tabId, data: { branches, current: currentBranch } });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitCheckout(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { branch, create, startPoint } = msg.data || {};
    if (!branch) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Branch name is required' } });
      return;
    }

    const statusResult = await executeGitCommand(['status', '--porcelain'], workingDir);
    if (statusResult.stdout.trim()) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Commit or stash changes before switching branches' } });
      return;
    }

    const prevResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
    const previous = prevResult.stdout.trim();

    const args = create
      ? ['checkout', '-b', branch, ...(startPoint ? [startPoint] : [])]
      : ['checkout', branch];

    const result = await executeGitCommand(args, workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to checkout branch' } });
      return;
    }

    ctx.send(ws, { type: 'gitCheckedOut', tabId, data: { branch, previous } });
    handleGitStatus(ctx, ws, tabId, workingDir);
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitCreateBranch(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { name, startPoint, checkout } = msg.data || {};
    if (!name) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Branch name is required' } });
      return;
    }

    const args = ['branch', name, ...(startPoint ? [startPoint] : [])];
    const result = await executeGitCommand(args, workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to create branch' } });
      return;
    }

    const hashResult = await executeGitCommand(['rev-parse', '--short', name], workingDir);

    if (checkout) {
      await executeGitCommand(['checkout', name], workingDir);
    }

    ctx.send(ws, { type: 'gitBranchCreated', tabId, data: { name, hash: hashResult.stdout.trim() } });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitDeleteBranch(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { name, force } = msg.data || {};
    if (!name) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Branch name is required' } });
      return;
    }

    const currentResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
    if (currentResult.stdout.trim() === name) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Cannot delete the currently checked out branch' } });
      return;
    }

    const result = await executeGitCommand(['branch', force ? '-D' : '-d', name], workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to delete branch' } });
      return;
    }

    ctx.send(ws, { type: 'gitBranchDeleted', tabId, data: { name } });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitDiff(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { path, staged } = msg.data || {};
    if (!path) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'File path is required' } });
      return;
    }

    const originalResult = await executeGitCommand(['show', `HEAD:${path}`], workingDir);
    const original = originalResult.exitCode === 0 ? originalResult.stdout : '';

    let modified: string;
    if (staged) {
      const indexResult = await executeGitCommand(['show', `:${path}`], workingDir);
      modified = indexResult.exitCode === 0 ? indexResult.stdout : '';
    } else {
      const fullPath = join(workingDir, path);
      try {
        modified = readFileSync(fullPath, 'utf-8');
      } catch {
        modified = '';
      }
    }

    ctx.send(ws, {
      type: 'gitDiffResult',
      tabId,
      data: { path, original, modified, staged: !!staged },
    });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitListTags(ctx: HandlerContext, ws: WSContext, tabId: string, workingDir: string): Promise<void> {
  try {
    const result = await executeGitCommand(
      ['tag', '-l', '--sort=-creatordate', '--format=%(refname:short)|%(objectname:short)|%(creatordate:iso-strict)|%(subject)'],
      workingDir
    );
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to list tags' } });
      return;
    }

    const tags: GitTagEntry[] = result.stdout.trim().split('\n')
      .filter(line => line.trim())
      .slice(0, 50)
      .map(line => {
        const parts = line.split('|');
        return {
          name: parts[0]?.trim() || '',
          shortHash: parts[1]?.trim() || '',
          date: parts[2]?.trim() || '',
          message: parts[3]?.trim() || '',
        };
      });

    ctx.send(ws, { type: 'gitTagList', tabId, data: { tags } });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitCreateTag(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { name, message, commit } = msg.data || {};
    if (!name) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Tag name is required' } });
      return;
    }

    if (/\s/.test(name) || name.includes('..')) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Invalid tag name: no spaces or ".." allowed' } });
      return;
    }

    const args = message
      ? ['tag', '-a', name, '-m', message, ...(commit ? [commit] : [])]
      : ['tag', name, ...(commit ? [commit] : [])];

    const result = await executeGitCommand(args, workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to create tag' } });
      return;
    }

    const hashResult = await executeGitCommand(['rev-parse', '--short', name], workingDir);
    ctx.send(ws, { type: 'gitTagCreated', tabId, data: { name, hash: hashResult.stdout.trim() } });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitPushTag(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { name, all } = msg.data || {};

    const args = all
      ? ['push', 'origin', '--tags']
      : ['push', 'origin', name];

    if (!all && !name) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Tag name is required' } });
      return;
    }

    const result = await executeGitCommand(args, workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to push tag' } });
      return;
    }

    ctx.send(ws, { type: 'gitTagPushed', tabId, data: { name: name || 'all', output: result.stderr || result.stdout } });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}
