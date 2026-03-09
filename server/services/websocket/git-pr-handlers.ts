// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPrBaseBranch, setPrBaseBranch } from '../settings.js';
import { detectGitProvider, executeGitCommand, spawnCheck, spawnWithOutput, stripCoauthorLines } from './git-handlers.js';
import type { HandlerContext } from './handler-context.js';
import type { WebSocketMessage, WSContext } from './types.js';

export function handleGitPRMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, gitDir: string, _workingDir: string): void {
  const handlers: Record<string, () => void> = {
    gitGetRemoteInfo: () => handleGitGetRemoteInfo(ctx, ws, tabId, gitDir),
    gitCreatePR: () => handleGitCreatePR(ctx, ws, msg, tabId, gitDir),
    gitGeneratePRDescription: () => handleGitGeneratePRDescription(ctx, ws, msg, tabId, gitDir),
  };
  handlers[msg.type]?.();
}

async function handleGitGetRemoteInfo(ctx: HandlerContext, ws: WSContext, tabId: string, workingDir: string): Promise<void> {
  try {
    const remoteResult = await executeGitCommand(['remote', 'get-url', 'origin'], workingDir);
    if (remoteResult.exitCode !== 0) {
      ctx.send(ws, { type: 'gitRemoteInfo', tabId, data: { hasRemote: false } });
      return;
    }

    const remoteUrl = remoteResult.stdout.trim();
    const provider = detectGitProvider(remoteUrl);
    const defaultBranch = await getDefaultBranch(workingDir);
    const branchResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
    const currentBranch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : '';
    const cliStatus = await checkGitCliStatus(provider);
    const remoteBranches = await listRemoteBranches(workingDir);
    const preferredBaseBranch = getPrBaseBranch(remoteUrl) ?? undefined;

    ctx.send(ws, {
      type: 'gitRemoteInfo',
      tabId,
      data: {
        hasRemote: true,
        remoteUrl,
        provider,
        defaultBranch,
        currentBranch,
        ...cliStatus,
        remoteBranches,
        preferredBaseBranch,
      },
    });
  } catch (error: any) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error.message } });
  }
}

async function getDefaultBranch(workingDir: string): Promise<string> {
  const result = await executeGitCommand(
    ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
    workingDir
  );
  return result.exitCode === 0 ? result.stdout.trim().replace('origin/', '') : 'main';
}

async function checkGitCliStatus(provider: 'github' | 'gitlab' | 'unknown'): Promise<{ hasGhCli: boolean; ghCliAuthenticated: boolean; ghCliBinary?: 'gh' | 'glab' }> {
  const cliBin = provider === 'github' ? 'gh' : provider === 'gitlab' ? 'glab' : null;
  if (!cliBin) return { hasGhCli: false, ghCliAuthenticated: false };

  const installed = await spawnCheck(cliBin, ['--version']);
  if (!installed) return { hasGhCli: false, ghCliAuthenticated: false };

  const authenticated = await spawnCheck(cliBin, ['auth', 'status']);
  return { hasGhCli: true, ghCliAuthenticated: authenticated, ghCliBinary: cliBin };
}

async function listRemoteBranches(workingDir: string): Promise<string[]> {
  const result = await executeGitCommand(['branch', '-r', '--list', 'origin/*'], workingDir);
  if (result.exitCode !== 0) return [];

  return result.stdout.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.includes('->'))
    .map(line => line.replace('origin/', ''))
    .filter(Boolean)
    .sort();
}

/** Detect which CLI binary to use for PR creation based on remote URL */
function detectPRCliBin(remoteUrl: string): { cliBin: 'gh' | 'glab' | null; isGitHub: boolean; isGitLab: boolean } {
  const isGitHub = remoteUrl.includes('github.com');
  const isGitLab = remoteUrl.includes('gitlab.com') || remoteUrl.includes('gitlab');
  const cliBin = isGitHub ? 'gh' as const : isGitLab ? 'glab' as const : null;
  return { cliBin, isGitHub, isGitLab };
}

/** Send PR success and optionally persist base branch */
function sendPRCreated(
  ctx: HandlerContext, ws: WSContext, tabId: string, url: string, method: string,
  remoteUrl: string, baseBranch?: string,
): void {
  if (baseBranch) setPrBaseBranch(remoteUrl, baseBranch);
  ctx.send(ws, { type: 'gitPRCreated', tabId, data: { url, method } });
}

