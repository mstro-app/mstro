// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * File Utilities
 *
 * File type detection, gitignore parsing, and directory scanning utilities.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { CacheEntry, } from './types.js';

// Directories always excluded from autocomplete scanning
const ALWAYS_IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'dist-ssr', '.git', '__pycache__',
  '.next', '.turbo', 'build', '.cache', 'coverage',
  '.parcel-cache', '.nuxt', '.output', '.vercel', '.netlify',
  '.nyc_output', 'venv', '.venv'
]);

// File type categorization for icons
export const FILE_TYPE_MAP: Record<string, string> = {
  // JavaScript/TypeScript
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  // Web
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.sass': 'css',
  '.less': 'css',
  // Data
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.toml': 'config',
  // Config
  '.env': 'config',
  '.gitignore': 'config',
  '.eslintrc': 'config',
  '.prettierrc': 'config',
  // Documentation
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.txt': 'text',
  '.rst': 'text',
  // Images
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.webp': 'image',
  '.ico': 'image',
  // Other languages
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  // Build/Package
  '.lock': 'lock',
  '.log': 'log',
};

// Directory cache
export const directoryCache = new Map<string, CacheEntry>();
export const CACHE_TTL_MS = 5000; // 5 second cache

/**
 * Get file type from extension
 */
export function getFileType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return FILE_TYPE_MAP[ext] || 'file';
}

/**
 * Parse .gitignore patterns
 */
export function parseGitignore(workingDir: string): string[] {
  const gitignorePath = join(workingDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    return [];
  }

  try {
    const content = readFileSync(gitignorePath, 'utf-8');
    const patterns = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && !line.startsWith('!'));
    return patterns;
  } catch (error) {
    console.error('[FileUtils] Error parsing .gitignore:', error);
    return [];
  }
}

/**
 * Check if path matches gitignore pattern
 * Follows gitignore semantics:
 * - Patterns without slashes match anywhere in the path (e.g., "node_modules" matches "foo/node_modules/bar")
 * - Patterns with slashes are anchored to the root (e.g., "src/foo" only matches "src/foo")
 * - Patterns ending with / match directories
 */
function matchesSinglePattern(normalizedPath: string, pathSegments: string[], pattern: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const isDirectoryPattern = normalizedPattern.endsWith('/');
  const cleanPattern = isDirectoryPattern ? normalizedPattern.slice(0, -1) : normalizedPattern;

  if (cleanPattern.includes('/')) {
    return normalizedPath === cleanPattern || normalizedPath.startsWith(`${cleanPattern}/`);
  }

  if (pathSegments.includes(cleanPattern)) {
    return true;
  }

  if (cleanPattern.includes('*')) {
    const regexPattern = cleanPattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    return new RegExp(`(^|/)${regexPattern}($|/)`).test(normalizedPath);
  }

  return false;
}

export function isIgnored(path: string, patterns: string[]): boolean {
  const normalizedPath = path.replace(/\\/g, '/');
  const pathSegments = normalizedPath.split('/');
  return patterns.some(pattern => matchesSinglePattern(normalizedPath, pathSegments, pattern));
}

/**
 * Recursively scan directory with depth limit for performance
 */
function shouldScanEntry(entry: { name: string; isDirectory: () => boolean }, relativePath: string, gitignorePatterns: string[]): boolean {
  if (entry.name.startsWith('.')) return false;
  if (entry.isDirectory() && ALWAYS_IGNORE_DIRS.has(entry.name)) return false;
  if (gitignorePatterns.length > 0 && isIgnored(relativePath, gitignorePatterns)) return false;
  return true;
}

