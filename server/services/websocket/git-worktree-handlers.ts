// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolvePmDir } from '../plan/parser.js';
import type { Workspace } from '../plan/types.js';
import { executeGitCommand, handleGitStatus, spawnWithOutput } from './git-handlers.js';
import { handleGitLog } from './git-log-handlers.js';
import { parseGitStatus } from './git-utils.js';
import type { HandlerContext } from './handler-context.js';
import type { GitFileStatus, WebSocketMessage, WorktreeInfo, WSContext } from './types.js';

/**
 * A file in the merge target's working tree whose uncommitted state would be
 * lost if the merge proceeds. Used to drive the merge dialog's blocker state
 * before the merge attempt and to translate the post-flight git error if a
 * race lets one slip through.
 */
interface MergeBlocker {
  path: string;
  status: GitFileStatus['status'];
  staged: boolean;
}

function persistBoardWorktree(workingDir: string, boardId: string, worktreePath: string | null, branch: string | null): void {
  const pmDir = resolvePmDir(workingDir);
  if (!pmDir) return;
  const wsPath = join(pmDir, 'workspace.json');
  if (!existsSync(wsPath)) return;
  try {
    const workspace: Workspace = JSON.parse(readFileSync(wsPath, 'utf-8'));
    if (!workspace.boardWorktrees) workspace.boardWorktrees = {};
    if (worktreePath && branch) {
      workspace.boardWorktrees[boardId] = { path: worktreePath, branch };
    } else {
      delete workspace.boardWorktrees[boardId];
    }
    writeFileSync(wsPath, JSON.stringify(workspace, null, 2), 'utf-8');
  } catch { /* non-fatal */ }
}

function isBoardId(id: string): boolean {
  return id.startsWith('BOARD-');
}

export async function handleGitWorktreeMessage(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, gitDir: string, workingDir: string): Promise<void> {
  const handlers: Record<string, () => Promise<void>> = {
    gitWorktreeList: () => handleGitWorktreeList(ctx, ws, tabId, gitDir),
    gitWorktreeCreate: () => handleGitWorktreeCreate(ctx, ws, msg, tabId, gitDir),
    gitWorktreeCreateAndAssign: () => handleGitWorktreeCreateAndAssign(ctx, ws, msg, tabId, gitDir, workingDir),
    gitWorktreeRemove: () => handleGitWorktreeRemove(ctx, ws, msg, tabId, gitDir),
    tabWorktreeSwitch: () => handleTabWorktreeSwitch(ctx, ws, msg, tabId, workingDir),
    gitWorktreePush: () => handleGitWorktreePush(ctx, ws, msg, tabId, gitDir),
    gitWorktreeCreatePR: () => handleGitWorktreeCreatePR(ctx, ws, msg, tabId, gitDir),
    gitMergePreview: () => handleGitMergePreview(ctx, ws, msg, tabId, gitDir),
    gitWorktreeMerge: () => handleGitWorktreeMerge(ctx, ws, msg, tabId, gitDir),
    gitMergeAbort: () => handleGitMergeAbort(ctx, ws, tabId, gitDir),
    gitMergeComplete: () => handleGitMergeComplete(ctx, ws, msg, tabId, gitDir),
    gitMergeStashPop: () => handleGitMergeStashPop(ctx, ws, msg, tabId, gitDir),
    gitMergeDiscardBlockers: () => handleGitMergeDiscardBlockers(ctx, ws, msg, tabId, gitDir),
  };
  await handlers[msg.type]?.();
}

function applyWorktreePorcelainLine(line: string, worktrees: WorktreeInfo[], current: Partial<WorktreeInfo>): Partial<WorktreeInfo> {
  if (line.startsWith('worktree ')) {
    if (current.path) worktrees.push(current as WorktreeInfo);
    return { path: line.slice(9).trim(), isMain: false, isBare: false };
  }
  if (line.startsWith('HEAD ')) current.head = line.slice(5).trim();
  else if (line.startsWith('branch ')) current.branch = line.slice(7).trim().replace('refs/heads/', '');
  else if (line === 'bare') current.isBare = true;
  else if (line === 'prunable') current.prunable = true;
  return current;
}

