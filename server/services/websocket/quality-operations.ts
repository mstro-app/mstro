// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Quality Operation Registry — in-process tracking of in-flight scans and
 * code reviews so they can be cancelled (or detected as orphaned) without
 * depending on durable state.
 *
 * Persistence (`.mstro/quality/active-ops.json`) survives a CLI restart but
 * has no live `AbortController` to cancel; this registry holds the controllers
 * for the current process. The two layers are deliberately decoupled — when a
 * persisted op exists with no registry entry, callers know the op is orphaned.
 */

export type OperationKind = 'scanning' | 'reviewing';

interface RegisteredOperation {
  controller: AbortController;
  kind: OperationKind;
  startedAt: number;
}

export class OperationRegistry {
  private readonly ops = new Map<string, RegisteredOperation>();

  private key(workingDir: string, path: string): string {
    return `${workingDir}::${path}`;
  }

  /**
   * Reserve an operation slot and return its `AbortController`. Throws when
   * the same `(workingDir, path)` pair is already in flight — callers should
   * surface this to the user as "already running" rather than silently
   * starting a second worker.
   */
  start(workingDir: string, path: string, kind: OperationKind): AbortController {
    const k = this.key(workingDir, path);
    if (this.ops.has(k)) {
      throw new Error(`Operation already in flight: ${kind} ${path}`);
    }
    const controller = new AbortController();
    this.ops.set(k, { controller, kind, startedAt: Date.now() });
    return controller;
  }

  /**
   * Cancel an in-flight operation. Returns `true` when an op was found and
   * aborted, `false` when nothing was registered (the caller should still
   * clear persistence — the op is either already finished or was orphaned).
   */
  cancel(workingDir: string, path: string): boolean {
    const k = this.key(workingDir, path);
    const op = this.ops.get(k);
    if (!op) return false;
    op.controller.abort();
    return true;
  }

  finish(workingDir: string, path: string): void {
    this.ops.delete(this.key(workingDir, path));
  }

  has(workingDir: string, path: string): boolean {
    return this.ops.has(this.key(workingDir, path));
  }

  /** Kind of the live operation, or null when nothing is registered. */
  getKind(workingDir: string, path: string): OperationKind | null {
    return this.ops.get(this.key(workingDir, path))?.kind ?? null;
  }
}

export const operationRegistry = new OperationRegistry();
