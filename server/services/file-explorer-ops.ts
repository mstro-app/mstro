// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * File Explorer Operations — CRUD for files/directories in the working directory.
 * All paths are validated to prevent path traversal outside workingDir.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
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

export interface DirectoryEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modifiedAt?: string
}

export interface FileOperationResult {
  success: boolean
  error?: string
  path?: string
}

export interface ListDirectoryResult {
  success: boolean
  entries?: DirectoryEntry[]
  error?: string
}

export function listDirectory(
  dirPath: string,
  workingDir: string,
  showHidden: boolean = false
): ListDirectoryResult {
  if (containsDangerousPatterns(dirPath)) {
    console.error(`[FileService] SECURITY: Dangerous pattern in path: "${dirPath}"`)
    return { success: false, error: 'Invalid path: contains dangerous patterns' }
  }

  const validation = validatePathWithinWorkingDir(dirPath, workingDir)
  if (!validation.valid) {
    return { success: false, error: validation.error }
  }

  const resolvedPath = validation.resolvedPath

  try {
    if (!existsSync(resolvedPath)) {
      return { success: false, error: 'Directory not found' }
    }

    const stats = statSync(resolvedPath)
    if (!stats.isDirectory()) {
      return { success: false, error: 'Path is not a directory' }
    }

    const entries = readdirSync(resolvedPath, { withFileTypes: true })
    const directoryEntries: DirectoryEntry[] = entries
      .filter(entry => showHidden || !entry.name.startsWith('.'))
      .map(entry => {
        const entryPath = join(resolvedPath, entry.name)
        const isDir = entry.isDirectory()

        let size: number | undefined
        let modifiedAt: string | undefined
        try {
          const entryStats = statSync(entryPath)
          modifiedAt = entryStats.mtime.toISOString()
          if (!isDir) size = entryStats.size
        } catch { /* skip */ }

        const relativePath = entryPath.replace(`${workingDir}/`, '')
        return { name: entry.name, path: relativePath, type: isDir ? 'directory' : 'file', size, modifiedAt } as DirectoryEntry
      })

    directoryEntries.sort((a, b) => {
      if (a.type === 'directory' && b.type === 'file') return -1
      if (a.type === 'file' && b.type === 'directory') return 1
      return a.name.localeCompare(b.name)
    })

    return { success: true, entries: directoryEntries }
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EACCES') {
      return { success: false, error: 'Permission denied' }
    }
    console.error('[FileService] Error listing directory:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to list directory' }
  }
}

export function writeFile(
  filePath: string,
  content: string,
  workingDir: string,
  encoding?: 'base64'
): FileOperationResult {
  if (containsDangerousPatterns(filePath)) {
    console.error(`[FileService] SECURITY: Dangerous pattern in path: "${filePath}"`)
    return { success: false, error: 'Invalid path: contains dangerous patterns' }
  }

  const validation = validatePathWithinWorkingDir(filePath, workingDir)
  if (!validation.valid) {
    return { success: false, error: validation.error }
  }

  const resolvedPath = validation.resolvedPath

  try {
    const parentDir = dirname(resolvedPath)
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })

    if (existsSync(resolvedPath)) {
      const stats = statSync(resolvedPath)
      if (stats.isDirectory()) {
        return { success: false, error: 'Cannot write to a directory' }
      }
    }

    if (encoding === 'base64') {
      writeFileSync(resolvedPath, Buffer.from(content, 'base64'))
    } else {
      writeFileSync(resolvedPath, content, 'utf-8')
    }
    return { success: true, path: resolvedPath.replace(`${workingDir}/`, '') }
  } catch (error: unknown) {
    console.error('[FileService] Error writing file:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to write file' }
  }
}

export function createFile(
  filePath: string,
  workingDir: string
): FileOperationResult {
  if (containsDangerousPatterns(filePath)) {
    console.error(`[FileService] SECURITY: Dangerous pattern in path: "${filePath}"`)
    return { success: false, error: 'Invalid path: contains dangerous patterns' }
  }

  const validation = validatePathWithinWorkingDir(filePath, workingDir)
  if (!validation.valid) {
    return { success: false, error: validation.error }
  }

  const resolvedPath = validation.resolvedPath

  try {
    if (existsSync(resolvedPath)) {
      return { success: false, error: 'File already exists' }
    }

    const parentDir = dirname(resolvedPath)
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })

    writeFileSync(resolvedPath, '', 'utf-8')
    return { success: true, path: resolvedPath.replace(`${workingDir}/`, '') }
  } catch (error: unknown) {
    console.error('[FileService] Error creating file:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create file' }
  }
}