function parseWorktreePorcelain(stdout: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of stdout.split('\n')) {
    current = applyWorktreePorcelainLine(line, worktrees, current);
  }
  if (current.path) worktrees.push(current as WorktreeInfo);
  if (worktrees.length > 0) worktrees[0].isMain = true;
  return worktrees;
}

async function handleGitWorktreeList(ctx: HandlerContext, ws: WSContext, tabId: string, workingDir: string): Promise<void> {
  try {
    const result = await executeGitCommand(['worktree', 'list', '--porcelain'], workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to list worktrees' } });
      return;
    }
    const worktrees = parseWorktreePorcelain(result.stdout);
    ctx.send(ws, { type: 'gitWorktreeListResult', tabId, data: { worktrees } });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitWorktreeCreate(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { branchName, baseBranch, path: worktreePath } = msg.data || {};
    if (!branchName) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Branch name is required' } });
      return;
    }

    const repoName = workingDir.split('/').pop() || 'repo';
    const wtPath = worktreePath || join(dirname(workingDir), `${repoName}-worktrees`, branchName);

    const args = ['worktree', 'add', wtPath, '-b', branchName, ...(baseBranch ? [baseBranch] : [])];
    const result = await executeGitCommand(args, workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to create worktree' } });
      return;
    }

    const headResult = await executeGitCommand(['rev-parse', '--short', 'HEAD'], wtPath);

    ctx.send(ws, {
      type: 'gitWorktreeCreated',
      tabId,
      data: { path: wtPath, branch: branchName, head: headResult.stdout.trim() },
    });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitWorktreeCreateAndAssign(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, gitDir: string, workingDir: string): Promise<void> {
  try {
    const { branchName, baseBranch, path: worktreePath } = msg.data || {};
    if (!branchName) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Branch name is required' } });
      return;
    }

    const repoName = gitDir.split('/').pop() || 'repo';
    const wtPath = worktreePath || join(dirname(gitDir), `${repoName}-worktrees`, branchName);

    const args = ['worktree', 'add', wtPath, '-b', branchName, ...(baseBranch ? [baseBranch] : [])];
    const result = await executeGitCommand(args, gitDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to create worktree' } });
      return;
    }

    const headResult = await executeGitCommand(['rev-parse', '--short', 'HEAD'], wtPath);

    // Assign to tab
    ctx.gitDirectories.set(tabId, wtPath);
    ctx.gitBranches.set(tabId, branchName);
    const registry = ctx.getRegistry(workingDir);
    registry.updateTabWorktree(tabId, wtPath, branchName);
    if (isBoardId(tabId)) {
      persistBoardWorktree(workingDir, tabId, wtPath, branchName);
    }

    ctx.send(ws, {
      type: 'gitWorktreeCreatedAndAssigned',
      tabId,
      data: { tabId, path: wtPath, branch: branchName, head: headResult.stdout.trim() },
    });

    handleGitStatus(ctx, ws, tabId, wtPath);
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

function cleanupWorktreeReferences(ctx: HandlerContext, workingDir: string, wtPath: string): void {
  const resolvedWtPath = join(wtPath);
  for (const [tid, dir] of ctx.gitDirectories) {
    if (dir === resolvedWtPath || dir === wtPath) {
      ctx.gitDirectories.delete(tid);
      ctx.gitBranches.delete(tid);
      if (isBoardId(tid)) persistBoardWorktree(workingDir, tid, null, null);
    }
  }
}

async function handleGitWorktreeRemove(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { path: wtPath, force, deleteBranch } = msg.data || {};
    if (!wtPath) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Worktree path is required' } });
      return;
    }

    let branchToDelete: string | undefined;
    if (deleteBranch) {
      const branchResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath);
      branchToDelete = branchResult.stdout.trim();
    }

    const args = force ? ['worktree', 'remove', '--force', wtPath] : ['worktree', 'remove', wtPath];
    const result = await executeGitCommand(args, workingDir);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to remove worktree' } });
      return;
    }

    if (branchToDelete && deleteBranch) {
      await executeGitCommand(['branch', '-d', branchToDelete], workingDir);
    }

    await executeGitCommand(['worktree', 'prune'], workingDir);
    cleanupWorktreeReferences(ctx, workingDir, wtPath);

    ctx.send(ws, { type: 'gitWorktreeRemoved', tabId, data: { path: wtPath } });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

export async function handleTabWorktreeSwitch(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { tabId: targetTabId, worktreePath } = msg.data || {};
    const resolvedTabId = targetTabId || tabId;
    const registry = ctx.getRegistry(workingDir);
    if (!worktreePath) {
      ctx.gitDirectories.delete(resolvedTabId);
      ctx.gitBranches.delete(resolvedTabId);
      registry.updateTabWorktree(resolvedTabId, null, null);
      if (isBoardId(resolvedTabId)) {
        persistBoardWorktree(workingDir, resolvedTabId, null, null);
      }
      ctx.send(ws, { type: 'tabWorktreeSwitched', tabId: resolvedTabId, data: { tabId: resolvedTabId, worktreePath: null, branch: null } });
      refreshScopeAfterWorktreeSwitch(ctx, ws, resolvedTabId, workingDir);
      return;
    }

    ctx.gitDirectories.set(resolvedTabId, worktreePath);

    const branchResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
    const branch = branchResult.stdout.trim();
    ctx.gitBranches.set(resolvedTabId, branch);
    registry.updateTabWorktree(resolvedTabId, worktreePath, branch);
    if (isBoardId(resolvedTabId)) {
      persistBoardWorktree(workingDir, resolvedTabId, worktreePath, branch);
    }

    ctx.send(ws, { type: 'tabWorktreeSwitched', tabId: resolvedTabId, data: { tabId: resolvedTabId, worktreePath, branch } });
    refreshScopeAfterWorktreeSwitch(ctx, ws, resolvedTabId, worktreePath);
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

/**
 * After a worktree switch, re-fetch everything that's worktree-specific so
 * the client sees a complete, consistent view of the newly-selected workspace
 * from a single `tabWorktreeSwitched` event. Keeping the refresh on the
 * server side means the client has one signal to react to instead of having
 * to orchestrate status/log/... fetches itself.
 *
 * Branches and the worktree list are NOT re-fetched: they're repo-wide, not
 * worktree-specific.
 *
 * Fire-and-forget: the switch itself has already been acknowledged via
 * `tabWorktreeSwitched`. `handleGitStatus` and `handleGitLog` each own their
 * own error handling (they send `gitError` scoped to the correct tabId).
 * Awaiting here would let any unexpected throw escape into the caller's
 * outer try/catch and produce a misleading `gitError` on the original
 * dispatch tabId after success has already been signalled.
 */
function refreshScopeAfterWorktreeSwitch(ctx: HandlerContext, ws: WSContext, tabId: string, gitDir: string): void {
  (async () => {
    await handleGitStatus(ctx, ws, tabId, gitDir);
    await handleGitLog(ctx, ws, { type: 'gitLog', tabId, data: { limit: 20 } }, tabId, gitDir);
  })().catch((error: unknown) => {
    console.error('[handleTabWorktreeSwitch] scope refresh failed:', error);
  });
}

async function pushWithUpstreamRetry(
  worktreePath: string,
  pushRemote: string,
  pushBranch: string,
  setUpstream: boolean,
): Promise<{ exitCode: number; output: string; error: string }> {
  const args = setUpstream
    ? ['push', '--set-upstream', pushRemote, pushBranch]
    : ['push', pushRemote, pushBranch];

  const result = await executeGitCommand(args, worktreePath);
  if (result.exitCode === 0) return { exitCode: 0, output: result.stderr || result.stdout, error: '' };

  const needsUpstream = result.stderr.includes('no upstream') || result.stderr.includes('has no upstream');
  if (!needsUpstream) return { exitCode: result.exitCode, output: '', error: result.stderr || 'Failed to push' };

  const retry = await executeGitCommand(['push', '--set-upstream', pushRemote, pushBranch], worktreePath);
  if (retry.exitCode !== 0) return { exitCode: retry.exitCode, output: '', error: retry.stderr || 'Failed to push' };
  return { exitCode: 0, output: retry.stderr || retry.stdout, error: '' };
}

async function handleGitWorktreePush(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, _workingDir: string): Promise<void> {
  try {
    const { worktreePath, remote, branch, setUpstream } = msg.data || {};
    if (!worktreePath) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Worktree path is required' } });
      return;
    }

    const pushRemote = remote || 'origin';
    const branchResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
    const pushBranch = branch || branchResult.stdout.trim();

    const pushResult = await pushWithUpstreamRetry(worktreePath, pushRemote, pushBranch, !!setUpstream);
    if (pushResult.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: pushResult.error } });
      return;
    }
    ctx.send(ws, { type: 'gitWorktreePushed', tabId, data: { output: pushResult.output, upstream: `${pushRemote}/${pushBranch}` } });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitWorktreeCreatePR(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, _workingDir: string): Promise<void> {
  try {
    const { worktreePath, title, body, baseBranch, draft } = msg.data || {};
    if (!worktreePath) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Worktree path is required' } });
      return;
    }

    const branchResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
    const branchName = branchResult.stdout.trim();
    const prTitle = title || branchName.replace(/[-_/]/g, ' ').replace(/^\w/, c => c.toUpperCase());

    const args = ['pr', 'create', '--title', prTitle];
    if (body) args.push('--body', body);
    if (baseBranch) args.push('--base', baseBranch);
    if (draft) args.push('--draft');

    const result = await spawnWithOutput('gh', args, worktreePath);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to create PR' } });
      return;
    }

    const prUrl = result.stdout.trim();
    const prNumberMatch = prUrl.match(/\/(\d+)$/);
    const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : 0;

    ctx.send(ws, { type: 'gitWorktreePRCreated', tabId, data: { prUrl, prNumber } });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

