// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * File Service
 *
 * Handles file autocomplete, directory operations, and file explorer features.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync, 
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  containsDangerousPatterns, 
  validateBothPathsWithinWorkingDir,
  validatePathWithinWorkingDir
} from './pathUtils.js'

export interface FileItem {
  name: string
  path: string
  isDirectory: boolean
  score?: number
}

/**
 * Internal type for scored file items (score is required)
 */
interface ScoredFileItem {
  name: string
  path: string
  isDirectory: boolean
  score: number
}

/**
 * Directory entry with metadata for file explorer
 */
export interface DirectoryEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modifiedAt?: string
}

/**
 * Result type for file operations
 */
export interface FileOperationResult {
  success: boolean
  path?: string
  error?: string
}

/**
 * Result type for list directory operation
 */
export interface ListDirectoryResult {
  success: boolean
  entries?: DirectoryEntry[]
  error?: string
}

export class FileService {
  private workingDirectory: string
  private skipDirs = ['node_modules', '.git', '.mstro', 'dist', 'build', '.next', 'coverage', '.vscode', '.idea']

  constructor(workingDirectory: string) {
    this.workingDirectory = workingDirectory
  }

  /**
   * Get all files recursively with optional filtering
   */
  getAllFiles(
    _baseDir: 'working' | 'scores' = 'working',
    filter?: string,
    limit: number = 10
  ): FileItem[] {
    // Note: 'scores' baseDir kept for API compatibility, but maps to working directory
    const directory = this.workingDirectory

    let files = this.scanDirectory(directory, directory)

    // Apply filter if provided
    if (filter) {
      files = this.filterAndScore(files, filter)
    }

    // Sort by score if filtered, otherwise by type and name
    if (filter) {
      files.sort((a, b) => (b.score || 0) - (a.score || 0))
    } else {
      files.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.name.localeCompare(b.name)
      })
    }

    return files.slice(0, limit)
  }

  /**
   * Recursively scan directory
   */
  private scanDirectory(
    dir: string,
    baseDir: string,
    results: FileItem[] = []
  ): FileItem[] {
    try {
      // Skip common ignore directories
      const dirName = dir.split('/').pop() || ''
      if (this.skipDirs.includes(dirName)) {
        return results
      }

      const entries = readdirSync(dir, { withFileTypes: true })

      for (const entry of entries) {
        // Skip hidden files and ignore directories
        if (entry.name.startsWith('.') || this.skipDirs.includes(entry.name)) {
          continue
        }

        const fullPath = join(dir, entry.name)
        const relativePath = fullPath.replace(`${baseDir}/`, '')

        results.push({
          name: entry.name,
          path: relativePath,
          isDirectory: entry.isDirectory()
        })

        // Recursively search directories (with depth limit)
        if (entry.isDirectory() && results.length < 1000) {
          this.scanDirectory(fullPath, baseDir, results)
        }
      }
    } catch (_error) {
      // Skip directories we can't read
    }

    return results
  }

  /**
   * Filter files and assign relevance scores
   */
  private filterAndScore(files: FileItem[], filter: string): FileItem[] {
    const filterLower = filter.toLowerCase()

    const scoredFiles: ScoredFileItem[] = []

    for (const file of files) {
      const nameLower = file.name.toLowerCase()
      const pathLower = file.path.toLowerCase()

      let score = 0

      // Highest priority: starts with filter
      if (nameLower.startsWith(filterLower)) {
        score = 1000
      }
      // High priority: word in path starts with filter
      else if (pathLower.split('/').some(part => part.startsWith(filterLower))) {
        score = 500
      }
      // Medium priority: contains filter
      else if (nameLower.includes(filterLower)) {
        score = 100
      }
      // Low priority: path contains filter
      else if (pathLower.includes(filterLower)) {
        score = 10
      }
      else {
        continue // Doesn't match, skip
      }

      // Boost score for shorter paths (prefer files closer to root)
      score += (50 - Math.min(50, file.path.split('/').length * 5))

      scoredFiles.push({
        name: file.name,
        path: file.path,
        isDirectory: file.isDirectory,
        score
      })
    }

    return scoredFiles
  }

  /**
   * Get file statistics
   */
  getFileStats(path: string, _baseDir: 'working' | 'scores' = 'working') {
    try {
      // Note: 'scores' baseDir kept for API compatibility, but maps to working directory
      const fullPath = join(this.workingDirectory, path)
      const stats = statSync(fullPath)

      return {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile()
      }
    } catch (_error) {
      return null
    }
  }
}

