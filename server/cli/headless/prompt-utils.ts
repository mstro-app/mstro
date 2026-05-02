// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Prompt Utilities
 *
 * Utilities for enriching prompts with context from previous conversation.
 */

import { assessApproval } from './stall-assessor.js';
import type { ImageAttachment, PromptContext } from './types.js';

/**
 * Enrich prompt with context from previous conversation.
 * Async because ambiguous short prompts are classified by Haiku.
 */
export async function enrichPromptWithContext(prompt: string, context: PromptContext): Promise<string> {
  let enriched = prompt;

  // Detect if this is a continuation/approval prompt.
  // Fast regex path for obvious approvals, Haiku for ambiguous short prompts.
  const isApprovalOrContinuation = await detectApproval(prompt);

  // Add accumulated knowledge from previous prompts
  if (context.accumulatedKnowledge) {
    if (isApprovalOrContinuation) {
      enriched = `## Context from Previous Work\n${context.accumulatedKnowledge}\n\n## User Response\nThe user has responded with: "${prompt}"\n\nThis is a continuation/approval of the previous conversation. If you asked a question or requested approval in the previous movement, the user is responding to that question. Please proceed accordingly without asking the same question again.`;
    } else {
      enriched = `## Context from Previous Work\n${context.accumulatedKnowledge}\n\n## Current Task\n${prompt}`;
    }
  }

  // Add files modified so far
  if (context.filesModified && context.filesModified.length > 0) {
    enriched += `\n\n## Files Modified in This Session\n${context.filesModified.join('\n')}`;
  }

  return enriched;
}

/**
 * Detect if a prompt is an approval or continuation.
 * Layer 1: Regex fast path for obvious approvals (free, sync).
 * Layer 2: Haiku assessment for ambiguous short prompts (<100 chars).
 */
async function detectApproval(prompt: string): Promise<boolean> {
  // Layer 1: fast regex path
  if (isApprovalPromptFast(prompt)) return true;

  // Layer 2: Haiku for short ambiguous prompts.
  // Long prompts (>100 chars) are almost certainly new tasks, not approvals.
  if (prompt.trim().length <= 100) {
    try {
      const claudeCmd = process.env.CLAUDE_COMMAND || 'claude';
      const verdict = await assessApproval(prompt, claudeCmd, false);
      return verdict.isApproval;
    } catch {
      // Haiku failed — fall through to false
    }
  }

  return false;
}

/**
 * Fast regex-based approval detection (sync, no API call).
 * Catches obvious affirmatives. Ambiguous cases fall through to Haiku.
 */
export function isApprovalPrompt(prompt: string): boolean {
  return isApprovalPromptFast(prompt);
}

function isApprovalPromptFast(prompt: string): boolean {
  const lower = prompt.toLowerCase().trim();

  // Short affirmative responses
  if (['yes', 'y', 'ok', 'okay', 'sure', 'go', 'proceed', 'continue'].includes(lower)) {
    return true;
  }

  // Approval phrases
  const approvalPatterns = [
    /^yes[,\s]/,
    /^y[,\s]/,
    /^okay[,\s]/,
    /^ok[,\s]/,
    /^sure[,\s]/,
    /^go ahead/,
    /^proceed/,
    /^continue/,
    /^from the (first|previous|last)/i,
    /approval/i,
    /approved/i
  ];

  return approvalPatterns.some(pattern => pattern.test(lower));
}

/**
 * Build a multimodal message for stream-json input format.
 * This constructs a JSON message with image content blocks followed by text.
 * Format: {"type":"user","message":{"role":"user","content":[{image blocks...},{type:"text",text:"..."}]}}
 */
export function buildMultimodalMessage(textPrompt: string, imageAttachments: ImageAttachment[]): string {
  // Build content array with images first, then text
  const content: Array<{
    type: 'image' | 'text';
    source?: { type: 'base64'; media_type: string; data: string };
    text?: string;
  }> = [];

  // Add each image as a content block
  for (const attachment of imageAttachments) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.mimeType || 'image/png',
        data: attachment.content
      }
    });
  }

  // Add the text prompt
  content.push({
    type: 'text',
    text: textPrompt
  });

  // Construct the message in Claude API format
  const message = {
    type: 'user',
    message: {
      role: 'user',
      content
    }
  };

  return JSON.stringify(message);
}