/**
 * Files in the target worktree's working tree whose dirty state intersects
 * the set of files the merge would touch. These are the rows that drive the
 * merge dialog's "uncommitted changes on <target>" blocker UI — surfacing
 * them preflight prevents the user from ever hitting git's raw "would be
 * overwritten" error.
 *
 * Detection strategy:
 *   - `git status --porcelain=v1` on the target's worktree → all dirty paths
 *   - `git diff --name-only target..source` → all paths the merge would touch
 *   - intersection = blockers
 *
 * Untracked files are included via the porcelain output (they collide with
 * incoming additions of the same path). Files that are dirty but outside the
 * merge's diff are NOT blockers — git would carry them through cleanly.
 */
async function detectMergeBlockers(
  targetWorktreePath: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<MergeBlocker[]> {
  const statusResult = await executeGitCommand(['status', '--porcelain=v1'], targetWorktreePath);
  if (statusResult.exitCode !== 0) return [];
  const { staged, unstaged, untracked } = parseGitStatus(statusResult.stdout);

  const diffResult = await executeGitCommand(
    ['diff', '--name-only', `${targetBranch}..${sourceBranch}`],
    targetWorktreePath,
  );
  if (diffResult.exitCode !== 0) return [];
  const mergeTouches = new Set(
    diffResult.stdout.split('\n').map(s => s.trim()).filter(Boolean),
  );
  if (mergeTouches.size === 0) return [];

  // Prefer the worktree (unstaged) status when both index and worktree are
  // dirty — that's what the user would lose. Fall back to staged, then
  // untracked. Order in the result list groups deletions last so the UI can
  // surface them where users expect.
  const seen = new Map<string, MergeBlocker>();
  const consider = (entries: GitFileStatus[]) => {
    for (const entry of entries) {
      if (!mergeTouches.has(entry.path)) continue;
      if (seen.has(entry.path)) continue;
      seen.set(entry.path, { path: entry.path, status: entry.status, staged: entry.staged });
    }
  };
  consider(unstaged);
  consider(staged);
  consider(untracked);

  return Array.from(seen.values()).sort((a, b) => {
    if (a.status === 'D' && b.status !== 'D') return 1;
    if (a.status !== 'D' && b.status === 'D') return -1;
    return a.path.localeCompare(b.path);
  });
}

async function handleGitMergePreview(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { sourceBranch, targetBranch } = msg.data || {};
    if (!sourceBranch || !targetBranch) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Source and target branches are required' } });
      return;
    }

    let clean = true;
    let conflicts: string[] = [];
    const mergeTreeResult = await executeGitCommand(['merge-tree', '--write-tree', targetBranch, sourceBranch], workingDir);
    if (mergeTreeResult.exitCode !== 0) {
      clean = false;
      conflicts = mergeTreeResult.stdout.split('\n')
        .filter(line => line.includes('CONFLICT'))
        .map(line => {
          const match = line.match(/CONFLICT.*:\s+(.+)/);
          return match?.[1]?.trim() || line;
        });
    }

    const statResult = await executeGitCommand(['diff', `${targetBranch}...${sourceBranch}`, '--stat'], workingDir);
    const stat = statResult.stdout.trim();

    const logResult = await executeGitCommand(
      ['log', `${targetBranch}..${sourceBranch}`, '--oneline', '--format=%h|%s'],
      workingDir
    );
    const commits = logResult.stdout.trim().split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [hash, ...rest] = line.split('|');
        return { hash: hash.trim(), message: rest.join('|').trim() };
      });

    // The merge always lands on the main worktree currently checked out to
    // the target branch. If main isn't on `targetBranch` we can't preflight
    // blockers (the dirty state wouldn't be the relevant one), so skip the
    // check and let the post-flight handler surface the branch-mismatch
    // error like before.
    const mainPath = await resolveMainWorktreePath(workingDir);
    const mainBranchResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], mainPath);
    const mainOnTarget = mainBranchResult.stdout.trim() === targetBranch;
    const blockers = mainOnTarget
      ? await detectMergeBlockers(mainPath, sourceBranch, targetBranch)
      : [];

    ctx.send(ws, {
      type: 'gitMergePreviewResult',
      tabId,
      data: {
        clean,
        conflicts,
        stat,
        commits,
        ahead: commits.length,
        targetWorktreePath: mainPath,
        targetWorktreeBlockers: blockers,
      },
    });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function resolveMainWorktreePath(workingDir: string): Promise<string> {
  const wtListResult = await executeGitCommand(['worktree', 'list', '--porcelain'], workingDir);
  const firstLine = wtListResult.stdout.split('\n').find(l => l.startsWith('worktree '));
  return firstLine ? firstLine.slice(9).trim() : workingDir;
}