// ============================================================================
// File Explorer Functions (standalone exports for WebSocket handler)
// ============================================================================

/**
 * List immediate children of a directory.
 * Returns entries sorted: directories first, then files, alphabetically.
 *
 * @param dirPath - Directory path (relative to workingDir or absolute)
 * @param workingDir - Working directory boundary
 * @param showHidden - Whether to show hidden files (starting with .)
 * @returns ListDirectoryResult with entries array or error
 */
export function listDirectory(
  dirPath: string,
  workingDir: string,
  showHidden: boolean = false
): ListDirectoryResult {
  // Check for dangerous patterns first
  if (containsDangerousPatterns(dirPath)) {
    console.error(`[FileService] SECURITY: Dangerous pattern in path: "${dirPath}"`)
    return {
      success: false,
      error: 'Invalid path: contains dangerous patterns'
    }
  }

  // Validate path is within working directory
  const validation = validatePathWithinWorkingDir(dirPath, workingDir)
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error
    }
  }

  const resolvedPath = validation.resolvedPath

  try {
    // Check if path exists and is a directory
    if (!existsSync(resolvedPath)) {
      return {
        success: false,
        error: 'Directory not found'
      }
    }

    const stats = statSync(resolvedPath)
    if (!stats.isDirectory()) {
      return {
        success: false,
        error: 'Path is not a directory'
      }
    }

    // Read directory entries
    const entries = readdirSync(resolvedPath, { withFileTypes: true })

    // Map to DirectoryEntry objects
    const directoryEntries: DirectoryEntry[] = entries
      .filter(entry => {
        // Filter hidden files unless showHidden is true
        if (!showHidden && entry.name.startsWith('.')) {
          return false
        }
        return true
      })
      .map(entry => {
        const entryPath = join(resolvedPath, entry.name)
        const isDir = entry.isDirectory()

        // Get stats for size and modification time
        let size: number | undefined
        let modifiedAt: string | undefined

        try {
          const entryStats = statSync(entryPath)
          modifiedAt = entryStats.mtime.toISOString()
          if (!isDir) {
            size = entryStats.size
          }
        } catch {
          // Skip stats if we can't read them
        }

        // Return path relative to workingDir for consistency
        const relativePath = entryPath.replace(`${workingDir}/`, '')

        return {
          name: entry.name,
          path: relativePath,
          type: isDir ? 'directory' : 'file',
          size,
          modifiedAt
        } as DirectoryEntry
      })

    // Sort: directories first, then files, alphabetically within each group
    directoryEntries.sort((a, b) => {
      if (a.type === 'directory' && b.type === 'file') return -1
      if (a.type === 'file' && b.type === 'directory') return 1
      return a.name.localeCompare(b.name)
    })

    return {
      success: true,
      entries: directoryEntries
    }
  } catch (error: any) {
    // Handle permission errors gracefully
    if (error.code === 'EACCES') {
      return {
        success: false,
        error: 'Permission denied'
      }
    }

    console.error('[FileService] Error listing directory:', error)
    return {
      success: false,
      error: error.message || 'Failed to list directory'
    }
  }
}

/**
 * Write content to a file.
 * Creates parent directories if needed.
 *
 * @param filePath - File path (relative to workingDir or absolute)
 * @param content - Content to write
 * @param workingDir - Working directory boundary
 * @returns FileOperationResult
 */
