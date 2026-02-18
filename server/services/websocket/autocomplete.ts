// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Autocomplete Service
 *
 * File autocomplete with frecency scoring and fuzzy matching.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, } from 'node:path';
import Fuse, { type FuseResult } from 'fuse.js';
import {
  CACHE_TTL_MS, 
  directoryCache,
  getFileType,
  isIgnored,
  parseGitignore,
  scanDirectoryRecursiveWithDepth
} from './file-utils.js';
import type {
  AutocompleteResult,
  FileMetadata, 
  FrecencyData,
} from './types.js';

// ========== Scoring Helpers ==========

interface ScoredMatch {
  relativePath: string;
  isDirectory: boolean;
  score: number;
  matchedIndices: Array<[number, number]>;
  isRecent: boolean;
}

function compareAutocompleteResults(a: ScoredMatch, b: ScoredMatch): number {
  if (a.isRecent && !b.isRecent) return -1;
  if (!a.isRecent && b.isRecent) return 1;
  if (b.score !== a.score) return b.score - a.score;
  if (a.isDirectory && !b.isDirectory) return -1;
  if (!a.isDirectory && b.isDirectory) return 1;
  return a.relativePath.localeCompare(b.relativePath);
}

function extractFuseMatchIndices(
  result: FuseResult<FileMetadata>
): Array<[number, number]> {
  if (!result.matches) return [];

  // Prefer fileName matches (95% weight) over relativePath to avoid duplicates.
  // Using both keys produces overlapping index ranges that garble the display.
  const fileNameMatch = result.matches.find(m => m.key === 'fileName');
  if (fileNameMatch?.indices) {
    const filenameStart = result.item.relativePath.lastIndexOf('/') + 1;
    return fileNameMatch.indices.map(([start, end]) =>
      [filenameStart + start, filenameStart + end + 1] as [number, number]
    );
  }

  const pathMatch = result.matches.find(m => m.key === 'relativePath');
  if (pathMatch?.indices) {
    return pathMatch.indices.map(([start, end]) =>
      [start, end + 1] as [number, number]
    );
  }

  return [];
}

function scoreFileMatch(
  file: FileMetadata,
  baseScore: number,
  query: string,
  frecencyScore: number,
  recentFiles: Set<string>,
  calculateMatchedIndices: (text: string, query: string) => Array<[number, number]>
): ScoredMatch {
  const depthPenalty = file.depth * 20;
  const topLevelBonus = file.depth === 1 ? 200 : 0;
  const dirBonus = file.isDirectory ? 100 : 0;
  return {
    relativePath: file.relativePath,
    isDirectory: file.isDirectory,
    score: baseScore + topLevelBonus + frecencyScore - depthPenalty + dirBonus,
    matchedIndices: calculateMatchedIndices(file.relativePath, query),
    isRecent: recentFiles.has(file.relativePath)
  };
}

function shouldIncludeEntry(
  entry: { name: string; isDirectory: () => boolean },
  relativePath: string,
  gitignorePatterns: string[],
  skipDirs: Set<string>
): boolean {
  if (entry.name.startsWith('.')) return false;
  if (entry.isDirectory() && skipDirs.has(entry.name)) return false;
  if (gitignorePatterns.length > 0 && isIgnored(relativePath, gitignorePatterns)) return false;
  return true;
}

export class AutocompleteService {
  private frecencyData: FrecencyData = {};

  constructor(initialFrecencyData: FrecencyData = {}) {
    this.frecencyData = initialFrecencyData;
  }

  /**
   * Update frecency data
   */
  setFrecencyData(data: FrecencyData): void {
    this.frecencyData = data;
  }

  /**
   * Get frecency data
   */
  getFrecencyData(): FrecencyData {
    return this.frecencyData;
  }

  /**
   * Record a file selection for frecency scoring
   */
  recordFileSelection(filePath: string): void {
    const existing = this.frecencyData[filePath];
    if (existing) {
      existing.count++;
      existing.lastUsed = Date.now();
    } else {
      this.frecencyData[filePath] = {
        count: 1,
        lastUsed: Date.now()
      };
    }
  }

  /**
   * Calculate frecency score for a file
   */
  calculateFrecencyScore(filePath: string): number {
    const entry = this.frecencyData[filePath];
    if (!entry) return 0;

    const hoursSinceLastUse = (Date.now() - entry.lastUsed) / (1000 * 60 * 60);
    const recencyWeight = Math.max(0, 1 - (hoursSinceLastUse / (24 * 7)));
    const frequencyWeight = Math.log2(entry.count + 1);

    return frequencyWeight * (0.3 + 0.7 * recencyWeight) * 100;
  }

  /**
   * Calculate matched character indices for highlighting
   */
  private calculateMatchedIndices(text: string, query: string): Array<[number, number]> {
    if (!query) return [];

    const indices: Array<[number, number]> = [];
    const textLower = text.toLowerCase();
    const queryLower = query.toLowerCase();

    let searchStart = 0;
    while (searchStart < textLower.length) {
      const idx = textLower.indexOf(queryLower, searchStart);
      if (idx === -1) break;
      indices.push([idx, idx + queryLower.length]);
      searchStart = idx + 1;
    }

    return indices;
  }