async function executeMergeStrategy(
  strategy: string,
  sourceBranch: string,
  commitMessage: string | undefined,
  mainPath: string,
): Promise<{ exitCode: number; error?: string }> {
  if (strategy === 'squash') {
    const squashResult = await executeGitCommand(['merge', '--squash', sourceBranch], mainPath);
    if (squashResult.exitCode !== 0) return { exitCode: squashResult.exitCode, error: squashResult.stderr };
    const msg2 = commitMessage || `Squash merge branch '${sourceBranch}'`;
    const commitResult = await executeGitCommand(['commit', '-m', msg2], mainPath);
    if (commitResult.exitCode !== 0) return { exitCode: commitResult.exitCode, error: commitResult.stderr || 'Failed to commit squash merge' };
    return { exitCode: 0 };
  }
  if (strategy === 'rebase') {
    const result = await executeGitCommand(['merge', '--ff-only', sourceBranch], mainPath);
    return { exitCode: result.exitCode, error: result.stderr };
  }
  const mergeArgs = commitMessage ? ['merge', sourceBranch, '-m', commitMessage] : ['merge', sourceBranch];
  const result = await executeGitCommand(mergeArgs, mainPath);
  return { exitCode: result.exitCode, error: result.stderr };
}

async function detectMergeConflicts(mainPath: string): Promise<string[]> {
  const result = await executeGitCommand(['diff', '--name-only', '--diff-filter=U'], mainPath);
  return result.stdout.trim().split('\n').filter(f => f.trim());
}

