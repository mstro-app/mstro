// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { loadSkillPrompt } from '../plan/agent-loader.js';
import { getPrBaseBranch, setPrBaseBranch } from '../settings.js';
import { detectGitProvider, executeGitCommand, spawnCheck, spawnHaikuWithPrompt, spawnWithOutput, stripCoauthorLines, truncateDiff } from './git-handlers.js';
import type { HandlerContext } from './handler-context.js';
import type { WebSocketMessage, WSContext } from './types.js';

export async function handleGitPRMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, gitDir: string, _workingDir: string): Promise<void> {
  const handlers: Record<string, () => Promise<void>> = {
    gitGetRemoteInfo: () => handleGitGetRemoteInfo(ctx, ws, tabId, gitDir),
    gitCreatePR: () => handleGitCreatePR(ctx, ws, msg, tabId, gitDir),
    gitGeneratePRDescription: () => handleGitGeneratePRDescription(ctx, ws, msg, tabId, gitDir),
  };
  await handlers[msg.type]?.();
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
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
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

/** Auto-push branch if it has unpushed commits or no upstream. Returns error string on failure. */
async function ensureBranchPushed(headBranch: string, workingDir: string): Promise<string | null> {
  const upstreamCheck = await executeGitCommand(['rev-parse', '--abbrev-ref', `${headBranch}@{u}`], workingDir);
  const hasUpstream = upstreamCheck.exitCode === 0;
  let needsPush = !hasUpstream;

  if (hasUpstream) {
    const aheadCheck = await executeGitCommand(['rev-list', '--count', `@{u}..HEAD`], workingDir);
    needsPush = aheadCheck.exitCode === 0 && parseInt(aheadCheck.stdout.trim(), 10) > 0;
  }

  if (!needsPush) return null;

  const pushArgs = hasUpstream ? ['push'] : ['push', '-u', 'origin', headBranch];
  const pushResult = await executeGitCommand(pushArgs, workingDir);
  if (pushResult.exitCode !== 0) {
    return `Failed to push branch before creating PR: ${pushResult.stderr || pushResult.stdout}`;
  }
  return null;
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

    const pushError = await ensureBranchPushed(headBranch, workingDir);
    if (pushError) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: pushError } });
      return;
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
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
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
    const statResult = await executeGitCommand(['diff', `${compareRef}...HEAD`, '--stat'], workingDir);

    const filesChanged = statResult.exitCode === 0 ? statResult.stdout.trim() : '';
    const diff = truncateDiff(diffResult.exitCode === 0 ? diffResult.stdout : '');

    const prompt = loadSkillPrompt('pr-description', { baseBranch, commits, filesChanged, diff }, workingDir)
      ?? `You are generating a pull request title and description.\n\nCOMMITS (${baseBranch}..HEAD):\n${commits}\n\nFILES CHANGED:\n${filesChanged}\n\nDIFF:\n${diff}\n\nGenerate PR title (imperative, <70 chars) then body with ## Summary (1-3 bullets). No emojis. Respond with ONLY the title and description.`;

    const result = await spawnHaikuWithPrompt(
      prompt,
      'You are a pull request description assistant. Respond with only the PR title and description, no preamble or explanation.',
      workingDir,
    );

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      console.error('[WebSocketImproviseHandler] Claude PR description error:', result.stderr || 'No output');
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Failed to generate PR description' } });
      return;
    }

    const output = stripCoauthorLines(result.stdout.trim());
    const lines = output.split('\n');
    const title = lines[0].trim();
    const body = lines.slice(1).join('\n').trim();

    ctx.send(ws, { type: 'gitPRDescription', tabId, data: { title, body } });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}
