// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Headless Logger
 *
 * Provides AsyncLocalStorage-based logging redirection for headless execution.
 * When background operations (code review, PM compose/execute) run, their
 * console output is redirected to log files under ~/.mstro/logs/ instead of
 * polluting the terminal where the mstro CLI was started.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { WriteStream } from 'node:fs';
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface LogTarget {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const logContext = new AsyncLocalStorage<LogTarget>();

function formatArgs(args: unknown[]): string {
  return args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
}

/** Log a message. Writes to file when inside runWithFileLogger, otherwise to console. */
export function hlog(...args: unknown[]): void {
  const target = logContext.getStore();
  if (target) {
    target.log(...args);
  } else {
    console.log(...args);
  }
}

/** Log an error. Writes to file when inside runWithFileLogger, otherwise to console. */
export function herror(...args: unknown[]): void {
  const target = logContext.getStore();
  if (target) {
    target.error(...args);
  } else {
    console.error(...args);
  }
}

const LOG_DIR = join(homedir(), '.mstro', 'logs', 'headless');

/** Delete headless log files older than 7 days. Runs best-effort on startup. */
function rotateHeadlessLogs(): void {
  try {
    const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const file of readdirSync(LOG_DIR)) {
      if (!file.endsWith('.log')) continue;
      const filePath = join(LOG_DIR, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > MAX_AGE_MS || stat.size === 0) {
          unlinkSync(filePath);
        }
      } catch { /* ignore per-file errors */ }
    }
  } catch { /* ignore if dir doesn't exist yet */ }
}

/**
 * Run an async function with all hlog/herror output redirected to a log file.
 * The log file is created at ~/.mstro/logs/headless/{label}-{timestamp}.log,
 * or in logDir if provided (e.g. board-scoped logs/).
 */
export async function runWithFileLogger<T>(label: string, fn: () => Promise<T>, logDir?: string): Promise<T> {
  const dir = logDir ?? LOG_DIR;
  mkdirSync(dir, { recursive: true });
  rotateHeadlessLogs();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(dir, `${label}-${timestamp}.log`);
  const stream: WriteStream = createWriteStream(logPath, { flags: 'a' });

  const target: LogTarget = {
    log: (...args: unknown[]) => {
      stream.write(`[${new Date().toISOString()}] ${formatArgs(args)}\n`);
    },
    error: (...args: unknown[]) => {
      stream.write(`[${new Date().toISOString()}] ERROR: ${formatArgs(args)}\n`);
    },
  };

  return logContext.run(target, async () => {
    try {
      return await fn();
    } finally {
      await new Promise<void>((resolve) => stream.end(() => resolve()));
    }
  });
}
