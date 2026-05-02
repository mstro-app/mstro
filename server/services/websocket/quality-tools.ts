// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { ADDITIONAL_EXCLUDES, ECOSYSTEM_TOOLS, type Ecosystem, type QualityTool, SOURCE_EXTENSIONS } from './quality-types.js';

/** Directories to skip when falling back to manual traversal (non-git repos). */
const FALLBACK_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  'target', 'vendor', '.venv', 'venv', '.tox', 'coverage',
  '.mstro', '.cache', '.turbo', '.output',
]);

// ============================================================================
// Ecosystem Detection
// ============================================================================

export function detectEcosystem(dirPath: string): Ecosystem[] {
  const ecosystems: Ecosystem[] = [];
  try {
    const files = readdirSync(dirPath);
    if (files.includes('package.json')) ecosystems.push('node');
    if (files.includes('pyproject.toml') || files.includes('setup.py') || files.includes('requirements.txt')) ecosystems.push('python');
    if (files.includes('Cargo.toml')) ecosystems.push('rust');
    if (files.includes('go.mod')) ecosystems.push('go');
    if (files.includes('Package.swift') || files.some(f => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'))) ecosystems.push('swift');
    if (files.includes('build.gradle') || files.includes('build.gradle.kts')) ecosystems.push('kotlin');
  } catch {
    // Directory not readable
  }
  if (ecosystems.length === 0) ecosystems.push('unknown');
  return ecosystems;
}

/** Detect the Node.js package manager from lockfiles */
function detectNodePackageManager(dirPath: string): 'npm' | 'yarn' | 'pnpm' | 'bun' {
  try {
    const files = readdirSync(dirPath);
    if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun';
    if (files.includes('pnpm-lock.yaml')) return 'pnpm';
    if (files.includes('yarn.lock')) return 'yarn';
  } catch {
    // Directory not readable
  }
  return 'npm';
}

/** Build the install command for a Node.js dev dependency */
function nodeInstallCmd(pm: 'npm' | 'yarn' | 'pnpm' | 'bun', pkg: string): string {
  switch (pm) {
    case 'yarn': return `yarn add -D ${pkg}`;
    case 'pnpm': return `pnpm add -D ${pkg}`;
    case 'bun': return `bun add -d ${pkg}`;
    default: return `npm install -D ${pkg}`;
  }
}

// ============================================================================
// Tool Detection & Installation
// ============================================================================

async function checkToolInstalled(check: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(check[0], check.slice(1), {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

export async function detectTools(dirPath: string): Promise<{ tools: QualityTool[]; ecosystem: string[] }> {
  const ecosystems = detectEcosystem(dirPath);
  const tools: QualityTool[] = [];
  const nodePm = ecosystems.includes('node') ? detectNodePackageManager(dirPath) : 'npm';

  for (const eco of ecosystems) {
    const specs = ECOSYSTEM_TOOLS[eco] || [];
    for (const spec of specs) {
      const installed = await checkToolInstalled(spec.check, dirPath);
      const installCommand = eco === 'node'
        ? nodeInstallCmd(nodePm, spec.installCmd.replace(/^npm install -D /, ''))
        : spec.installCmd;
      tools.push({
        name: spec.name,
        installed,
        installCommand,
        category: spec.category,
      });
    }
  }

  return { tools, ecosystem: ecosystems };
}

async function tryInstallCommands(tool: QualityTool, dirPath: string): Promise<string | null> {
  if (tool.installCommand.startsWith('(')) return null;
  const commands = tool.installCommand.split(' || ');
  let lastStderr = '';
  for (const cmd of commands) {
    const parts = cmd.trim().split(' ');
    // Force NODE_ENV=development for install: npm/yarn/pnpm silently skip
    // devDependencies under NODE_ENV=production, making `-D` installs no-op
    // (exit 0, nothing installed) so the post-install detection re-fails.
    const result = await runCommand(parts[0], parts.slice(1), dirPath, { NODE_ENV: 'development' });
    if (result.exitCode === 0) return null;
    lastStderr = result.stderr;
  }
  const detail = lastStderr ? ` (${lastStderr.trim().split('\n').pop()})` : '';
  return `${tool.name}: install failed${detail}`;
}

export async function installTools(
  dirPath: string,
  toolNames?: string[],
): Promise<{ tools: QualityTool[]; ecosystem: string[] }> {
  const { tools } = await detectTools(dirPath);
  const toInstall = tools.filter((t) => !t.installed && (!toolNames || toolNames.includes(t.name)));

  const failures: string[] = [];
  for (const tool of toInstall) {
    const failure = await tryInstallCommands(tool, dirPath);
    if (failure) failures.push(failure);
  }

  const detected = await detectTools(dirPath);
  const requestedNames = new Set(toolNames ?? toInstall.map((t) => t.name));
  const stillMissing = detected.tools.filter((t) => !t.installed && requestedNames.has(t.name)).map((t) => t.name);

  if (stillMissing.length > 0) {
    const detail = failures.length > 0 ? ` ${failures.join('; ')}` : '';
    throw new Error(`Failed to install: ${stillMissing.join(', ')}.${detail}`);
  }

  return detected;
}

// ============================================================================
// File Scanning
// ============================================================================

export interface SourceFile {
  path: string;
  relativePath: string;
  lines: number;
  content: string;
}

function tryStatSync(path: string): ReturnType<typeof statSync> | null {
  try { return statSync(path); } catch { return null; }
}

function tryReadFile(path: string): string | null {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

function tryReaddirSync(dir: string): string[] | null {
  try { return readdirSync(dir); } catch { return null; }
}

function tryReadSourceFile(fullPath: string, rootPath: string): SourceFile | null {
  const content = tryReadFile(fullPath);
  if (!content) return null;
  return {
    path: fullPath,
    relativePath: relative(rootPath, fullPath),
    lines: content.split('\n').length,
    content,
  };
}

function processEntry(entry: string, dir: string, rootPath: string, stack: string[], files: SourceFile[]): void {
  if (FALLBACK_IGNORE_DIRS.has(entry)) return;
  const fullPath = join(dir, entry);
  const stat = tryStatSync(fullPath);
  if (!stat) return;

  if (stat.isDirectory()) { stack.push(fullPath); return; }
  if (!stat.isFile() || !SOURCE_EXTENSIONS.has(extname(entry).toLowerCase())) return;

  const sourceFile = tryReadSourceFile(fullPath, rootPath);
  if (sourceFile) files.push(sourceFile);
}

/** Fallback: manual DFS traversal for non-git directories. */
function collectSourceFilesFallback(dirPath: string, rootPath: string): SourceFile[] {
  const files: SourceFile[] = [];
  const stack = [dirPath];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = tryReaddirSync(dir);
    if (!entries) continue;

    for (const entry of entries) {
      processEntry(entry, dir, rootPath, stack, files);
    }
  }

  return files;
}

/**
 * Collect source files for quality analysis.
 *
 * Primary: uses `git ls-files` to respect all .gitignore layers automatically.
 * Fallback: manual directory traversal with hardcoded ignore list (non-git repos).
 */
export async function collectSourceFiles(dirPath: string, rootPath: string): Promise<SourceFile[]> {
  // Check if inside a git repo
  const gitCheck = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], dirPath);
  if (gitCheck.exitCode !== 0) {
    return collectSourceFilesFallback(dirPath, rootPath);
  }

  // Use git ls-files: tracked + untracked-but-not-ignored
  const result = await runCommand('git', ['ls-files', '--cached', '--others', '--exclude-standard'], dirPath);
  if (result.exitCode !== 0) {
    return collectSourceFilesFallback(dirPath, rootPath);
  }

  const files: SourceFile[] = [];
  const relativePaths = result.stdout.split('\n').filter(Boolean);

  for (const relPath of relativePaths) {
    const ext = extname(relPath).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext)) continue;

    const fileName = relPath.split('/').pop() || '';
    if (ADDITIONAL_EXCLUDES.has(fileName)) continue;

    const fullPath = join(dirPath, relPath);
    const sourceFile = tryReadSourceFile(fullPath, rootPath);
    if (sourceFile) files.push(sourceFile);
  }

  return files;
}

// ============================================================================
// File List Helpers
// ============================================================================

/**
 * Filter a SourceFile list by extension and return relative paths.
 * Used to pass an explicit, git-ignored-filtered file list to external tools
 * (prettier, biome, eslint, ...) so they don't walk ignored directories like
 * web/dist or nested build outputs in monorepos.
 */
export function filesByExt(files: SourceFile[], exts: string[]): string[] {
  const set = new Set(exts.map((e) => e.toLowerCase()));
  const out: string[] = [];
  for (const f of files) {
    if (set.has(extname(f.path).toLowerCase())) out.push(f.relativePath);
  }
  return out;
}

/**
 * Split a file list into chunks so a single command invocation doesn't
 * blow past ARG_MAX. macOS ARG_MAX is ~256KB; 400 paths at ~200 chars each
 * leaves plenty of headroom.
 */
export function chunkFileList(paths: string[], size = 400): string[][] {
  if (paths.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < paths.length; i += size) {
    chunks.push(paths.slice(i, i + size));
  }
  return chunks;
}

// ============================================================================
// Command Runner
// ============================================================================

export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  envOverrides?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
      env: envOverrides ? { ...process.env, ...envOverrides } : undefined,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    proc.on('error', (err) => resolve({ stdout: '', stderr: err.message, exitCode: 1 }));
  });
}