  /**
   * Get file completions for autocomplete with directory-scoped navigation
   */
  getFileCompletions(partialPath: string, workingDir: string): AutocompleteResult[] {
    try {
      // Handle @ symbol prefix for file autocomplete
      const isAtSymbol = partialPath.startsWith('@');
      const cleanPath = isAtSymbol ? partialPath.substring(1) : partialPath;

      // Parse .gitignore patterns
      const gitignorePatterns = parseGitignore(workingDir);

      // Directory-scoped completion: When path ends with '/', show direct children
      if (cleanPath.endsWith('/')) {
        return this.getDirectoryContentsEnhanced(cleanPath, workingDir, gitignorePatterns);
      }

      // STRICT PATH SEGMENT MATCHING
      const lastSlashIndex = cleanPath.lastIndexOf('/');
      let scopedDir = workingDir;
      let searchQuery = cleanPath;
      let pathPrefix = '';
      let maxDepth = 10;

      if (lastSlashIndex !== -1) {
        const dirPath = cleanPath.substring(0, lastSlashIndex);
        const candidateDir = join(workingDir, dirPath);

        if (existsSync(candidateDir) && statSync(candidateDir).isDirectory()) {
          scopedDir = candidateDir;
          searchQuery = cleanPath.substring(lastSlashIndex + 1);
          pathPrefix = `${dirPath}/`;
          maxDepth = 3;
        }
      } else if (cleanPath === '') {
        maxDepth = 4;
      }

      const filesWithMetadata = this.getFilesWithCache(scopedDir, gitignorePatterns, maxDepth, pathPrefix);

      // Track which files are recent
      const recentFiles = new Set<string>();
      for (const file of filesWithMetadata) {
        if (this.calculateFrecencyScore(file.relativePath) > 0) {
          recentFiles.add(file.relativePath);
        }
      }

      const scoredMatches = searchQuery === ''
        ? this.scoreEmptyQuery(filesWithMetadata)
        : this.scoreWithQuery(filesWithMetadata, searchQuery, recentFiles);

      const results: AutocompleteResult[] = scoredMatches.slice(0, 15).map(file => {
        const displayPath = file.isDirectory ? `${file.relativePath}/` : file.relativePath;
        return {
          value: displayPath,
          label: displayPath,
          isDirectory: file.isDirectory,
          isRecent: file.isRecent,
          fileType: file.isDirectory ? 'directory' : getFileType(file.relativePath),
          matchedIndices: file.matchedIndices
        };
      });

      return results;
    } catch (error) {
      console.error('[AutocompleteService] Error getting file completions:', error);
      return [];
    }
  }

  /**
   * Get files with caching support
   */
  private getFilesWithCache(scopedDir: string, gitignorePatterns: string[], maxDepth: number, pathPrefix: string): FileMetadata[] {
    const patternsHash = gitignorePatterns.length > 0
      ? gitignorePatterns.slice(0, 20).join('|').slice(0, 100)
      : 'none';
    const cacheKey = `${scopedDir}:${maxDepth}:${patternsHash}`;

    const cached = directoryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.files.map(f => ({ ...f, relativePath: pathPrefix + f.relativePath }));
    }

    const allFiles = scanDirectoryRecursiveWithDepth(scopedDir, scopedDir, gitignorePatterns, [], 2000, maxDepth);
    const filesForCache = allFiles.map(file => {
      const fileName = file.relativePath.split('/').pop() || '';
      return {
        relativePath: file.relativePath,
        isDirectory: file.isDirectory,
        fileName,
        depth: file.relativePath.split('/').length
      };
    });
    directoryCache.set(cacheKey, { files: filesForCache, timestamp: Date.now() });