async function removeWorktreeWithFallback(
  mainPath: string,
  worktreePath: string,
): Promise<{ success: boolean; warning?: string }> {
  const removeResult = await executeGitCommand(['worktree', 'remove', worktreePath], mainPath);
  if (removeResult.exitCode === 0) return { success: true };
  const forceResult = await executeGitCommand(['worktree', 'remove', '--force', worktreePath], mainPath);
  if (forceResult.exitCode === 0) return { success: true };
  return { success: false, warning: `Failed to remove worktree: ${forceResult.stderr || 'unknown error'}` };
}

async function deleteBranchAfterMerge(
  mainPath: string,
  branchName: string,
  strategy: string,
): Promise<string | undefined> {
  const deleteFlag = strategy === 'squash' ? '-D' : '-d';
  const result = await executeGitCommand(['branch', deleteFlag, branchName], mainPath);
  if (result.exitCode !== 0) {
    return `Failed to delete branch: ${result.stderr || 'unknown error'}`;
  }
  return undefined;
}

async function cleanupAfterMerge(
  mainPath: string,
  sourceBranch: string,
  strategy: string,
  deleteWorktree: boolean,
  deleteBranch: boolean,
): Promise<{ warnings: string[]; removedWorktreePath: string | null }> {
  const warnings: string[] = [];
  let removedWorktreePath: string | null = null;

  if (deleteWorktree) {
    const wtList = await executeGitCommand(['worktree', 'list', '--porcelain'], mainPath);
    const worktreePath = findWorktreePathForBranch(wtList.stdout, sourceBranch);
    if (worktreePath && worktreePath !== mainPath) {
      const result = await removeWorktreeWithFallback(mainPath, worktreePath);
      if (result.success) {
        removedWorktreePath = worktreePath;
      } else if (result.warning) {
        warnings.push(result.warning);
      }
    }
  }
  if (deleteBranch) {
    const warning = await deleteBranchAfterMerge(mainPath, sourceBranch, strategy);
    if (warning) warnings.push(warning);
  }
  await executeGitCommand(['worktree', 'prune'], mainPath);
  return { warnings, removedWorktreePath };
}

