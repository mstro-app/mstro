// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * File Service — Autocomplete and file scoring for the working directory.
 *
 * Standalone file-explorer CRUD (listDirectory, writeFile, etc.) lives in
 * file-explorer-ops.ts and is re-exported here for backward compatibility.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type {
  DirectoryEntry,
  FileOperationResult,
  ListDirectoryResult,
} from './file-explorer-ops.js'
// Re-export standalone file explorer functions & types
export {
  createDirectory,
  createFile,
  deleteFile,
  listDirectory,
  renameFile,
  writeFile,
} from './file-explorer-ops.js'

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