    return filesForCache.map(f => ({ ...f, relativePath: pathPrefix + f.relativePath }));
  }

  /**
   * Score files when no search query is provided
   */
  private scoreEmptyQuery(files: FileMetadata[]): ScoredMatch[] {
    return files
      .map(file => {
        const frecencyScore = this.calculateFrecencyScore(file.relativePath);
        const depthPenalty = file.depth * 30;
        const directoryBonus = file.isDirectory ? 50 : 0;
        const topLevelBonus = file.depth === 1 ? 500 : 0;
        return {
          relativePath: file.relativePath,
          isDirectory: file.isDirectory,
          score: frecencyScore + topLevelBonus + directoryBonus - depthPenalty,
          matchedIndices: [] as Array<[number, number]>,
          isRecent: frecencyScore > 0
        };
      })
      .sort(compareAutocompleteResults);
  }

  /**
   * Score files against a search query using prefix, contains, and fuzzy matching
   */
  private scoreWithQuery(files: FileMetadata[], searchQuery: string, recentFiles: Set<string>): ScoredMatch[] {
    const query = searchQuery.toLowerCase();
    const prefixMatches: FileMetadata[] = [];
    const filenameContainsMatches: FileMetadata[] = [];
    const pathContainsMatches: FileMetadata[] = [];
    const otherFiles: FileMetadata[] = [];

    for (const file of files) {
      const fileNameLower = file.fileName.toLowerCase();
      const relativePathLower = file.relativePath.toLowerCase();

      if (fileNameLower.startsWith(query)) {
        prefixMatches.push(file);
      } else if (fileNameLower.includes(query)) {
        filenameContainsMatches.push(file);
      } else if (relativePathLower.includes(query)) {
        pathContainsMatches.push(file);
      } else {
        otherFiles.push(file);
      }
    }

    const calcIndices = this.calculateMatchedIndices.bind(this);
    const calcFrec = (path: string) => this.calculateFrecencyScore(path);

    const scored = [
      ...prefixMatches.map(f => {
        const exactBonus = f.fileName.toLowerCase() === query ? 500 : 0;
        return scoreFileMatch(f, 2000 + exactBonus, query, calcFrec(f.relativePath), recentFiles, calcIndices);
      }),
      ...filenameContainsMatches.map(f => scoreFileMatch(f, 1000, query, calcFrec(f.relativePath), recentFiles, calcIndices)),
      ...pathContainsMatches.map(f => scoreFileMatch(f, 500, query, calcFrec(f.relativePath), recentFiles, calcIndices)),
      ...this.performFuzzySearch(otherFiles, searchQuery, prefixMatches.length + filenameContainsMatches.length, recentFiles),
    ];

    scored.sort((a, b) => b.score - a.score);

    if (searchQuery.length >= 2 && scored.length > 0) {
      const minScoreThreshold = Math.max(scored[0].score * 0.05, 10);
      return scored.filter(m => m.score >= minScoreThreshold);
    }

    return scored;
  }

  /**
   * Perform fuzzy search when few good matches exist
   */
  private performFuzzySearch(otherFiles: FileMetadata[], searchQuery: string, goodMatchCount: number, recentFiles: Set<string>): ScoredMatch[] {
    if (goodMatchCount >= 3 || otherFiles.length === 0) return [];

    const query = searchQuery.toLowerCase();
    const threshold = query.length <= 2 ? 0.2 : query.length <= 4 ? 0.3 : 0.35;
    const fuse = new Fuse(otherFiles, {
      keys: [
        { name: 'fileName', weight: 0.95 },
        { name: 'relativePath', weight: 0.05 }
      ],
      includeScore: true,
      includeMatches: true,
      threshold,
      ignoreLocation: true,
      minMatchCharLength: 2,
      findAllMatches: false
    });

    return fuse.search(searchQuery).slice(0, 5).map(result => {
      const fuseScore = result.score !== undefined ? (1 - result.score) * 200 : 0;
      return {
        relativePath: result.item.relativePath,
        isDirectory: result.item.isDirectory,
        score: fuseScore + this.calculateFrecencyScore(result.item.relativePath) - (result.item.depth * 10),
        matchedIndices: extractFuseMatchIndices(result),
        isRecent: recentFiles.has(result.item.relativePath)
      };
    });
  }

  /**
   * Get direct contents of a directory with enhanced metadata
   */
  private getDirectoryContentsEnhanced(
    dirPath: string,
    workingDir: string,
    gitignorePatterns: string[]
  ): AutocompleteResult[] {
    try {
      const targetDir = join(workingDir, dirPath);

      if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
        return [];
      }

      const entries = readdirSync(targetDir, { withFileTypes: true });

      const results: Array<{
        value: string;
        label: string;
        isDir: boolean;
        frecency: number;
        fileType: string;
      }> = [];

      const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-ssr', '.git', '__pycache__', '.next', '.turbo', 'build', '.cache', 'coverage']);
      for (const entry of entries) {
        const relativePath = dirPath + entry.name;

        if (!shouldIncludeEntry(entry, relativePath, gitignorePatterns, SKIP_DIRS)) {
          continue;
        }

        const isDir = entry.isDirectory();
        const displayPath = isDir ? `${relativePath}/` : relativePath;

        results.push({
          value: displayPath,
          label: displayPath,
          isDir,
          frecency: this.calculateFrecencyScore(relativePath),
          fileType: isDir ? 'directory' : getFileType(relativePath)
        });
      }

      results.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        if (b.frecency !== a.frecency) return b.frecency - a.frecency;
        return a.label.localeCompare(b.label);
      });

      return results.slice(0, 20).map(r => ({
        value: r.value,
        label: r.label,
        isDirectory: r.isDir,
        isRecent: r.frecency > 0,
        fileType: r.fileType,
        matchedIndices: []
      }));
    } catch (error) {
      console.error('[AutocompleteService] Error getting directory contents:', error);
      return [];
    }
  }
}