export function findWorktreePathForBranch(porcelainOutput: string, branchName: string): string | null {
  let currentWtPath = '';
  const fullRef = `refs/heads/${branchName}`;
  for (const line of porcelainOutput.split('\n')) {
    if (line.startsWith('worktree ')) currentWtPath = line.slice(9).trim();
    if (line.startsWith('branch ') && line.slice(7).trim() === fullRef) return currentWtPath;
  }
  return null;
}

/**
 * Parse a git stderr buffer for the "your local changes / untracked working
 * tree files would be overwritten by merge" message. Returned paths feed the
 * web client's blocker UI when a merge slips through preflight (race against
 * a teammate's auto-formatter, stale status, etc.).
 */
function parseOverwritePaths(stderr: string): string[] {
  const lines = stderr.split('\n');
  const headerIdx = lines.findIndex(l =>
    /your local changes to the following files would be overwritten/i.test(l) ||
    /untracked working tree files would be overwritten/i.test(l),
  );
  if (headerIdx < 0) return [];
  const paths: string[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(merge with strategy|aborting|please commit)/i.test(trimmed)) break;
    // Git indents each path with a tab; tolerate spaces too.
    if (/^[\t ]/.test(line)) {
      paths.push(trimmed);
    }
  }
  return paths;
}

const STASH_MESSAGE_TAG = 'mstro:pre-merge';

async function pushMergeStash(targetWorktreePath: string, sourceBranch: string, targetBranch: string): Promise<{ ref: string; sha: string; message: string } | null> {
  const message = `${STASH_MESSAGE_TAG} ${targetBranch} <- ${sourceBranch} @ ${new Date().toISOString()}`;
  const result = await executeGitCommand(['stash', 'push', '-u', '-m', message], targetWorktreePath);
  if (result.exitCode !== 0) return null;
  // "No local changes to save" exits 0 but does not push a stash; detect by
  // checking whether stash@{0}'s message matches what we just wrote.
  const top = await executeGitCommand(['stash', 'list', '-n', '1', '--format=%H%x09%gs'], targetWorktreePath);
  if (top.exitCode !== 0) return null;
  const [sha, ...rest] = top.stdout.trim().split('\t');
  const stashedMsg = rest.join('\t');
  if (!sha || !stashedMsg.includes(STASH_MESSAGE_TAG)) return null;
  return { ref: 'stash@{0}', sha, message };
}

