// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { ECOSYSTEM_TOOLS, type Ecosystem, IGNORE_DIRS, type QualityTool, SOURCE_EXTENSIONS } from './quality-types.js';

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

export async function installTools(
  dirPath: string,
  toolNames?: string[],
): Promise<{ tools: QualityTool[]; ecosystem: string[] }> {
  const { tools } = await detectTools(dirPath);
  const toInstall = tools.filter((t) => !t.installed && (!toolNames || toolNames.includes(t.name)));

  const failures: string[] = [];
  for (const tool of toInstall) {
    if (tool.installCommand.startsWith('(')) continue;
    const commands = tool.installCommand.split(' || ');
    let installed = false;
    for (const cmd of commands) {
      const parts = cmd.trim().split(' ');
      const result = await runCommand(parts[0], parts.slice(1), dirPath);
      if (result.exitCode === 0) { installed = true; break; }
    }
    if (!installed) {
      failures.push(`${tool.name}: all install methods failed`);
    }
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
  if (IGNORE_DIRS.has(entry)) return;
  const fullPath = join(dir, entry);
  const stat = tryStatSync(fullPath);
  if (!stat) return;

  if (stat.isDirectory()) { stack.push(fullPath); return; }
  if (!stat.isFile() || !SOURCE_EXTENSIONS.has(extname(entry).toLowerCase())) return;

  const sourceFile = tryReadSourceFile(fullPath, rootPath);
  if (sourceFile) files.push(sourceFile);
}

export function collectSourceFiles(dirPath: string, rootPath: string): SourceFile[] {
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

// ============================================================================
// Command Runner
// ============================================================================

export function runCommand(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    proc.on('error', (err) => resolve({ stdout: '', stderr: err.message, exitCode: 1 }));
  });
}
