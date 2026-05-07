// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Agent Resolver — Maps issue.agents hints to subagents installed on the user's system.
 *
 * Issue front matter may specify `agents` as either canonical Claude Code subagent
 * names (e.g. `backend-architect`) or general role pointers (e.g. `backend engineer`).
 * This module bridges the two: it consults AgentManager (project / global / bundled
 * `.claude/agents/`) and resolves each hint to a concrete agent name when possible,
 * falling back to the original hint when no match is found so the executor can still
 * surface the user's intent in the prompt.
 */

import { type AgentInfo, agentManager } from '../../utils/agent-manager.js';

export interface ResolvedAgent {
  /** The original hint as written in the issue front matter. */
  hint: string;
  /** The resolved canonical agent name, or null if no installed agent matched. */
  resolvedName: string | null;
  /** The matching agent info, or null if no installed agent matched. */
  info: AgentInfo | null;
}

const NON_WORD = /[^a-z0-9]+/g;

function normalize(input: string): string {
  return input.toLowerCase().replace(NON_WORD, ' ').trim();
}

function tokenize(input: string): string[] {
  return normalize(input).split(' ').filter(Boolean);
}

/**
 * Discover every available agent across project / global / bundled directories.
 * Project entries shadow global, which shadows bundled (deduped by canonical name).
 */
function listAvailableAgents(workingDir: string): AgentInfo[] {
  const seen = new Map<string, AgentInfo>();
  const layers = [
    agentManager.listProjectAgents(workingDir),
    agentManager.listGlobalAgents(),
    agentManager.listBundledAgents(),
  ];
  for (const layer of layers) {
    for (const agent of layer) {
      if (!seen.has(agent.name)) seen.set(agent.name, agent);
    }
  }
  return Array.from(seen.values());
}

/**
 * Score how well an agent matches a hint. Returns 0 when there is no token overlap.
 * Higher is better. Exact normalized matches return Infinity.
 */
function matchScore(hint: string, agent: AgentInfo): number {
  const normalizedHint = normalize(hint);
  const normalizedName = normalize(agent.name);
  if (normalizedHint === normalizedName) return Number.POSITIVE_INFINITY;

  const hintTokens = tokenize(hint);
  if (hintTokens.length === 0) return 0;

  const haystack = `${normalizedName} ${normalize(agent.description ?? '')}`;
  let matched = 0;
  for (const token of hintTokens) {
    if (token.length < 2) continue;
    if (haystack.includes(token)) matched++;
  }
  if (matched === 0) return 0;

  // Reward agents whose name (not just description) contains hint tokens.
  const nameMatches = hintTokens.filter(t => t.length >= 2 && normalizedName.includes(t)).length;
  return matched + nameMatches * 0.5;
}

/**
 * Resolve a single hint against the catalog of available agents.
 * Returns the highest-scoring agent, or null when no agent has any token overlap.
 */
function resolveHint(hint: string, available: AgentInfo[]): AgentInfo | null {
  let bestScore = 0;
  let best: AgentInfo | null = null;
  for (const agent of available) {
    const score = matchScore(hint, agent);
    if (score > bestScore) {
      bestScore = score;
      best = agent;
    }
  }
  return best;
}

/**
 * Resolve every hint in `agents` against the user's installed Claude Code subagents.
 * Hints with no match are preserved (resolvedName: null) so the executor can still
 * mention them in the prompt with a graceful fallback note.
 */
export function resolveAgentHints(agents: string[], workingDir: string): ResolvedAgent[] {
  if (!agents || agents.length === 0) return [];
  const available = listAvailableAgents(workingDir);
  return agents
    .map(raw => raw.trim())
    .filter(Boolean)
    .map(hint => {
      const info = resolveHint(hint, available);
      return {
        hint,
        resolvedName: info?.name ?? null,
        info,
      };
    });
}