async function popMergeStashBySha(targetWorktreePath: string, sha: string): Promise<{ exitCode: number; error?: string }> {
  const list = await executeGitCommand(['stash', 'list', '--format=%gd%x09%H'], targetWorktreePath);
  if (list.exitCode !== 0) return { exitCode: list.exitCode, error: list.stderr || 'Failed to read stash list' };
  const ref = list.stdout.split('\n').map(l => l.split('\t')).find(([, h]) => h === sha)?.[0];
  if (!ref) return { exitCode: 1, error: 'Stash no longer exists — it may have already been popped or dropped.' };
  const pop = await executeGitCommand(['stash', 'pop', ref], targetWorktreePath);
  return { exitCode: pop.exitCode, error: pop.exitCode !== 0 ? pop.stderr : undefined };
}

/**
 * Decide what shape of merge-failure payload to send the client. Splits the
 * three error modes — index conflict, target-worktree blocker, generic — out
 * of the main handler so each is a self-contained branch.
 */
async function buildMergeFailurePayload(
  mainPath: string,
  sourceBranch: string,
  targetBranch: string,
  mergeError: string | undefined,
): Promise<Record<string, unknown>> {
  const conflictFiles = await detectMergeConflicts(mainPath);
  if (conflictFiles.length > 0) {
    return { success: false, conflictFiles, targetWorktreePath: mainPath };
  }
  const overwritten = parseOverwritePaths(mergeError || '');
  if (overwritten.length > 0) {
    const blockers = await detectMergeBlockers(mainPath, sourceBranch, targetBranch);
    const targetWorktreeBlockers: MergeBlocker[] = blockers.length > 0
      ? blockers
      : overwritten.map(p => ({ path: p, status: 'M' as const, staged: false }));
    return { success: false, targetWorktreePath: mainPath, targetWorktreeBlockers };
  }
  return { success: false, error: mergeError || 'Merge failed', targetWorktreePath: mainPath };
}

function buildMergeSuccessPayload(
  mainPath: string,
  mergeCommit: string,
  warnings: string[],
  stash: { ref: string; sha: string; message: string } | null,
): Record<string, unknown> {
  const data: Record<string, unknown> = { success: true, mergeCommit, targetWorktreePath: mainPath };
  if (warnings.length > 0) data.warnings = warnings;
  if (stash) {
    data.stashRef = stash.ref;
    data.stashSha = stash.sha;
    data.stashMessage = stash.message;
  }
  return data;
}

