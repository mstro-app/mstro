// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Quality Persistence — Persists quality config, reports, and history
 * to .mstro/quality/ in the working directory.
 *
 * Files:
 *   .mstro/quality/config.json       — Directory list (paths + labels)
 *   .mstro/quality/reports/<slug>.json — Latest full report per directory
 *   .mstro/quality/history.json       — Score history entries for trend tracking
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QualityResults } from './quality-service.js';

// ============================================================================
// Types
// ============================================================================

export interface QualityDirectoryConfig {
  path: string;
  label: string;
}

interface QualityConfig {
  directories: QualityDirectoryConfig[];
}

export interface HistoryDirectoryEntry {
  path: string;
  score: number;
  grade: string;
}

export interface QualityHistoryEntry {
  timestamp: string;
  overall: number;
  grade: string;
  directories: HistoryDirectoryEntry[];
}

interface QualityHistory {
  entries: QualityHistoryEntry[];
}

export interface QualityPersistedState {
  directories: QualityDirectoryConfig[];
  reports: Record<string, QualityResults>;
  history: QualityHistoryEntry[];
}

// ============================================================================
// Helpers
// ============================================================================

const MAX_HISTORY_ENTRIES = 100;
const MAX_REPORT_HISTORY_FILES = 200;

function slugify(dirPath: string): string {
  if (dirPath === '.' || dirPath === './') return '_root';
  return dirPath.replace(/[/\\]/g, '_').replace(/^_+|_+$/g, '') || '_root';
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
    }
  } catch {
    // Corrupted or unreadable — return fallback
  }
  return fallback;
}

function writeJson(filePath: string, data: unknown): void {
  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[QualityPersistence] Error writing:', filePath, error);
  }
}

// ============================================================================
// Quality Persistence
// ============================================================================

export class QualityPersistence {
  private qualityDir: string;
  private reportsDir: string;
  private reportHistoryDir: string;
  private configPath: string;
  private historyPath: string;

  constructor(workingDir: string) {
    this.qualityDir = join(workingDir, '.mstro', 'quality');
    this.reportsDir = join(this.qualityDir, 'reports');
    this.reportHistoryDir = join(this.reportsDir, 'history');
    this.configPath = join(this.qualityDir, 'config.json');
    this.historyPath = join(this.qualityDir, 'history.json');
    ensureDir(this.reportsDir);
    ensureDir(this.reportHistoryDir);
  }

  // ---- Config (directory list) ----

  loadConfig(): QualityDirectoryConfig[] {
    const config = readJson<QualityConfig>(this.configPath, { directories: [] });
    return config.directories;
  }

  saveConfig(directories: QualityDirectoryConfig[]): void {
    writeJson(this.configPath, { directories });
  }

  addDirectory(path: string, label: string): void {
    const dirs = this.loadConfig();
    if (!dirs.some((d) => d.path === path)) {
      dirs.push({ path, label });
      this.saveConfig(dirs);
    }
  }

  removeDirectory(path: string): void {
    const dirs = this.loadConfig().filter((d) => d.path !== path);
    this.saveConfig(dirs);
  }

  // ---- Reports (latest per directory) ----

  loadReport(dirPath: string): QualityResults | null {
    const slug = slugify(dirPath);
    const reportPath = join(this.reportsDir, `${slug}.json`);
    return readJson<QualityResults | null>(reportPath, null);
  }

  saveReport(dirPath: string, results: QualityResults): void {
    const slug = slugify(dirPath);
    const reportPath = join(this.reportsDir, `${slug}.json`);
    writeJson(reportPath, results);

    // Archive timestamped copy for historical tracking
    const ts = Date.now();
    const archivePath = join(this.reportHistoryDir, `${ts}_${slug}.json`);
    writeJson(archivePath, results);
    this.pruneReportHistory();
  }

  loadAllReports(directories: QualityDirectoryConfig[]): Record<string, QualityResults> {
    const reports: Record<string, QualityResults> = {};
    for (const dir of directories) {
      const report = this.loadReport(dir.path);
      if (report) {
        reports[dir.path] = report;
      }
    }
    return reports;
  }

