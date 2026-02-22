// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Security Audit Logging System
 *
 * Logs all bouncer_review decisions for security auditing and compliance
 */

import { appendFileSync, existsSync, mkdirSync, } from 'node:fs';
import { join } from 'node:path';

// Default log subdirectory inside .mstro/
const DEFAULT_LOG_SUBDIR = '.mstro/logs';

export type BouncerLayer = 'pattern-critical' | 'pattern-safe' | 'pattern-default' | 'haiku-ai' | 'ai-disabled' | 'ai-error';

export interface AuditLogEntry {
  timestamp: string;
  sessionId?: string;
  operation: string;
  context?: any;
  decision: 'allow' | 'deny' | 'warn_allow';
  confidence: number;
  reasoning: string;
  threatLevel?: string;
  layer?: BouncerLayer;
  latencyMs?: number;
  agentId?: string;
  workflowId?: string;
}

export class SecurityAuditLogger {
  private logFile: string;

  constructor(workingDir?: string) {
    const logDir = join(workingDir || process.cwd(), DEFAULT_LOG_SUBDIR);
    this.logFile = join(logDir, 'bouncer-audit.jsonl');

    // Ensure log directory exists
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  }

  /**
   * Log a bouncer review decision
   */
  log(entry: AuditLogEntry): void {
    const logLine = `${JSON.stringify({
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString()
    })}\n`;

    try {
      appendFileSync(this.logFile, logLine, 'utf-8');
    } catch (error) {
      console.error('[SecurityAudit] Failed to write log:', error);
    }
  }

  /**
   * Log with automatic timestamp
   */
  logDecision(
    operation: string,
    decision: 'allow' | 'deny' | 'warn_allow',
    confidence: number,
    reasoning: string,
    metadata?: {
      context?: any;
      threatLevel?: string;
      layer?: BouncerLayer;
      latencyMs?: number;
      sessionId?: string;
      agentId?: string;
      workflowId?: string;
    }
  ): void {
    this.log({
      timestamp: new Date().toISOString(),
      operation,
      decision,
      confidence,
      reasoning,
      ...metadata
    });
  }

}

// Singleton instance (keyed by workingDir to support multiple projects)
let auditLogger: SecurityAuditLogger | null = null;
let auditLoggerWorkingDir: string | undefined;

export function getAuditLogger(workingDir?: string): SecurityAuditLogger {
  if (!auditLogger || (workingDir && workingDir !== auditLoggerWorkingDir)) {
    auditLogger = new SecurityAuditLogger(workingDir);
    auditLoggerWorkingDir = workingDir;
  }
  return auditLogger;
}

/**
 * Helper to log bouncer decisions
 */
export function logBouncerDecision(
  operation: string,
  decision: 'allow' | 'deny' | 'warn_allow' | undefined,
  confidence: number,
  reasoning: string,
  metadata?: any
): void {
  // Defensive: handle undefined or invalid decision
  const safeDecision = decision ?? 'deny';
  const validDecisions = ['allow', 'deny', 'warn_allow'];
  const normalizedDecision = validDecisions.includes(safeDecision) ? safeDecision : 'deny';

  const workingDir = metadata?.context?.workingDirectory;
  const logger = getAuditLogger(workingDir);
  logger.logDecision(operation, normalizedDecision as 'allow' | 'deny' | 'warn_allow', confidence, reasoning, metadata);

  // Also log to console for real-time monitoring
  const emoji = normalizedDecision === 'allow' ? '✅' :
               normalizedDecision === 'warn_allow' ? '⚠️' : '🚫';
  const timestamp = new Date().toISOString();

  const layerInfo = metadata?.layer ? ` [${metadata.layer}]` : '';
  const latencyInfo = metadata?.latencyMs !== undefined ? ` (${metadata.latencyMs}ms)` : '';
  console.error(`[SecurityAudit] ${timestamp} ${emoji} ${normalizedDecision.toUpperCase()}${layerInfo}${latencyInfo}`);
  console.error(`[SecurityAudit]   Operation: ${operation}`);
  console.error(`[SecurityAudit]   Confidence: ${confidence}%`);
  console.error(`[SecurityAudit]   Reasoning: ${reasoning}`);

  if (metadata?.threatLevel === 'critical' || normalizedDecision === 'deny') {
    console.error(`[SecurityAudit] ⚠️  SECURITY ALERT: Dangerous operation ${normalizedDecision === 'deny' ? 'BLOCKED' : 'detected'}`);
  }
}

/**
 * Log an enforced security block (critical threats that cannot be bypassed)
 */
export function logEnforcedBlock(details: {
  command: string;
  reason: string;
  confidence: number;
  sessionId?: string;
  timestamp?: string;
  movementId?: string;
}): void {
  const logger = getAuditLogger();
  const logEntry = {
    type: 'ENFORCED_BLOCK',
    timestamp: details.timestamp || new Date().toISOString(),
    operation: details.command,
    decision: 'deny' as const,
    confidence: details.confidence,
    reasoning: details.reason,
    threatLevel: 'critical',
    sessionId: details.sessionId,
    movementId: details.movementId,
    severity: 'CRITICAL'
  };

  // Log to audit file
  logger.log(logEntry);

  // Also log to console with high visibility
  console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('🚨 SECURITY ENFORCEMENT - OPERATION BLOCKED');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(`Timestamp:  ${logEntry.timestamp}`);
  console.error(`Command:    ${details.command}`);
  console.error(`Reason:     ${details.reason}`);
  console.error(`Confidence: ${details.confidence}%`);
  console.error(`Threat:     CRITICAL`);
  if (details.sessionId) {
    console.error(`Session:    ${details.sessionId}`);
  }
  if (details.movementId) {
    console.error(`Movement:   ${details.movementId}`);
  }
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}