export function scanDirectoryRecursiveWithDepth(
  dir: string,
  baseDir: string,
  gitignorePatterns: string[],
  results: Array<{ relativePath: string; isDirectory: boolean }> = [],
  maxResults: number = 1000,
  maxDepth: number = 10,
  currentDepth: number = 0
): Array<{ relativePath: string; isDirectory: boolean }> {
  try {
    if (results.length >= maxResults || currentDepth >= maxDepth) {
      return results;
    }

    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= maxResults) break;

      const fullPath = join(dir, entry.name);
      const relativePath = relative(baseDir, fullPath);

      if (!shouldScanEntry(entry, relativePath, gitignorePatterns)) continue;

      results.push({ relativePath, isDirectory: entry.isDirectory() });

      if (entry.isDirectory() && results.length < maxResults && currentDepth + 1 < maxDepth) {
        scanDirectoryRecursiveWithDepth(fullPath, baseDir, gitignorePatterns, results, maxResults, maxDepth, currentDepth + 1);
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return results;
}

/**
 * Check if a path is in a safe location for reading (outside working dir)
 */
export function isPathInSafeLocation(fullPath: string): boolean {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const safePatterns = [
    join(homeDir, 'Desktop'),
    join(homeDir, 'Downloads'),
    join(homeDir, 'Pictures'),
    join(homeDir, 'Documents'),
    '/var/folders/', // macOS temp directories for screenshots
    '/tmp/',
    process.env.TMPDIR || '/tmp'
  ];
  return safePatterns.some(safePath => fullPath.startsWith(safePath));
}

/**
 * Check if a file is an image based on extension
 */
export function isImageFile(filePath: string): boolean {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico', '.svg'];
  const ext = filePath.toLowerCase().split('.').pop();
  return ext ? imageExtensions.includes(`.${ext}`) : false;
}

type FileContentResult = { path: string; fileName: string; content: string; size?: number; modifiedAt?: string; isImage?: boolean; mimeType?: string; error?: string };

function readDirectoryContent(fullPath: string, filePath: string, fileName: string): FileContentResult {
  try {
    const entries = readdirSync(fullPath, { withFileTypes: true });
    const listing = entries
      .filter(e => !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map(e => e.isDirectory() ? `${e.name}/` : e.name)
      .join('\n');
    return { path: filePath, fileName, content: listing, size: listing.length };
  } catch {
    return { path: filePath, fileName, content: '', error: 'Cannot read directory' };
  }
}

function readImageContent(fullPath: string, filePath: string, fileName: string, stats: { size: number; mtime: Date }): FileContentResult {
  const buffer = readFileSync(fullPath);
  const ext = fullPath.toLowerCase().split('.').pop() || 'png';
  const mimeType = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return {
    path: filePath, fileName,
    content: buffer.toString('base64'),
    size: stats.size, modifiedAt: stats.mtime.toISOString(),
    isImage: true, mimeType
  };
}

function readTextContent(fullPath: string, filePath: string, fileName: string, stats: { size: number; mtime: Date }): FileContentResult {
  return {
    path: filePath, fileName,
    content: readFileSync(fullPath, 'utf-8'),
    size: stats.size, modifiedAt: stats.mtime.toISOString()
  };
}

/**
 * Read file content for context injection
 */
export function readFileContent(filePath: string, workingDir: string): FileContentResult {
  try {
    const fullPath = filePath.startsWith('/') ? filePath : join(workingDir, filePath);
    const fileName = fullPath.split(sep).pop() || filePath;

    const normalizedPath = join(fullPath);
    const isInWorkingDir = normalizedPath.startsWith(join(workingDir));
    if (!isInWorkingDir && !isPathInSafeLocation(normalizedPath)) {
      return { path: filePath, fileName, content: '', error: 'Access denied: path outside allowed locations' };
    }

    if (!existsSync(fullPath)) {
      return { path: filePath, fileName, content: '', error: 'File not found' };
    }

    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      return readDirectoryContent(fullPath, filePath, fileName);
    }

    const isImage = isImageFile(fullPath);
    const MAX_FILE_SIZE = isImage ? 10 * 1024 * 1024 : 1024 * 1024;
    if (stats.size > MAX_FILE_SIZE) {
      return { path: filePath, fileName, content: '', size: stats.size, error: `File too large (${Math.round(stats.size / 1024)}KB). Maximum is ${isImage ? '10MB' : '1MB'}.` };
    }

    return isImage
      ? readImageContent(fullPath, filePath, fileName, stats)
      : readTextContent(fullPath, filePath, fileName, stats);
  } catch (error: any) {
    console.error('[FileUtils] Error reading file:', error);
    return { path: filePath, fileName: filePath.split(sep).pop() || filePath, content: '', error: error.message || 'Failed to read file' };
  }
}