export function createDirectory(
  dirPath: string,
  workingDir: string
): FileOperationResult {
  if (containsDangerousPatterns(dirPath)) {
    console.error(`[FileService] SECURITY: Dangerous pattern in path: "${dirPath}"`)
    return { success: false, error: 'Invalid path: contains dangerous patterns' }
  }

  const validation = validatePathWithinWorkingDir(dirPath, workingDir)
  if (!validation.valid) {
    return { success: false, error: validation.error }
  }

  const resolvedPath = validation.resolvedPath

  try {
    if (existsSync(resolvedPath)) {
      const stats = statSync(resolvedPath)
      if (stats.isDirectory()) {
        return { success: false, error: 'Directory already exists' }
      }
      return { success: false, error: 'A file with that name already exists' }
    }

    mkdirSync(resolvedPath, { recursive: true })
    return { success: true, path: resolvedPath.replace(`${workingDir}/`, '') }
  } catch (error: unknown) {
    console.error('[FileService] Error creating directory:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create directory' }
  }
}

export function deleteFile(
  targetPath: string,
  workingDir: string
): FileOperationResult {
  if (containsDangerousPatterns(targetPath)) {
    console.error(`[FileService] SECURITY: Dangerous pattern in path: "${targetPath}"`)
    return { success: false, error: 'Invalid path: contains dangerous patterns' }
  }

  const validation = validatePathWithinWorkingDir(targetPath, workingDir)
  if (!validation.valid) {
    return { success: false, error: validation.error }
  }

  const resolvedPath = validation.resolvedPath

  if (resolvedPath === workingDir || resolvedPath === `${workingDir}/`) {
    console.error(`[FileService] SECURITY: Attempted to delete working directory: "${resolvedPath}"`)
    return { success: false, error: 'Cannot delete the working directory' }
  }

  try {
    if (!existsSync(resolvedPath)) {
      return { success: false, error: 'File or directory not found' }
    }

    const stats = statSync(resolvedPath)

    if (stats.isDirectory()) {
      rmSync(resolvedPath, { recursive: true })
    } else {
      unlinkSync(resolvedPath)
    }

    return { success: true, path: resolvedPath.replace(`${workingDir}/`, '') }
  } catch (error: unknown) {
    console.error('[FileService] Error deleting file:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to delete' }
  }
}

export function renameFile(
  oldPath: string,
  newPath: string,
  workingDir: string
): FileOperationResult {
  if (containsDangerousPatterns(oldPath)) {
    console.error(`[FileService] SECURITY: Dangerous pattern in source path: "${oldPath}"`)
    return { success: false, error: 'Invalid source path: contains dangerous patterns' }
  }
  if (containsDangerousPatterns(newPath)) {
    console.error(`[FileService] SECURITY: Dangerous pattern in destination path: "${newPath}"`)
    return { success: false, error: 'Invalid destination path: contains dangerous patterns' }
  }

  const validation = validateBothPathsWithinWorkingDir(oldPath, newPath, workingDir)
  if (!validation.valid) {
    return { success: false, error: validation.error }
  }

  const resolvedOldPath = validation.resolvedSourcePath
  const resolvedNewPath = validation.resolvedDestPath

  try {
    if (!existsSync(resolvedOldPath)) {
      return { success: false, error: 'Source file or directory not found' }
    }
    if (existsSync(resolvedNewPath)) {
      return { success: false, error: 'Destination already exists' }
    }

    const parentDir = dirname(resolvedNewPath)
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })

    renameSync(resolvedOldPath, resolvedNewPath)
    return { success: true, path: resolvedNewPath.replace(`${workingDir}/`, '') }
  } catch (error: unknown) {
    console.error('[FileService] Error renaming file:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to rename' }
  }
}
