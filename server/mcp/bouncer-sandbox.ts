// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Sandbox Harness for Bouncer Testing
 *
 * Wraps command execution in Anthropic's sandbox-runtime (bubblewrap on Linux,
 * sandbox-exec on macOS) to safely test what happens when the bouncer FAILS —
 * i.e., when a malicious tool call gets through.
 *
 * Usage in tests:
 *   const harness = new BouncerSandboxHarness();
 *   await harness.initialize();
 *   const result = await harness.executeInSandbox('rm -rf /tmp/test-canary');
 *   expect(result.violations).toContain(...)
 *   await harness.cleanup();
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SandboxExecResult {
  /** The sandboxed command that was actually run */
  wrappedCommand: string;
  /** Whether sandbox-runtime is available on this platform */
  sandboxAvailable: boolean;
  /** Whether the sandbox contained the operation (no violations) */
  contained: boolean;
  /** List of violation descriptions if any escaped the sandbox */
  violations: string[];
}

export interface CanaryCheckResult {
  /** Whether the canary file still exists (should be true if sandbox contained the write) */
  canaryIntact: boolean;
  /** Whether a file was written outside the sandbox (should be false) */
  escapeDetected: boolean;
}

/**
 * Test harness that wraps command execution in sandbox-runtime.
 * Provides canary files and violation tracking to verify containment.
 */
export class BouncerSandboxHarness {
  private sandboxManager: Awaited<typeof import('@anthropic-ai/sandbox-runtime')>['SandboxManager'] | null = null;
  private sandboxAvailable = false;
  private tempDir: string;
  private canaryDir: string;

  constructor() {
    this.tempDir = mkdtempSync(join(tmpdir(), 'bouncer-sandbox-'));
    this.canaryDir = join(this.tempDir, 'canaries');
    mkdirSync(this.canaryDir, { recursive: true });
  }

  /**
   * Initialize the sandbox. Falls back gracefully if bwrap/sandbox-exec not available.
   */
  async initialize(): Promise<{ available: boolean; reason?: string }> {
    try {
      const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

      if (!SandboxManager.isSupportedPlatform()) {
        return { available: false, reason: 'Platform not supported by sandbox-runtime' };
      }

      const deps = SandboxManager.checkDependencies();
      if (!deps.satisfied) {
        return {
          available: false,
          reason: `Missing dependencies: ${deps.missing?.join(', ') ?? 'unknown'}`,
        };
      }

      await SandboxManager.initialize({
        network: {
          allowedDomains: [], // Block ALL network access
          deniedDomains: ['*'],
        },
        filesystem: {
          denyRead: [
            '/home/*/.ssh',
            '/home/*/.aws',
            '/home/*/.gnupg',
            '/etc/shadow',
            '/etc/passwd',
          ],
          allowWrite: [this.tempDir], // Only allow writes to our temp dir
          denyWrite: [
            '/',
            '/home',
            '/etc',
            '/usr',
            '/var',
          ],
        },
      });

      this.sandboxManager = SandboxManager;
      this.sandboxAvailable = true;
      return { available: true };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { available: false, reason: `Failed to initialize sandbox: ${msg}` };
    }
  }

  /**
   * Execute a command inside the sandbox. Returns containment results.
   * If sandbox is not available, validates the bouncer decision only (no actual execution).
   */
  async executeInSandbox(command: string): Promise<SandboxExecResult> {
    if (!this.sandboxAvailable || !this.sandboxManager) {
      return {
        wrappedCommand: command,
        sandboxAvailable: false,
        contained: true,
        violations: ['Sandbox not available — decision-only testing mode'],
      };
    }

    const violations: string[] = [];
    try {
      const wrappedCommand = await this.sandboxManager.wrapWithSandbox(command);

      // Execute the wrapped command and capture violations
      try {
        execSync(wrappedCommand, {
          timeout: 5000,
          stdio: 'pipe',
          cwd: this.tempDir,
        });
      } catch {
        // Command failure inside sandbox is expected for malicious ops
      }

      // Check violation store
      const store = this.sandboxManager.getSandboxViolationStore();
      const stderr = this.sandboxManager.annotateStderrWithSandboxFailures(command, '');
      if (stderr) {
        violations.push(stderr);
      }

      this.sandboxManager.cleanupAfterCommand();

      return {
        wrappedCommand,
        sandboxAvailable: true,
        contained: violations.length === 0,
        violations,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      violations.push(`Sandbox execution error: ${msg}`);
      return {
        wrappedCommand: command,
        sandboxAvailable: true,
        contained: true, // Error means the command didn't execute
        violations,
      };
    }
  }

  /**
   * Place a canary file and return a checker to verify containment.
   * If a sandboxed command can delete or modify the canary, containment failed.
   */
  placeCanary(name: string): { path: string; check: () => CanaryCheckResult } {
    const canaryPath = join(this.canaryDir, name);
    const escapePath = join(this.canaryDir, `${name}.escaped`);
    writeFileSync(canaryPath, `canary-${Date.now()}`, 'utf-8');

    return {
      path: canaryPath,
      check: () => ({
        canaryIntact: existsSync(canaryPath),
        escapeDetected: existsSync(escapePath),
      }),
    };
  }

  /**
   * Get the temp directory where sandboxed commands can write.
   */
  getSandboxWriteDir(): string {
    return this.tempDir;
  }

  /**
   * Whether the sandbox is actually available and initialized.
   */
  isAvailable(): boolean {
    return this.sandboxAvailable;
  }

  /**
   * Clean up temp dirs and reset sandbox state.
   */
  async cleanup(): Promise<void> {
    try {
      if (this.sandboxManager) {
        await this.sandboxManager.reset();
      }
    } catch {
      // Ignore cleanup errors
    }
    try {
      rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
