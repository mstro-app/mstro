// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Attachment handling for improvisation sessions.
 * Manages file persistence, hydration, and prompt building for multimodal input.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { herror } from './headless/headless-logger.js';
import type { FileAttachment } from './improvisation-types.js';

/** MIME types that the Claude API can accept as image content blocks */
const SUPPORTED_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

/** Hydrate pre-uploaded images from disk and downgrade unsupported formats */
export function hydrateAndFilterAttachments(attachments: FileAttachment[]): void {
  for (const attachment of attachments) {
    const preUploaded = (attachment as FileAttachment & { _preUploaded?: boolean })._preUploaded;
    if (preUploaded && attachment.isImage && !attachment.content && existsSync(attachment.filePath)) {
      try {
        attachment.content = readFileSync(attachment.filePath).toString('base64');
      } catch (err) {
        herror(`Failed to read pre-uploaded image ${attachment.filePath}:`, err);
        attachment.isImage = false;
      }
    }

    if (attachment.isImage) {
      const mime = (attachment.mimeType || '').toLowerCase();
      if (mime && !SUPPORTED_IMAGE_MIMES.has(mime)) {
        attachment.isImage = false;
      }
    }
  }
}

/**
 * Build prompt with text file attachments prepended and disk path references.
 * Format: each text file is shown as @path followed by content in code block.
 */
export function buildPromptWithAttachments(
  userPrompt: string,
  attachments?: FileAttachment[],
  diskPaths?: string[],
): string {
  if ((!attachments || attachments.length === 0) && (!diskPaths || diskPaths.length === 0)) {
    return userPrompt;
  }

  const parts: string[] = [];

  if (attachments) {
    const textFiles = attachments.filter(a => !a.isImage);
    for (const file of textFiles) {
      parts.push(`@${file.filePath}\n\`\`\`\n${file.content}\n\`\`\``);
    }
  }

  if (diskPaths && diskPaths.length > 0) {
    parts.push(`Attached files saved to disk:\n${diskPaths.map(p => `- ${p}`).join('\n')}`);
  }

  if (parts.length === 0) {
    return userPrompt;
  }

  return `${parts.join('\n\n')}\n\n${userPrompt}`;
}

/**
 * Write attachments to disk at .mstro/tmp/attachments/{sessionId}/.
 * Returns array of absolute file paths for each persisted attachment.
 */
export function persistAttachments(
  attachments: FileAttachment[],
  workingDir: string,
  sessionId: string,
): string[] {
  if (attachments.length === 0) return [];

  const attachDir = join(workingDir, '.mstro', 'tmp', 'attachments', sessionId);
  if (!existsSync(attachDir)) {
    mkdirSync(attachDir, { recursive: true });
  }

  const paths: string[] = [];
  for (const attachment of attachments) {
    if ((attachment as FileAttachment & { _preUploaded?: boolean })._preUploaded) {
      if (existsSync(attachment.filePath)) {
        paths.push(attachment.filePath);
      }
      continue;
    }
    const filePath = join(attachDir, attachment.fileName);
    try {
      writeFileSync(filePath, Buffer.from(attachment.content, 'base64'));
      paths.push(filePath);
    } catch (err) {
      herror(`Failed to persist attachment ${attachment.fileName}:`, err);
    }
  }

  return paths;
}

/** Clean up persisted attachments for a session */
export function cleanupAttachments(workingDir: string, sessionId: string): void {
  const attachDir = join(workingDir, '.mstro', 'tmp', 'attachments', sessionId);
  if (existsSync(attachDir)) {
    try {
      rmSync(attachDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/** Prepare prompt with attachments and limit image count */
export function preparePromptAndAttachments(
  userPrompt: string,
  attachments: FileAttachment[] | undefined,
  workingDir: string,
  sessionId: string,
  onWarning?: (msg: string) => void,
): { prompt: string; imageAttachments: FileAttachment[] | undefined } {
  if (attachments) {
    hydrateAndFilterAttachments(attachments);
  }

  const diskPaths = attachments ? persistAttachments(attachments, workingDir, sessionId) : [];
  const prompt = buildPromptWithAttachments(userPrompt, attachments, diskPaths);

  const MAX_IMAGE_ATTACHMENTS = 20;
  const allImages = attachments?.filter(a => a.isImage && a.content);
  let imageAttachments = allImages;
  if (allImages && allImages.length > MAX_IMAGE_ATTACHMENTS) {
    imageAttachments = allImages.slice(-MAX_IMAGE_ATTACHMENTS);
    onWarning?.(
      `\n[[MSTRO_ERROR:TOO_MANY_IMAGES]] ${allImages.length} images attached, limit is ${MAX_IMAGE_ATTACHMENTS}. Using the ${MAX_IMAGE_ATTACHMENTS} most recent.\n`
    );
  }

  return { prompt, imageAttachments };
}