  // ---- Report history pruning ----

  private pruneReportHistory(): void {
    try {
      const files = readdirSync(this.reportHistoryDir).filter((f) => f.endsWith('.json')).sort();
      if (files.length <= MAX_REPORT_HISTORY_FILES) return;
      const toRemove = files.slice(0, files.length - MAX_REPORT_HISTORY_FILES);
      for (const file of toRemove) {
        try { unlinkSync(join(this.reportHistoryDir, file)); } catch { /* ignore */ }
      }
    } catch { /* directory may not exist yet */ }
  }

  // ---- History (trend tracking) ----

  loadHistory(): QualityHistoryEntry[] {
    const history = readJson<QualityHistory>(this.historyPath, { entries: [] });
    return history.entries;
  }

  appendHistory(results: QualityResults, dirPath: string): void {
    const history = this.loadHistory();

    // Find or create entry for this timestamp batch
    // If the last entry was within 60 seconds, merge into it (for multi-dir scans)
    const now = new Date();
    const lastEntry = history[history.length - 1];
    const lastTime = lastEntry ? new Date(lastEntry.timestamp).getTime() : 0;
    const mergeWindow = 60_000; // 60 seconds

    const dirEntry: HistoryDirectoryEntry = {
      path: dirPath,
      score: results.overall,
      grade: results.grade,
    };

    if (lastEntry && now.getTime() - lastTime < mergeWindow) {
      // Merge: update or add this directory in the last entry
      const existing = lastEntry.directories.findIndex((d) => d.path === dirPath);
      if (existing >= 0) {
        lastEntry.directories[existing] = dirEntry;
      } else {
        lastEntry.directories.push(dirEntry);
      }
      // Recompute overall as average of all directories in this entry
      const totalScore = lastEntry.directories.reduce((sum, d) => sum + d.score, 0);
      lastEntry.overall = Math.round(totalScore / lastEntry.directories.length);
      lastEntry.grade = gradeFromScore(lastEntry.overall);
      lastEntry.timestamp = now.toISOString();
    } else {
      // New entry
      history.push({
        timestamp: now.toISOString(),
        overall: results.overall,
        grade: results.grade,
        directories: [dirEntry],
      });
    }

    // Trim to max entries
    while (history.length > MAX_HISTORY_ENTRIES) {
      history.shift();
    }

    writeJson(this.historyPath, { entries: history });
  }

  // ---- Code Review (persisted per directory) ----

  loadCodeReview(dirPath: string): { findings: Record<string, unknown>[]; summary: string; timestamp: string } | null {
    const slug = slugify(dirPath);
    const reviewPath = join(this.reportsDir, `${slug}-review.json`);
    return readJson<{ findings: Record<string, unknown>[]; summary: string; timestamp: string } | null>(reviewPath, null);
  }

  saveCodeReview(dirPath: string, findings: Record<string, unknown>[], summary: string): void {
    const slug = slugify(dirPath);
    const reviewPath = join(this.reportsDir, `${slug}-review.json`);
    const data = { findings, summary, timestamp: new Date().toISOString() };
    writeJson(reviewPath, data);

    // Archive timestamped copy for historical tracking
    const ts = Date.now();
    const archivePath = join(this.reportHistoryDir, `${ts}_${slug}-review.json`);
    writeJson(archivePath, data);
    this.pruneReportHistory();
  }

  // ---- Full state load ----

  loadState(): QualityPersistedState {
    const directories = this.loadConfig();
    const reports = this.loadAllReports(directories);
    const history = this.loadHistory();

    // Merge persisted code reviews into reports
    for (const dir of directories) {
      const review = this.loadCodeReview(dir.path);
      if (review && reports[dir.path]) {
        reports[dir.path] = { ...reports[dir.path], codeReview: review.findings as unknown as QualityResults['codeReview'] };
      }
    }

    return { directories, reports, history };
  }
}

function gradeFromScore(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}
