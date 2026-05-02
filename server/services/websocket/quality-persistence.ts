// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

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
import { gradeFromScore } from './quality-grading.js';
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

export interface HistoryCategoryScore {
  category: string;
  score: number;
  grade: string;
}

export interface QualityHistoryEntry {
  timestamp: string;
  overall: number;
  grade: string;
  issueDensity?: number;
  categoryScores?: HistoryCategoryScore[];
  dimensionScores?: {
    security: { score: number; grade: string };
    reliability: { score: number; grade: string };
    maintainability: { score: number; grade: string };
  };
  directories: HistoryDirectoryEntry[];
}

interface QualityHistory {
  entries: QualityHistoryEntry[];
}

export type ActiveOperationType = 'scanning' | 'reviewing' | 'fixing';

export interface ActiveOperation {
  type: ActiveOperationType;
  path: string;
  startedAt: string;
}

export interface PendingResult {
  type: 'scanResults' | 'codeReview';
  path: string;
  data: Record<string, unknown>;
  completedAt: string;
}

export interface QualityPersistedState {
  directories: QualityDirectoryConfig[];
  reports: Record<string, QualityResults>;
  history: QualityHistoryEntry[];
  activeOperations: ActiveOperation[];
  pendingResults: PendingResult[];
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

    const now = new Date();
    const lastEntry = history[history.length - 1];
    const lastTime = lastEntry ? new Date(lastEntry.timestamp).getTime() : 0;
    const mergeWindow = 60_000;

    const dirEntry: HistoryDirectoryEntry = {
      path: dirPath,
      score: results.overall,
      grade: results.grade,
    };

    const categoryScores: HistoryCategoryScore[] | undefined = results.scoreBreakdown
      ? results.scoreBreakdown.categoryPenalties.map((cp) => ({
          category: cp.category,
          score: cp.score,
          grade: cp.grade,
        }))
      : undefined;

    const issueDensity = results.scoreBreakdown?.issueDensity;
    const dimensionScores = extractDimensionScores(results);

    if (lastEntry && now.getTime() - lastTime < mergeWindow) {
      const existing = lastEntry.directories.findIndex((d) => d.path === dirPath);
      if (existing >= 0) {
        lastEntry.directories[existing] = dirEntry;
      } else {
        lastEntry.directories.push(dirEntry);
      }
      const totalScore = lastEntry.directories.reduce((sum, d) => sum + d.score, 0);
      lastEntry.overall = Math.round(totalScore / lastEntry.directories.length);
      // Preserve N/A when every directory is N/A; otherwise map averaged score
      // back to a letter. `gradeFromScore` returns A-F only, so this is the
      // only place the N/A signal could be lost during multi-directory merges.
      const allNA = lastEntry.directories.every((d) => d.grade === 'N/A');
      lastEntry.grade = allNA ? 'N/A' : gradeFromScore(lastEntry.overall);
      lastEntry.timestamp = now.toISOString();
      if (categoryScores) lastEntry.categoryScores = categoryScores;
      if (issueDensity !== undefined) lastEntry.issueDensity = issueDensity;
      if (dimensionScores) lastEntry.dimensionScores = dimensionScores;
    } else {
      history.push({
        timestamp: now.toISOString(),
        overall: results.overall,
        grade: results.grade,
        issueDensity,
        categoryScores,
        dimensionScores,
        directories: [dirEntry],
      });
    }

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

  // ---- Active operations (survives WebSocket disconnects) ----

  private get activeOpsPath(): string {
    return join(this.qualityDir, 'active-ops.json');
  }

  private get pendingResultsPath(): string {
    return join(this.qualityDir, 'pending-results.json');
  }

  setActiveOperation(path: string, type: ActiveOperationType): void {
    const ops = this.loadActiveOperations();
    const existing = ops.findIndex((o) => o.path === path);
    const entry: ActiveOperation = { type, path, startedAt: new Date().toISOString() };
    if (existing >= 0) {
      ops[existing] = entry;
    } else {
      ops.push(entry);
    }
    writeJson(this.activeOpsPath, ops);
  }

  clearActiveOperation(path: string): void {
    const ops = this.loadActiveOperations().filter((o) => o.path !== path);
    writeJson(this.activeOpsPath, ops);
  }

  loadActiveOperations(): ActiveOperation[] {
    return readJson<ActiveOperation[]>(this.activeOpsPath, []);
  }

  // ---- Pending results (delivered on reconnect) ----

  addPendingResult(result: PendingResult): void {
    const pending = this.loadPendingResults();
    // Replace any existing pending result of the same type for the same path
    const filtered = pending.filter((p) => !(p.path === result.path && p.type === result.type));
    filtered.push(result);
    writeJson(this.pendingResultsPath, filtered);
  }

  loadPendingResults(): PendingResult[] {
    return readJson<PendingResult[]>(this.pendingResultsPath, []);
  }

  clearPendingResults(path?: string): void {
    if (!path) {
      writeJson(this.pendingResultsPath, []);
      return;
    }
    const filtered = this.loadPendingResults().filter((p) => p.path !== path);
    writeJson(this.pendingResultsPath, filtered);
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

    const activeOperations = this.loadActiveOperations();
    const pendingResults = this.loadPendingResults();

    return { directories, reports, history, activeOperations, pendingResults };
  }
}

// Snapshot per-dimension scores when the new rating fields are present.
// Older `QualityResults` objects (e.g., loaded from pre-redesign reports)
// omit `dimensions`, in which case we return undefined so old history rows
// continue to round-trip without synthesized data.
function extractDimensionScores(results: QualityResults): QualityHistoryEntry['dimensionScores'] | undefined {
  if (!results.dimensions) return undefined;
  const byName = new Map(results.dimensions.map((d) => [d.name, d]));
  const sec = byName.get('security');
  const rel = byName.get('reliability');
  const maint = byName.get('maintainability');
  if (!sec || !rel || !maint) return undefined;
  return {
    security: { score: sec.score, grade: sec.grade },
    reliability: { score: rel.score, grade: rel.grade },
    maintainability: { score: maint.score, grade: maint.grade },
  };
}