async function handleGitCreatePR(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  const { title, body, baseBranch, draft } = msg.data ?? {};

  if (!title) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: 'PR title is required' } });
    return;
  }

  try {
    const branchResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
    if (branchResult.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Failed to detect current branch' } });
      return;
    }

    const remoteResult = await executeGitCommand(['remote', 'get-url', 'origin'], workingDir);
    if (remoteResult.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'No remote origin configured' } });
      return;
    }

    const headBranch = branchResult.stdout.trim();
    const remoteUrl = remoteResult.stdout.trim();
    const { cliBin, isGitHub, isGitLab } = detectPRCliBin(remoteUrl);

    // Auto-push if branch has unpushed commits or no upstream
    const upstreamCheck = await executeGitCommand(['rev-parse', '--abbrev-ref', `${headBranch}@{u}`], workingDir);
    const hasUpstream = upstreamCheck.exitCode === 0;
    let needsPush = !hasUpstream;

    if (hasUpstream) {
      const aheadCheck = await executeGitCommand(['rev-list', '--count', `@{u}..HEAD`], workingDir);
      needsPush = aheadCheck.exitCode === 0 && parseInt(aheadCheck.stdout.trim(), 10) > 0;
    }

    if (needsPush) {
      const pushArgs = hasUpstream ? ['push'] : ['push', '-u', 'origin', headBranch];
      const pushResult = await executeGitCommand(pushArgs, workingDir);
      if (pushResult.exitCode !== 0) {
        ctx.send(ws, { type: 'gitError', tabId, data: { error: `Failed to push branch before creating PR: ${pushResult.stderr || pushResult.stdout}` } });
        return;
      }
    }

    const cliResult = await tryCliPRCreate(cliBin, { title, body, baseBranch, draft, headBranch }, workingDir);

    if (cliResult.created) {
      sendPRCreated(ctx, ws, tabId, cliResult.url!, isGitHub ? 'gh' : 'glab', remoteUrl, baseBranch);
      return;
    }
    if (cliResult.error) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: cliResult.error } });
      return;
    }

    const prUrl = buildBrowserPRUrl(remoteUrl, headBranch, baseBranch, title, body, isGitHub, isGitLab);
    if (prUrl) {
      sendPRCreated(ctx, ws, tabId, prUrl, 'browser', remoteUrl, baseBranch);
    } else {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Could not determine remote URL format for PR creation' } });
    }
  } catch (error: any) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error.message } });
  }
}

/** Attempt to create a PR/MR via CLI. Returns { created, url, error } */
async function tryCliPRCreate(
  cliBin: 'gh' | 'glab' | null,
  opts: { title: string; body?: string; baseBranch?: string; draft?: boolean; headBranch: string },
  workingDir: string,
): Promise<{ created: boolean; url?: string; error?: string }> {
  if (!cliBin) return { created: false };

  const installed = await spawnCheck(cliBin, ['--version']);
  if (!installed) return { created: false };

  const args = cliBin === 'gh'
    ? ['pr', 'create', '--title', opts.title]
    : ['mr', 'create', '--title', opts.title, '--yes'];

  if (opts.body) args.push('--body', opts.body);
  if (opts.baseBranch) {
    args.push(cliBin === 'gh' ? '--base' : '--target-branch', opts.baseBranch);
  }
  if (opts.draft) args.push('--draft');

  const result = await spawnWithOutput(cliBin, args, workingDir);

  if (result.exitCode === 0) {
    const urlMatch = result.stdout.match(/https?:\/\/\S+/);
    return { created: true, url: urlMatch ? urlMatch[0] : result.stdout.trim() };
  }

  return { created: false, error: classifyCliPRError(cliBin, result, opts.headBranch) };
}

/** Classify a CLI PR creation error into a user-facing message */
function classifyCliPRError(
  cliBin: string,
  result: { stdout: string; stderr: string },
  headBranch: string,
): string {
  const combined = result.stderr + result.stdout;
  const lower = combined.toLowerCase();

  if (lower.includes('already exists')) {
    const existingUrl = combined.match(/https?:\/\/\S+/);
    return existingUrl
      ? `A pull request already exists for ${headBranch}: ${existingUrl[0]}`
      : `A pull request already exists for ${headBranch}`;
  }

  if (lower.includes('auth') || lower.includes('401') || lower.includes('token') || lower.includes('log in')) {
    return `${cliBin} is not authenticated. Run: ${cliBin} auth login`;
  }

  if (lower.includes('must first push') || lower.includes('failed to push') || lower.includes('no upstream')) {
    return `Branch "${headBranch}" has not been pushed to remote. Push first, then create the PR.`;
  }

  return `${cliBin} failed: ${(result.stderr || result.stdout).trim()}`;
}

