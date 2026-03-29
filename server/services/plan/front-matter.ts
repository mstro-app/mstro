// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Front Matter Utilities — Read/write YAML front matter fields.
 *
 * All replacements are scoped to the --- delimiters to prevent
 * markdown body corruption. Used across executor, plan-handlers,
 * and state-reconciler.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Replace a field value in a raw YAML string (no --- delimiters).
 * If the field does not exist, it is appended.
 */
export function replaceYamlField(yaml: string, field: string, value: string): string {
  const regex = new RegExp(`^(${field}:\\s*).+$`, 'm');
  if (regex.test(yaml)) {
    return yaml.replace(regex, `$1${value}`);
  }
  return `${yaml}\n${field}: ${value}`;
}

/**
 * Replace a YAML front matter field in a full markdown content string.
 * Only modifies content between the first pair of --- delimiters.
 * If the field does not exist in front matter, it is appended.
 * Returns content unchanged if no front matter block is found.
 */
export function replaceFrontMatterField(content: string, field: string, value: string): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) return content;

  const yaml = replaceYamlField(fmMatch[2], field, value);
  return `${fmMatch[1]}${yaml}${fmMatch[3]}${content.slice(fmMatch[0].length)}`;
}

/**
 * Read a file, update a front matter field, and write it back.
 * Convenience wrapper for single-field updates.
 */
export function setFrontMatterField(filePath: string, field: string, value: string): void {
  const content = readFileSync(filePath, 'utf-8');
  const updated = replaceFrontMatterField(content, field, value);
  writeFileSync(filePath, updated, 'utf-8');
}
