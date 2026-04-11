// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolvePmDir } from '../plan/parser.js';
import type { Workspace } from '../plan/types.js';
import { executeGitCommand, handleGitStatus, spawnWithOutput } from './git-handlers.js';
import type { HandlerContext } from './handler-context.js';
import type { WebSocketMessage, WorktreeInfo, WSContext } from './types.js';

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

async function handleTabWorktreeSwitch(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
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
      ctx.send(ws, { type: 'tabWorktreeSwitched', tabId: resolvedTabId, data: { tabId: resolvedTabId, worktreePath: workingDir, branch: '' } });
      handleGitStatus(ctx, ws, resolvedTabId, workingDir);
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
    handleGitStatus(ctx, ws, resolvedTabId, worktreePath);
  } catch (error: unknown) {
    ctx.send(ws, { type: 'gitError', tabId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
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

    ctx.send(ws, {
      type: 'gitMergePreviewResult',
      tabId,
      data: { clean, conflicts, stat, commits, ahead: commits.length },
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
      const removeResult = await executeGitCommand(['worktree', 'remove', worktreePath], mainPath);
      if (removeResult.exitCode !== 0) {
        const forceResult = await executeGitCommand(['worktree', 'remove', '--force', worktreePath], mainPath);
        if (forceResult.exitCode !== 0) {
          warnings.push(`Failed to remove worktree: ${forceResult.stderr || 'unknown error'}`);
        } else {
          removedWorktreePath = worktreePath;
        }
      } else {
        removedWorktreePath = worktreePath;
      }
    }
  }
  if (deleteBranch) {
    const deleteFlag = strategy === 'squash' ? '-D' : '-d';
    const branchResult = await executeGitCommand(['branch', deleteFlag, sourceBranch], mainPath);
    if (branchResult.exitCode !== 0) {
      warnings.push(`Failed to delete branch: ${branchResult.stderr || 'unknown error'}`);
    }
  }
  await executeGitCommand(['worktree', 'prune'], mainPath);
  return { warnings, removedWorktreePath };
}

function findWorktreePathForBranch(porcelainOutput: string, branchName: string): string | null {
  let currentWtPath = '';
  const fullRef = `refs/heads/${branchName}`;
  for (const line of porcelainOutput.split('\n')) {
    if (line.startsWith('worktree ')) currentWtPath = line.slice(9).trim();
    if (line.startsWith('branch ') && line.slice(7).trim() === fullRef) return currentWtPath;
  }
  return null;
}

async function handleGitWorktreeMerge(ctx: HandlerContext, ws: WSContext, msg: WebSocketMessage, tabId: string, workingDir: string): Promise<void> {
  try {
    const { sourceBranch, targetBranch, strategy, commitMessage, deleteWorktree, deleteBranch } = msg.data || {};
    if (!sourceBranch || !targetBranch || !strategy) {
      ctx.send(ws, { type: 'gitError', tabId, data: { error: 'Source branch, target branch, and strategy are required' } });
      return;
    }

    const mainPath = await resolveMainWorktreePath(workingDir);

    const mainBranchResult = await executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], mainPath);
    if (mainBranchResult.stdout.trim() !== targetBranch) {
      ctx.send(ws, { type: 'gitWorktreeMergeResult', tabId, data: { success: false, error: `Switch the main worktree to "${targetBranch}" before merging` } });
      return;
    }

    const headBefore = await executeGitCommand(['rev-parse', 'HEAD'], mainPath);

    const mergeResult = await executeMergeStrategy(strategy, sourceBranch, commitMessage, mainPath);
    if (mergeResult.exitCode !== 0) {
      const conflictFiles = await detectMergeConflicts(mainPath);
      const data = conflictFiles.length > 0
        ? { success: false, conflictFiles }
        : { success: false, error: mergeResult.error || 'Merge failed' };
      ctx.send(ws, { type: 'gitWorktreeMergeResult', tabId, data });
      return;
    }

    const headAfter = await executeGitCommand(['rev-parse', 'HEAD'], mainPath);
    if (headBefore.stdout.trim() === headAfter.stdout.trim()) {
      ctx.send(ws, { type: 'gitWorktreeMergeResult', tabId, data: { success: false, error: `Already up to date — "${sourceBranch}" has no new commits to merge into "${targetBranch}"` } });
      return;
    }

    const commitHashResult = await executeGitCommand(['rev-parse', '--short', 'HEAD'], mainPath);
    const { warnings, removedWorktreePath } = await cleanupAfterMerge(mainPath, sourceBranch, strategy, !!deleteWorktree, !!deleteBranch);

    if (removedWorktreePath) {
      cleanupWorktreeReferences(ctx, workingDir, removedWorktreePath);
    }

    const data: Record<string, unknown> = { success: true, mergeCommit: commitHashResult.stdout.trim() };
    if (warnings.length > 0) {
      data.warnings = warnings;
    }
    ctx.send(ws, { type: 'gitWorktreeMergeResult', tabId, data });
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