export function writeFile(
  filePath: string,
  content: string,
  workingDir: string
): FileOperationResult {
  // Check for dangerous patterns first
  if (containsDangerousPatterns(filePath)) {
    console.error(`[FileService] SECURITY: Dangerous pattern in path: "${filePath}"`)
    return {
      success: false,
      error: 'Invalid path: contains dangerous patterns'
    }
  }

  // Validate path is within working directory
  const validation = validatePathWithinWorkingDir(filePath, workingDir)
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error
    }
  }

  const resolvedPath = validation.resolvedPath

  try {
    // Create parent directories if they don't exist
    const parentDir = dirname(resolvedPath)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }

    // Check if target is a directory (can't write to directory)
    if (existsSync(resolvedPath)) {
      const stats = statSync(resolvedPath)
      if (stats.isDirectory()) {
        return {
          success: false,
          error: 'Cannot write to a directory'
        }
      }
    }

    // Write the file
    writeFileSync(resolvedPath, content, 'utf-8')

    return {
      success: true,
      path: resolvedPath.replace(`${workingDir}/`, '')
    }
  } catch (error: any) {
    console.error('[FileService] Error writing file:', error)
    return {
      success: false,
      error: error.message || 'Failed to write file'
    }
  }
}

/**
 * Create an empty file.
 * Returns error if file already exists.
 *
 * @param filePath - File path (relative to workingDir or absolute)
 * @param workingDir - Working directory boundary
 * @returns FileOperationResult
 */
export function createFile(
  filePath: string,
  workingDir: string
): FileOperationResult {
  // Check for dangerous patterns first
  if (containsDangerousPatterns(filePath)) {
    console.error(`[FileService] SECURITY: Dangerous pattern in path: "${filePath}"`)
    return {
      success: false,
      error: 'Invalid path: contains dangerous patterns'
    }
  }

  // Validate path is within working directory
  const validation = validatePathWithinWorkingDir(filePath, workingDir)
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error
    }
  }

  const resolvedPath = validation.resolvedPath

  try {
    // Check if file already exists
    if (existsSync(resolvedPath)) {
      return {
        success: false,
        error: 'File already exists'
      }
    }

    // Create parent directories if needed
    const parentDir = dirname(resolvedPath)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }

    // Create empty file
    writeFileSync(resolvedPath, '', 'utf-8')

    return {
      success: true,
      path: resolvedPath.replace(`${workingDir}/`, '')
    }
  } catch (error: any) {
    console.error('[FileService] Error creating file:', error)
    return {
      success: false,
      error: error.message || 'Failed to create file'
    }
  }
}

/**
 * Create a directory (recursively if needed).
 * Returns error if directory already exists.
 *
 * @param dirPath - Directory path (relative to workingDir or absolute)
 * @param workingDir - Working directory boundary
 * @returns FileOperationResult
 */
export function createDirectory(
  dirPath: string,
  workingDir: string
): FileOperationResult {
  // Check for dangerous patterns first
  if (containsDangerousPatterns(dirPath)) {
    console.error(`[FileService] SECURITY: Dangerous pattern in path: "${dirPath}"`)
    return {
      success: false,
      error: 'Invalid path: contains dangerous patterns'
    }
  }

  // Validate path is within working directory
  const validation = validatePathWithinWorkingDir(dirPath, workingDir)
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error
    }
  }

  const resolvedPath = validation.resolvedPath

  try {
    // Check if path already exists
    if (existsSync(resolvedPath)) {
      const stats = statSync(resolvedPath)
      if (stats.isDirectory()) {
        return {
          success: false,
          error: 'Directory already exists'
        }
      } else {
        return {
          success: false,
          error: 'A file with that name already exists'
        }
      }
    }

    // Create directory recursively
    mkdirSync(resolvedPath, { recursive: true })

    return {
      success: true,
      path: resolvedPath.replace(`${workingDir}/`, '')
    }
  } catch (error: any) {
    console.error('[FileService] Error creating directory:', error)
    return {
      success: false,
      error: error.message || 'Failed to create directory'
    }
  }
}