async function handleGitWorktreeMerge(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { sourceBranch, targetBranch, strategy, commitMessage, deleteWorktree, deleteBranch, stashFirst } = msg.data || {};
    if (!sourceBranch || !targetBranch || !strategy) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Source branch, target branch, and strategy are required' } });
      return;
    }

    const mainPath = await resolveMainWorktreePath(workingDir);

    const mainBranchResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], mainPath);
    if (mainBranchResult.stdout.trim() !== targetBranch) {
      ctx.send(ws, { type: 'gitWorktreeMergeResult', tabId, data: { success: false, error: `Switch the main worktree to "${targetBranch}" before merging`, targetWorktreePath: mainPath } });
      return;
    }

    // Stash first if requested. A no-op result (nothing to stash, e.g. user
    // already cleaned up between preflight and merge) is fine — we still
    // proceed with the merge.
    const stash = stashFirst ? await pushMergeStash(mainPath, sourceBranch, targetBranch) : null;

    const headBefore = await executeGitCommand(['rev-parse', 'HEAD'], mainPath);
    const mergeResult = await executeMergeStrategy(strategy, sourceBranch, commitMessage, mainPath);

    if (mergeResult.exitCode !== 0) {
      // Best-effort restore of the user's working tree before reporting.
      // If pop conflicts, the stash stays around and the user can recover it
      // manually — we still surface the original merge error.
      if (stash) await popMergeStashBySha(mainPath, stash.sha).catch(() => undefined);
      const data = await buildMergeFailurePayload(mainPath, sourceBranch, targetBranch, mergeResult.error);
      ctx.send(ws, { type: 'gitWorktreeMergeResult', tabId, data });
      return;
    }

    const headAfter = await executeGitCommand(['rev-parse', 'HEAD'], mainPath);
    if (headBefore.stdout.trim() === headAfter.stdout.trim()) {
      if (stash) await popMergeStashBySha(mainPath, stash.sha).catch(() => undefined);
      ctx.send(ws, { type: 'gitWorktreeMergeResult', tabId, data: { success: false, error: `Already up to date — "${sourceBranch}" has no new commits to merge into "${targetBranch}"`, targetWorktreePath: mainPath } });
      return;
    }

    const commitHashResult = await executeGitCommand(['rev-parse', '--short', 'HEAD'], mainPath);
    const { warnings, removedWorktreePath } = await cleanupAfterMerge(mainPath, sourceBranch, strategy, !!deleteWorktree, !!deleteBranch);
    if (removedWorktreePath) cleanupWorktreeReferences(ctx, workingDir, removedWorktreePath);

    const data = buildMergeSuccessPayload(mainPath, commitHashResult.stdout.trim(), warnings, stash);
    ctx.send(ws, { type: 'gitWorktreeMergeResult', tabId, data });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitMergeStashPop(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { stashSha, targetWorktreePath } = msg.data || {};
    if (!stashSha) {
      ctx.send(ws, { type: 'gitMergeStashPopped', tabId, data: { success: false, error: 'Missing stash reference' } });
      return;
    }
    const path = targetWorktreePath || (await resolveMainWorktreePath(workingDir));
    const result = await popMergeStashBySha(path, stashSha);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitMergeStashPopped', tabId, data: { success: false, error: result.error || 'Failed to pop stash', targetWorktreePath: path } });
      return;
    }
    ctx.send(ws, { type: 'gitMergeStashPopped', tabId, data: { success: true, targetWorktreePath: path } });
    // Refresh status so the file explorer / git view reflects the restored changes.
    handleGitStatus(ctx, ws, tabId, path);
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitMergeDiscardBlockers(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { paths, targetWorktreePath } = msg.data || {};
    if (!Array.isArray(paths) || paths.length === 0) {
      ctx.send(ws, { type: 'gitMergeBlockersDiscarded', tabId, data: { success: false, error: 'No paths to discard' } });
      return;
    }
    const path = targetWorktreePath || (await resolveMainWorktreePath(workingDir));

    // Restore tracked files (modifications, deletions, stages) from HEAD.
    // `git checkout HEAD -- <paths>` overwrites both index and worktree, which
    // is exactly the "discard" semantics the UI promised the user.
    const checkoutResult = await executeGitCommand(['checkout', 'HEAD', '--', ...paths], path);
    // Untracked files won't be touched by `checkout HEAD --` (git refuses with
    // "did not match any file(s) known to git" when ALL paths are untracked,
    // but mixed lists succeed for the tracked subset). Run `git clean -f` on
    // the originally-supplied list to remove any untracked leftovers — git
    // ignores anything that's already gone, so this is safe to run after.
    const cleanResult = await executeGitCommand(['clean', '-f', '--', ...paths], path);

    if (checkoutResult.exitCode !== 0 && cleanResult.exitCode !== 0) {
      ctx.send(ws, {
        type: 'gitMergeBlockersDiscarded',
        tabId,
        data: { success: false, error: checkoutResult.stderr || cleanResult.stderr || 'Failed to discard changes', targetWorktreePath: path },
      });
      return;
    }
    ctx.send(ws, { type: 'gitMergeBlockersDiscarded', tabId, data: { success: true, targetWorktreePath: path, paths } });
    handleGitStatus(ctx, ws, tabId, path);
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitMergeAbort(ctx: HandlerContext, ws: WSContext, tabId: string, workingDir: string): Promise<void> {
  try {
    const mainPath = await resolveMainWorktreePath(workingDir);

    const result = await executeGitCommand(['merge', '--abort'], mainPath);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to abort merge' } });
      return;
    }

    ctx.send(ws, { type: 'gitMergeAborted', tabId, data: { aborted: true } });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

async function handleGitMergeComplete(ctx: HandlerContext, ws: WSContext, _msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const mainPath = await resolveMainWorktreePath(workingDir);

    const result = await executeGitCommand(['commit', '--no-edit'], mainPath);
    if (result.exitCode !== 0) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: result.stderr || 'Failed to complete merge' } });
      return;
    }

    const hashResult = await executeGitCommand(['rev-parse', '--short', 'HEAD'], mainPath);
    const mergeCommit = hashResult.stdout.trim();

    ctx.send(ws, { type: 'gitMergeCompleted', tabId, data: { success: true, mergeCommit } });
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}
