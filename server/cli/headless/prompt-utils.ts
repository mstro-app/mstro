// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Prompt Utilities
 *
 * Utilities for enriching prompts with context from previous conversation.
 */

import type { ImageAttachment, PromptContext } from './types.js';

/**
 * Enrich prompt with context from previous conversation
 */
export function enrichPromptWithContext(prompt: string, context: PromptContext): string {
  let enriched = prompt;

  // Detect if this is a continuation/approval prompt
  const isApprovalOrContinuation = isApprovalPrompt(prompt);

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
 * Detect if a prompt is an approval or continuation
 */
export function isApprovalPrompt(prompt: string): boolean {
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
