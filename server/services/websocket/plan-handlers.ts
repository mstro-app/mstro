// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Plan Handlers — WebSocket message router for Plan view
 *
 * Routes plan* messages to domain-specific handler modules.
 * Follows the same pattern as quality-handlers.ts and git-handlers.ts.
 */

import type { HandlerContext } from './handler-context.js';
import { handleArchiveBoard, handleCreateBoard, handleGetBoard, handleGetBoardArtifacts, handleGetBoardState, handleReorderBoards, handleSetActiveBoard, handleUpdateBoard } from './plan-board-handlers.js';
import { handleExecute, handleExecuteEpic, handlePause, handlePrompt, handleResume, handleStop } from './plan-execution-handlers.js';
import { handleCreateIssue, handleDeleteIssue, handleGetIssue, handleGetMilestone, handleGetSprint, handleListIssues, handlePlanInit, handleScaffold, handleUpdateIssue } from './plan-issue-handlers.js';
import { handleActivateSprint, handleCompleteSprint, handleCreateSprint, handleGetSprintArtifacts } from './plan-sprint-handlers.js';
import type { WebSocketMessage, WSContext } from './types.js';

// Re-export for backward compatibility
export { cleanupPlanResources } from './plan-helpers.js';

export function handlePlanMessage(
  ctx: HandlerContext,
  ws: WSContext,
  msg: WebSocketMessage,
  _tabId: string,
  workingDir: string,
  permission?: 'control' | 'view',
): void {
  const handlers: Record<string, () => void> = {
    planInit: () => handlePlanInit(ctx, ws, workingDir),
    planGetState: () => handlePlanInit(ctx, ws, workingDir),
    planListIssues: () => handleListIssues(ctx, ws, workingDir),
    planGetIssue: () => handleGetIssue(ctx, ws, msg, workingDir),
    planGetSprint: () => handleGetSprint(ctx, ws, msg, workingDir),
    planGetMilestone: () => handleGetMilestone(ctx, ws, msg, workingDir),
    planCreateIssue: () => handleCreateIssue(ctx, ws, msg, workingDir, permission),
    planUpdateIssue: () => handleUpdateIssue(ctx, ws, msg, workingDir, permission),
    planDeleteIssue: () => handleDeleteIssue(ctx, ws, msg, workingDir, permission),
    planScaffold: () => handleScaffold(ctx, ws, msg, workingDir, permission),
    planPrompt: () => handlePrompt(ctx, ws, msg, workingDir, permission),
    planExecute: () => handleExecute(ctx, ws, msg, workingDir, permission),
    planExecuteEpic: () => handleExecuteEpic(ctx, ws, msg, workingDir, permission),
    planPause: () => handlePause(ctx, ws, workingDir, permission),
    planStop: () => handleStop(ctx, ws, workingDir, permission),
    planResume: () => handleResume(ctx, ws, workingDir, permission),
    // Board lifecycle
    planCreateBoard: () => handleCreateBoard(ctx, ws, msg, workingDir, permission),
    planUpdateBoard: () => handleUpdateBoard(ctx, ws, msg, workingDir, permission),
    planArchiveBoard: () => handleArchiveBoard(ctx, ws, msg, workingDir, permission),
    planGetBoard: () => handleGetBoard(ctx, ws, msg, workingDir),
    planGetBoardState: () => handleGetBoardState(ctx, ws, msg, workingDir),
    planReorderBoards: () => handleReorderBoards(ctx, ws, msg, workingDir, permission),
    planSetActiveBoard: () => handleSetActiveBoard(ctx, ws, msg, workingDir, permission),
    planGetBoardArtifacts: () => handleGetBoardArtifacts(ctx, ws, msg, workingDir),
    // Sprint lifecycle (legacy)
    planCreateSprint: () => handleCreateSprint(ctx, ws, msg, workingDir, permission),
    planActivateSprint: () => handleActivateSprint(ctx, ws, msg, workingDir, permission),
    planCompleteSprint: () => handleCompleteSprint(ctx, ws, msg, workingDir, permission),
    planGetSprintArtifacts: () => handleGetSprintArtifacts(ctx, ws, msg, workingDir),
  };

  const handler = handlers[msg.type];
  if (!handler) return;

  try {
    handler();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    ctx.send(ws, { type: 'planError', data: { error: errMsg } });
  }
}