/** Build a browser URL for PR creation (fallback when no CLI) */
function buildBrowserPRUrl(
  remoteUrl: string, headBranch: string, baseBranch: string | undefined,
  title: string, body: string | undefined, isGitHub: boolean, isGitLab: boolean,
): string {
  const sshMatch = remoteUrl.match(/[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!sshMatch) return '';

  const [, owner, repo] = sshMatch;
  const base = baseBranch || 'main';

  if (isGitHub) {
    return `https://github.com/${owner}/${repo}/compare/${base}...${headBranch}?expand=1&title=${encodeURIComponent(title)}${body ? `&body=${encodeURIComponent(body)}` : ''}`;
  }
  if (isGitLab) {
    return `https://gitlab.com/${owner}/${repo}/-/merge_requests/new?merge_request[source_branch]=${headBranch}&merge_request[target_branch]=${base}&merge_request[title]=${encodeURIComponent(title)}`;
  }
  return '';
}

async function handleGitGeneratePRDescription(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  const baseBranch = msg.data?.baseBranch || 'main';

  try {
    // Use origin/ prefix to compare against remote base branch (what a PR actually compares against).
    // Fall back to local branch name if the remote ref doesn't exist.
    const remoteBase = `origin/${baseBranch}`;
    const remoteRefCheck = await executeGitCommand(['rev-parse', '--verify', remoteBase], workingDir);
    const compareRef = remoteRefCheck.exitCode === 0 ? remoteBase : baseBranch;

    const logResult = await executeGitCommand(['log', `${compareRef}..HEAD`, '--oneline'], workingDir);
    const commits = logResult.exitCode === 0 ? logResult.stdout.trim() : '';

    if (!commits) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: `No commits found between ${baseBranch} and HEAD` } });
      return;
    }

    const diffResult = await executeGitCommand(['diff', `${compareRef}...HEAD`], workingDir);
    const diff = diffResult.exitCode === 0 ? diffResult.stdout : '';

    const statResult = await executeGitCommand(['diff', `${compareRef}...HEAD`, '--stat'], workingDir);
    const stat = statResult.exitCode === 0 ? statResult.stdout.trim() : '';

    let truncatedDiff = diff;
    if (diff.length > 8000) {
      truncatedDiff = `${diff.slice(0, 4000)}\n\n... [diff truncated] ...\n\n${diff.slice(-3500)}`;
    }

    const tempDir = join(workingDir, '.mstro', 'tmp');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    const prompt = `You are generating a pull request title and description for the following changes.

COMMITS (${baseBranch}..HEAD):
${commits}

FILES CHANGED:
${stat}

DIFF:
${truncatedDiff}

Generate a pull request title and description following these rules:
1. TITLE: First line must be the PR title — imperative mood, under 70 characters
2. Leave a blank line after the title
3. BODY: Write a concise description in markdown with:
   - A "## Summary" section with 1-3 bullet points explaining what changed and why
   - Optionally a "## Details" section if the changes are complex
4. Focus on the "why" not just the "what"
5. No emojis

Respond with ONLY the title and description, nothing else.`;

    const promptFile = join(tempDir, `pr-desc-${Date.now()}.txt`);
    writeFileSync(promptFile, prompt);

    const systemPrompt = 'You are a pull request description assistant. Respond with only the PR title and description, no preamble or explanation.';

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

    claude.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    claude.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    claude.on('close', (code: number | null) => {
      try { unlinkSync(promptFile); } catch { /* ignore */ }

      if (code !== 0 || !stdout.trim()) {
        console.error('[WebSocketImproviseHandler] Claude PR description error:', stderr || 'No output');
        ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Failed to generate PR description' } });
        return;
      }

      const output = stripCoauthorLines(stdout.trim());
      const lines = output.split('\n');
      const title = lines[0].trim();
      const body = lines.slice(1).join('\n').trim();

      ctx.send(ws, { type: 'gitPRDescription', tabId, data: { title, body } });
    });

    claude.on('error', (err: Error) => {
      console.error('[WebSocketImproviseHandler] Failed to spawn Claude for PR description:', err);
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Failed to generate PR description' } });
    });

    setTimeout(() => { claude.kill(); }, 30000);

  } catch (error: any) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error.message } });
  }
}
