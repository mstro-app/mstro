// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Path Utilities
 *
 * Secure path validation utilities to prevent path traversal attacks.
 * All file explorer operations MUST validate paths through these functions.
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';

export interface PathValidationResult {
  valid: boolean;
  resolvedPath: string;
  error?: string;
}

/**
 * Validate that a path is within the allowed working directory.
 * Prevents path traversal attacks using .. or absolute paths.
 *
 * @param targetPath - The path to validate (relative or absolute)
 * @param workingDir - The allowed working directory boundary
 * @returns PathValidationResult with validation status and resolved path
 */
export function validatePathWithinWorkingDir(
  targetPath: string,
  workingDir: string
): PathValidationResult {
  try {
    // Normalize the working directory to get canonical path
    const normalizedWorkingDir = resolve(workingDir);

    // Resolve the target path relative to working directory
    let resolvedPath: string;
    if (isAbsolute(targetPath)) {
      resolvedPath = resolve(targetPath);
    } else {
      resolvedPath = resolve(normalizedWorkingDir, targetPath);
    }

    // Normalize to remove any .. or . segments
    resolvedPath = normalize(resolvedPath);

    // Resolve symlinks to prevent symlink-based path traversal.
    // A symlink at /project/link -> /etc/passwd would pass the string
    // check below but actually read outside the working directory.
    // For existing paths: resolve the full path via realpath.
    // For new paths (create operations): resolve the parent directory.
    if (existsSync(resolvedPath)) {
      // If the path itself is a symlink, resolve it to the real target
      const stat = lstatSync(resolvedPath);
      if (stat.isSymbolicLink()) {
        resolvedPath = realpathSync(resolvedPath);
      }
    } else {
      // Path doesn't exist yet (create operation) — validate the parent
      const parentDir = dirname(resolvedPath);
      if (existsSync(parentDir)) {
        const realParent = realpathSync(parentDir);
        const parentWithSep = normalizedWorkingDir.endsWith('/')
          ? normalizedWorkingDir
          : `${normalizedWorkingDir}/`;
        if (realParent !== normalizedWorkingDir && !realParent.startsWith(parentWithSep)) {
          console.error(
            `[PathUtils] SECURITY: Symlink traversal in parent directory blocked. ` +
            `Target: "${targetPath}", RealParent: "${realParent}", WorkingDir: "${normalizedWorkingDir}"`
          );
          return {
            valid: false,
            resolvedPath: '',
            error: 'Access denied: parent directory resolves outside working directory'
          };
        }
      }
    }

    // Check if the resolved path starts with the working directory
    // Add trailing separator to prevent partial matches (e.g., /home/user vs /home/username)
    const workingDirWithSep = normalizedWorkingDir.endsWith('/')
      ? normalizedWorkingDir
      : `${normalizedWorkingDir}/`;

    const isWithinWorkingDir =
      resolvedPath === normalizedWorkingDir ||
      resolvedPath.startsWith(workingDirWithSep);

    if (!isWithinWorkingDir) {
      // Log security violation for monitoring
      console.error(
        `[PathUtils] SECURITY: Path traversal attempt blocked. ` +
        `Target: "${targetPath}", Resolved: "${resolvedPath}", WorkingDir: "${normalizedWorkingDir}"`
      );

      return {
        valid: false,
        resolvedPath: '',
        error: 'Access denied: path is outside working directory'
      };
    }

    return {
      valid: true,
      resolvedPath
    };
  } catch (error: unknown) {
    console.error('[PathUtils] Error validating path:', error);
    return {
      valid: false,
      resolvedPath: '',
      error: `Invalid path: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Validate both source and destination paths for rename/move operations.
 * Both paths must be within the working directory.
 *
 * @param sourcePath - The source path
 * @param destPath - The destination path
 * @param workingDir - The allowed working directory boundary
 * @returns Object with validation results for both paths
 */
export function validateBothPathsWithinWorkingDir(
  sourcePath: string,
  destPath: string,
  workingDir: string
): {
  valid: boolean;
  resolvedSourcePath: string;
  resolvedDestPath: string;
  error?: string;
} {
  const sourceValidation = validatePathWithinWorkingDir(sourcePath, workingDir);
  if (!sourceValidation.valid) {
    return {
      valid: false,
      resolvedSourcePath: '',
      resolvedDestPath: '',
      error: `Source path error: ${sourceValidation.error}`
    };
  }

  const destValidation = validatePathWithinWorkingDir(destPath, workingDir);
  if (!destValidation.valid) {
    return {
      valid: false,
      resolvedSourcePath: '',
      resolvedDestPath: '',
      error: `Destination path error: ${destValidation.error}`
    };
  }

  return {
    valid: true,
    resolvedSourcePath: sourceValidation.resolvedPath,
    resolvedDestPath: destValidation.resolvedPath
  };
}

/**
 * Get the relative path from working directory.
 * Useful for returning user-friendly paths in responses.
 *
 * @param absolutePath - The absolute path
 * @param workingDir - The working directory
 * @returns Relative path from working directory
 */
export function getRelativePath(absolutePath: string, workingDir: string): string {
  return relative(resolve(workingDir), absolutePath);
}

/**
 * Check if a path contains dangerous patterns that should be blocked.
 * This is an additional layer of defense beyond path validation.
 *
 * @param path - The path to check
 * @returns true if path contains dangerous patterns
 */
export function containsDangerousPatterns(path: string): boolean {
  const dangerousPatterns = [
    /\0/, // Null bytes
    /^~/, // Home directory expansion (should use absolute paths)
    /\$\{/, // Variable expansion
    /\$\(/, // Command substitution
  ];

  return dangerousPatterns.some(pattern => pattern.test(path));
}