/**
 * Delete a file or EMPTY directory.
 * For safety, only deletes empty directories.
 *
 * CRITICAL: Validates path is within workingDir to prevent path traversal.
 *
 * @param targetPath - Path to delete (relative to workingDir or absolute)
 * @param workingDir - Working directory boundary
 * @returns FileOperationResult
 */
export function deleteFile(
  targetPath: string,
  workingDir: string
): FileOperationResult {
  // Check for dangerous patterns first
  if (containsDangerousPatterns(targetPath)) {
    console.error(`[FileService] SECURITY: Dangerous pattern in path: "${targetPath}"`)
    return {
      success: false,
      error: 'Invalid path: contains dangerous patterns'
    }
  }

  // Validate path is within working directory
  const validation = validatePathWithinWorkingDir(targetPath, workingDir)
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error
    }
  }

  const resolvedPath = validation.resolvedPath

  // Additional safety: prevent deleting the working directory itself
  if (resolvedPath === workingDir || resolvedPath === `${workingDir}/`) {
    console.error(`[FileService] SECURITY: Attempted to delete working directory: "${resolvedPath}"`)
    return {
      success: false,
      error: 'Cannot delete the working directory'
    }
  }

  try {
    // Check if path exists
    if (!existsSync(resolvedPath)) {
      return {
        success: false,
        error: 'File or directory not found'
      }
    }

    const stats = statSync(resolvedPath)

    if (stats.isDirectory()) {
      // Only delete empty directories for safety
      const contents = readdirSync(resolvedPath)
      if (contents.length > 0) {
        return {
          success: false,
          error: 'Directory is not empty. Only empty directories can be deleted.'
        }
      }

      rmdirSync(resolvedPath)
    } else {
      unlinkSync(resolvedPath)
    }

    return {
      success: true,
      path: resolvedPath.replace(`${workingDir}/`, '')
    }
  } catch (error: any) {
    console.error('[FileService] Error deleting file:', error)
    return {
      success: false,
      error: error.message || 'Failed to delete'
    }
  }
}

/**
 * Rename or move a file/directory.
 * Both source and destination must be within workingDir.
 *
 * @param oldPath - Current path (relative to workingDir or absolute)
 * @param newPath - New path (relative to workingDir or absolute)
 * @param workingDir - Working directory boundary
 * @returns FileOperationResult
 */
export function renameFile(
  oldPath: string,
  newPath: string,
  workingDir: string
): FileOperationResult {
  // Check for dangerous patterns in both paths
  if (containsDangerousPatterns(oldPath)) {
    console.error(`[FileService] SECURITY: Dangerous pattern in source path: "${oldPath}"`)
    return {
      success: false,
      error: 'Invalid source path: contains dangerous patterns'
    }
  }

  if (containsDangerousPatterns(newPath)) {
    console.error(`[FileService] SECURITY: Dangerous pattern in destination path: "${newPath}"`)
    return {
      success: false,
      error: 'Invalid destination path: contains dangerous patterns'
    }
  }

  // Validate both paths are within working directory
  const validation = validateBothPathsWithinWorkingDir(oldPath, newPath, workingDir)
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error
    }
  }

  const resolvedOldPath = validation.resolvedSourcePath
  const resolvedNewPath = validation.resolvedDestPath

  try {
    // Check if source exists
    if (!existsSync(resolvedOldPath)) {
      return {
        success: false,
        error: 'Source file or directory not found'
      }
    }

    // Check if destination already exists
    if (existsSync(resolvedNewPath)) {
      return {
        success: false,
        error: 'Destination already exists'
      }
    }

    // Create parent directories for destination if needed
    const parentDir = dirname(resolvedNewPath)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }

    // Perform the rename
    renameSync(resolvedOldPath, resolvedNewPath)

    return {
      success: true,
      path: resolvedNewPath.replace(`${workingDir}/`, '')
    }
  } catch (error: any) {
    console.error('[FileService] Error renaming file:', error)
    return {
      success: false,
      error: error.message || 'Failed to rename'
    }
  }
}
