// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Quality Review Agent — AI-powered code review using Claude Code headless runner.
 *
 * Builds the review prompt, runs the agent, parses findings, and persists results.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { runWithFileLogger } from '../../cli/headless/headless-logger.js';
import { HeadlessRunner } from '../../cli/headless/index.js';
import type { ToolUseEvent } from '../../cli/headless/types.js';
import type { HandlerContext } from './handler-context.js';
import type { QualityPersistence } from './quality-persistence.js';
import { recomputeWithAiReview } from './quality-service.js';
import type { WSContext } from './types.js';

// ── Types ─────────────────────────────────────────────────────

export interface CodeReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'security' | 'bugs' | 'performance' | 'maintainability';
  file: string;
  line: number | null;
  title: string;
  description: string;
  suggestion?: string;
  evidence?: string;
  verified?: boolean;
  verificationNote?: string;
}

// ── Prompt ────────────────────────────────────────────────────

export function buildCodeReviewPrompt(dirPath: string, cliFindings?: Array<{ severity: string; category: string; file: string; line: number | null; title: string; description: string }>): string {
  const cliFindingsSection = cliFindings && cliFindings.length > 0
    ? `\n## CLI Tool Findings (already detected)\n\nThe following issues were found by automated CLI tools (linters, formatters, complexity analyzers). Review these for context — they are already included in the final report. Focus your analysis on DEEPER issues these tools cannot detect.\n\n${cliFindings.slice(0, 50).map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.category} — ${f.file}${f.line ? `:${f.line}` : ''} — ${f.title}: ${f.description}`).join('\n')}\n${cliFindings.length > 50 ? `\n...and ${cliFindings.length - 50} more issues from CLI tools.\n` : ''}`
    : '';

  return `You are a senior staff engineer performing a rigorous, honest code review. Your job is to surface the most impactful quality bottlenecks — the issues a principal engineer would flag in a code review. Be critical and objective. Do NOT inflate scores.

IMPORTANT: Your current working directory is "${dirPath}". Only review files within this directory.
${cliFindingsSection}
## Review Process

1. **Discover**: Use Glob to find source files (e.g. "**/*.{ts,tsx,js,py,rs,go,java,rb,php}"). Understand the project structure.
2. **Read**: Read the most important files — entry points, core modules, handlers, services. Prioritize files with recent git changes (\`git diff --name-only HEAD~5\` via Bash if available).
3. **Analyze**: Look for real, actionable issues across ALL of these categories:

   ### Architecture
   - What is the current architecture (monolith, microservices, layered, etc.)?
   - Are there architectural violations? (e.g., presentation layer directly accessing data layer, circular dependencies between modules)
   - Is there proper separation of concerns?
   - Are there god objects or god modules that do too much?

   ### SOLID / OOP Principles
   - **SRP**: Classes/modules with multiple unrelated responsibilities
   - **OCP**: Code that requires modification instead of extension for new features
   - **LSP**: Subtypes that don't properly substitute for their base types
   - **ISP**: Interfaces/contracts that force implementations to depend on methods they don't use
   - **DIP**: High-level modules directly depending on low-level modules instead of abstractions

   ### Security
   - Injection vulnerabilities (SQL, XSS, command), hardcoded secrets/credentials, auth bypasses, insecure crypto, path traversal, SSRF, unsafe deserialization

   ### Bugs & Logic
   - Null/undefined errors, race conditions, logic errors, unhandled edge cases, off-by-one errors, resource leaks, incorrect error handling, incorrect algorithms

   ### Performance
   - N+1 queries, unnecessary re-renders, missing memoization, blocking I/O in hot paths, unbounded data structures, missing pagination

## CRITICAL — Structured Evidence Requirement

For EACH finding, you MUST provide structured evidence that grounds the finding in actual code. This is required to prevent false positives.

For each finding, use this reasoning process:

1. **PREMISE**: State the observable fact from the code. Quote the exact code you see.
2. **CONTEXT**: What is the surrounding code doing? Are there guards, fixes, or patterns elsewhere that might handle this?
3. **COUNTER-CHECK**: Actively look for evidence that CONTRADICTS your finding. Check for:
   - Guards or validation earlier in the call chain
   - Error handling wrapping the code
   - Configuration that changes behavior (e.g., NODE_ENV checks)
   - Comments explaining intentional design choices
4. **CONCLUSION**: Only report the finding if you could not find contradicting evidence.

### Common False Positive Patterns to AVOID

- Claiming a function uses API X when it actually uses API Y (e.g., claiming Math.random() when code uses crypto.randomInt()) — ALWAYS quote the actual function call
- Claiming a header/value is leaked when code already deletes/filters it — READ the full function
- Claiming there's no guard when a condition check exists nearby — READ surrounding lines
- Claiming N fields/methods when the actual count differs — COUNT explicitly
- Claiming a resource leaks when cleanup exists in a different handler — SEARCH for the cleanup code

## Rules

- Only report findings you are >90% confident about after completing the counter-check step.
- Focus on architecture, SOLID violations, bugs, and security over style nits.
- Each finding MUST reference a specific file and line number. Do not report vague or file-level issues.
- Each finding MUST include an "evidence" field with the exact code snippet (1-5 lines) proving the issue exists.
- Limit to the 25 most important findings, ranked by severity.
- Do NOT modify any files. This is a read-only review.
- Be HONEST about the overall quality. A codebase with serious issues should score low.

## Scoring Guidelines

After your analysis, provide an honest overall quality score (0-100) and letter grade:
- **A (90-100)**: Excellent — clean architecture, minimal issues, well-tested, follows best practices
- **B (80-89)**: Good — solid code with minor issues, mostly well-structured
- **C (70-79)**: Adequate — functional but has notable quality issues that should be addressed
- **D (60-69)**: Below average — significant issues in architecture, testing, or code quality
- **F (0-59)**: Poor — serious problems: security vulnerabilities, broken architecture, major bugs, or unmaintainable code

Consider ALL findings (both CLI tool findings and your own) when determining the score. The score should reflect the overall state of the codebase honestly. A project with 50+ linting errors, formatting issues, complex functions, AND architectural problems should NOT score above 70.

## Output

After your analysis, output EXACTLY one JSON code block with your findings. No other text after the JSON block.

\`\`\`json
{
  "score": 72,
  "grade": "C",
  "scoreRationale": "Brief explanation of why this score was given, referencing key issues",
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "category": "architecture|oop|security|bugs|performance|logic",
      "file": "relative/path/to/file.ts",
      "line": 42,
      "title": "Short title describing the issue",
      "description": "What the problem is and why it matters.",
      "suggestion": "How to fix it.",
      "evidence": "const token = Math.random().toString(36) // exact code from file proving the issue"
    }
  ],
  "summary": "Brief 1-2 sentence summary of overall code quality."
}
\`\`\``;
}

// ── Response parsing ──────────────────────────────────────────

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const VALID_CATEGORIES = new Set(['architecture', 'oop', 'security', 'bugs', 'performance', 'logic', 'maintainability']);

function normalizeFinding(f: Record<string, unknown>): CodeReviewFinding | null {
  if (typeof f.file !== 'string' || typeof f.title !== 'string') return null;
  return {
    severity: VALID_SEVERITIES.has(f.severity as string) ? f.severity as CodeReviewFinding['severity'] : 'medium',
    category: VALID_CATEGORIES.has(f.category as string) ? f.category as CodeReviewFinding['category'] : 'maintainability',
    file: f.file as string,
    line: typeof f.line === 'number' ? f.line : null,
    title: f.title as string,
    description: typeof f.description === 'string' ? f.description : '',
    suggestion: typeof f.suggestion === 'string' ? f.suggestion : undefined,
    evidence: typeof f.evidence === 'string' ? f.evidence : undefined,
  };
}

function extractJson(response: string): string {
  const fencedJson = response.match(/```json\s*([\s\S]*?)```/);
  if (fencedJson) return fencedJson[1].trim();

  const fencedPlain = response.match(/```\s*([\s\S]*?)```/);
  if (fencedPlain) return fencedPlain[1].trim();

  const braceMatch = response.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0].trim();

  return response.trim();
}

export interface CodeReviewResult {
  findings: CodeReviewFinding[];
  summary: string;
  score: number | null;
  grade: string | null;
  scoreRationale: string | null;
}

export function parseCodeReviewResponse(response: string): CodeReviewResult {
  const jsonStr = extractJson(response);

  try {
    const parsed = JSON.parse(jsonStr);
    const rawFindings: Record<string, unknown>[] = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings = rawFindings.map(normalizeFinding).filter((f): f is CodeReviewFinding => f !== null);
    const summary = typeof parsed.summary === 'string' ? parsed.summary : `Found ${findings.length} issue(s).`;
    const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : null;
    const grade = typeof parsed.grade === 'string' ? parsed.grade : null;
    const scoreRationale = typeof parsed.scoreRationale === 'string' ? parsed.scoreRationale : null;
    return { findings, summary, score, grade, scoreRationale };
  } catch {
    return { findings: [], summary: 'Failed to parse code review results.', score: null, grade: null, scoreRationale: null };
  }
}

// ── Phase 3: Deterministic post-validation ───────────────────
//
// Fast grep/file-based checks that catch hallucinated references
// before the more expensive LLM verification pass.

interface ValidationResult {
  finding: CodeReviewFinding;
  valid: boolean;
  reason?: string;
}

function resolveFilePath(dirPath: string, filePath: string): string {
  if (isAbsolute(filePath)) return filePath;
  return join(dirPath, filePath);
}

/**
 * Extract keywords/identifiers that the finding's description claims exist in the code.
 * Looks for patterns like: "calls X()", "uses X", "X is called", "X at line N".
 */
function extractClaimedIdentifiers(description: string, title: string): string[] {
  const identifiers: string[] = [];
  const combined = `${title} ${description}`;

  // Match function calls: functionName(), ClassName.method()
  const callPatterns = combined.matchAll(/\b([a-zA-Z_$][\w.$]*)\s*\(/g);
  for (const m of callPatterns) {
    const name = m[1];
    // Skip common English words that look like function calls
    if (!['If', 'When', 'While', 'For', 'This', 'That', 'The', 'Each', 'Uses', 'Has', 'Does', 'Returns', 'Takes', 'Calls'].includes(name)) {
      identifiers.push(name);
    }
  }

  // Match backtick-quoted code: `someCode`
  const backtickPatterns = combined.matchAll(/`([^`]+)`/g);
  for (const m of backtickPatterns) {
    // Extract identifiers from the backtick content
    const inner = m[1].replace(/[()[\]{};,]/g, ' ').trim();
    if (inner && inner.length < 60) {
      identifiers.push(inner);
    }
  }

  return identifiers;
}

/**
 * Validate findings against the actual filesystem. Returns findings annotated
 * with validation results. Does NOT remove findings — only marks them.
 */
export function validateFindings(
  findings: CodeReviewFinding[],
  dirPath: string,
): { validated: CodeReviewFinding[]; rejected: CodeReviewFinding[]; stats: { total: number; passed: number; failed: number } } {
  const validated: CodeReviewFinding[] = [];
  const rejected: CodeReviewFinding[] = [];

  for (const finding of findings) {
    const result = validateSingleFinding(finding, dirPath);
    if (result.valid) {
      validated.push({ ...finding, verified: undefined }); // Don't mark yet — Phase 2 does that
    } else {
      rejected.push({ ...finding, verified: false, verificationNote: result.reason });
    }
  }

  return {
    validated,
    rejected,
    stats: { total: findings.length, passed: validated.length, failed: rejected.length },
  };
}

function readFileContent(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

const COMMON_KEYWORDS = /^(const|let|var|function|return|import|export|from|this|true|false|null|undefined|new|if|else|for|while|try|catch)$/;

function checkLineInRange(content: string, line: number | null): string | null {
  if (line === null || line <= 0) return null;
  const lineCount = content.split('\n').length;
  if (line > lineCount) return `Line ${line} exceeds file length (${lineCount} lines)`;
  return null;
}

function checkEvidenceTokens(content: string, evidence: string | undefined): string | null {
  if (!evidence) return null;
  const evidenceTokens = evidence
    .replace(/['"`;{}[\]()]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 3 && !COMMON_KEYWORDS.test(t));
  if (evidenceTokens.length === 0) return null;
  const matchCount = evidenceTokens.filter(token => content.includes(token)).length;
  if (matchCount === 0) return `Evidence tokens not found in file: ${evidenceTokens.slice(0, 3).join(', ')}`;
  return null;
}

function checkClaimedIdentifiers(content: string, finding: CodeReviewFinding): string | null {
  const claimedIds = extractClaimedIdentifiers(finding.description, finding.title);
  if (claimedIds.length < 2) return null;
  const foundAny = claimedIds.some(id => {
    if (id.includes('.')) return content.includes(id);
    return new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(content);
  });
  if (!foundAny) return `Claimed identifiers not found in file: ${claimedIds.slice(0, 3).join(', ')}`;
  return null;
}

function validateSingleFinding(finding: CodeReviewFinding, dirPath: string): ValidationResult {
  const filePath = resolveFilePath(dirPath, finding.file);

  if (!existsSync(filePath)) {
    return { finding, valid: false, reason: `File does not exist: ${finding.file}` };
  }

  const content = readFileContent(filePath);
  if (!content) return { finding, valid: true }; // Can't read — don't reject

  const lineErr = checkLineInRange(content, finding.line);
  if (lineErr) return { finding, valid: false, reason: lineErr };

  const evidenceErr = checkEvidenceTokens(content, finding.evidence);
  if (evidenceErr) return { finding, valid: false, reason: evidenceErr };

  const idErr = checkClaimedIdentifiers(content, finding);
  if (idErr) return { finding, valid: false, reason: idErr };

  return { finding, valid: true };
}

// ── Phase 2: LLM verification pass ──────────────────────────
//
// Runs a second headless Claude pass that independently verifies
// each finding against the actual code.

export function buildVerificationPrompt(
  dirPath: string,
  findings: CodeReviewFinding[],
): string {
  const findingsJson = findings.map((f, i) => ({
    id: i + 1,
    severity: f.severity,
    category: f.category,
    file: f.file,
    line: f.line,
    title: f.title,
    description: f.description,
    evidence: f.evidence || '(none provided)',
  }));

  return `You are an independent code review VERIFIER. A separate reviewer produced the findings below. Your job is to VERIFY each finding against the actual code. You are a skeptic — do NOT trust the original reviewer's claims.

IMPORTANT: Your current working directory is "${dirPath}". Only read files within this directory.

## Findings to Verify

${JSON.stringify(findingsJson, null, 2)}

## Verification Process

For EACH finding:

1. **Read the cited file and line** using the Read tool. Read at least 20 lines around the cited line for context.
2. **Check the specific claim** in the description. Does the code actually do what the finding claims?
3. **Search for counter-evidence**:
   - If the finding claims something is missing (no validation, no cleanup, no guard): search for it with Grep
   - If the finding claims an API is used: verify the actual API call at that line
   - If the finding claims a value is leaked/exposed: check if it's filtered/deleted elsewhere in the same function
4. **Verdict**: Mark as "confirmed" or "rejected" with a brief explanation

## Rules

- You MUST actually Read each cited file. Do not rely on memory or assumptions.
- Use Grep to search for patterns the finding claims exist (or don't exist).
- A finding is "rejected" if:
  - The code does NOT match what the description claims
  - There IS a guard/fix that the finding claims is missing
  - The line number doesn't contain the relevant code
  - The finding is about a different version of the code than what exists now
- A finding is "confirmed" if you can independently verify the issue exists in the current code.
- Be thorough but efficient — focus verification effort on high/critical severity findings.

## Output

Output EXACTLY one JSON code block. No other text after the JSON block.

\`\`\`json
{
  "verifications": [
    {
      "id": 1,
      "verdict": "confirmed|rejected",
      "confidence": 0.95,
      "note": "Brief explanation of what you found when checking the code"
    }
  ]
}
\`\`\``;
}

interface VerificationVerdict {
  id: number;
  verdict: 'confirmed' | 'rejected';
  confidence: number;
  note: string;
}

export function parseVerificationResponse(response: string): VerificationVerdict[] {
  const jsonStr = extractJson(response);
  try {
    const parsed = JSON.parse(jsonStr);
    const raw: Record<string, unknown>[] = Array.isArray(parsed.verifications) ? parsed.verifications : [];
    return raw
      .filter((v): v is Record<string, unknown> & { id: number } =>
        typeof v.id === 'number' && typeof v.verdict === 'string')
      .map(v => ({
        id: v.id as number,
        verdict: v.verdict === 'rejected' ? 'rejected' as const : 'confirmed' as const,
        confidence: typeof v.confidence === 'number' ? v.confidence : 0.5,
        note: typeof v.note === 'string' ? v.note : '',
      }));
  } catch {
    return [];
  }
}

/**
 * Apply verification verdicts to findings.
 * Confirmed findings get verified=true. Rejected findings are removed.
 */
export function applyVerification(
  findings: CodeReviewFinding[],
  verdicts: VerificationVerdict[],
): { verified: CodeReviewFinding[]; rejected: CodeReviewFinding[] } {
  const verdictMap = new Map(verdicts.map(v => [v.id, v]));
  const verified: CodeReviewFinding[] = [];
  const rejected: CodeReviewFinding[] = [];

  for (let i = 0; i < findings.length; i++) {
    const verdict = verdictMap.get(i + 1);
    if (!verdict) {
      // No verdict — keep finding but mark unverified
      verified.push({ ...findings[i], verified: undefined });
      continue;
    }

    if (verdict.verdict === 'confirmed' && verdict.confidence >= 0.6) {
      verified.push({
        ...findings[i],
        verified: true,
        verificationNote: verdict.note || undefined,
      });
    } else {
      rejected.push({
        ...findings[i],
        verified: false,
        verificationNote: verdict.note || undefined,
      });
    }
  }

  return { verified, rejected };
}

// ── Progress tracking ─────────────────────────────────────────

const TOOL_START_MESSAGES: Record<string, string> = {
  Glob: 'Discovering project files...',
  Read: 'Reading source files...',
  Grep: 'Searching codebase...',
  Bash: 'Running analysis command...',
};

function getToolCompleteMessage(event: ToolUseEvent): string | null {
  const input = event.completeInput;
  if (!input) return null;
  if (event.toolName === 'Read' && input.file_path) {
    return `Reviewed ${String(input.file_path).split('/').slice(-2).join('/')}`;
  }
  if (event.toolName === 'Grep' && input.pattern) {
    return `Searched for "${String(input.pattern).slice(0, 40)}"`;
  }
  return null;
}

function createCodeReviewProgressTracker() {
  const seenToolStarts = new Set<string>();

  return (event: ToolUseEvent): string | null => {
    if (event.type === 'tool_start' && event.toolName) {
      if (seenToolStarts.has(event.toolName)) return null;
      seenToolStarts.add(event.toolName);
      return TOOL_START_MESSAGES[event.toolName] ?? null;
    }
    if (event.type === 'tool_complete') return getToolCompleteMessage(event);
    return null;
  };
}

// ── Handler helpers ───────────────────────────────────────────

type ProgressSender = (message: string) => void;

function makeProgressSender(ctx: HandlerContext, ws: WSContext, reportPath: string): ProgressSender {
  return (message: string) => {
    ctx.send(ws, { type: 'qualityCodeReviewProgress', data: { path: reportPath, message } });
  };
}

function makeToolCallback(send: ProgressSender, prefix?: string): (event: ToolUseEvent) => void {
  const getProgressMessage = createCodeReviewProgressTracker();
  return (event: ToolUseEvent) => {
    const message = getProgressMessage(event);
    if (message) send(prefix ? `${prefix}${message}` : message);
  };
}

function loadCliFindings(
  getPersistence: (dir: string) => QualityPersistence,
  workingDir: string,
  reportPath: string,
): Array<{ severity: string; category: string; file: string; line: number | null; title: string; description: string }> | undefined {
  try {
    const persistence = getPersistence(workingDir);
    const existingReport = persistence.loadReport(reportPath);
    return existingReport?.findings;
  } catch {
    return undefined;
  }
}

async function runVerificationPass(
  dirPath: string,
  findings: CodeReviewFinding[],
  send: ProgressSender,
  sandboxed?: boolean,
): Promise<CodeReviewFinding[]> {
  send(`Verifying ${findings.length} findings against actual code...`);

  const verificationRunner = new HeadlessRunner({
    workingDir: dirPath,
    directPrompt: buildVerificationPrompt(dirPath, findings),
    stallWarningMs: 120_000,
    stallKillMs: 300_000,
    stallHardCapMs: 600_000,
    toolUseCallback: makeToolCallback(send, 'Verifying: '),
    sandboxed,
  });

  const verifyResult = await runWithFileLogger('code-review-verify', () => verificationRunner.run());
  const verdicts = parseVerificationResponse(verifyResult.assistantResponse || '');

  if (verdicts.length === 0) return findings; // No verdicts — keep all as-is

  const { verified, rejected } = applyVerification(findings, verdicts);
  if (rejected.length > 0) {
    send(`Verification rejected ${rejected.length} inaccurate finding(s)`);
  }
  return verified;
}

function persistReviewResults(
  reviewResult: CodeReviewResult,
  reportPath: string,
  getPersistence: (dir: string) => QualityPersistence,
  workingDir: string,
): import('./quality-service.js').QualityResults | null {
  const persistence = getPersistence(workingDir);
  const existingReport = persistence.loadReport(reportPath);
  // CodeReviewFinding is structurally compatible with QualityFinding (category is a narrower union)
  const findings = reviewResult.findings as import('./quality-types.js').QualityFinding[];
  const findingsRecord = reviewResult.findings as unknown[] as Record<string, unknown>[];
  if (!existingReport) {
    persistence.saveCodeReview(reportPath, findingsRecord, reviewResult.summary);
    return null;
  }

  let updatedResults: import('./quality-service.js').QualityResults;
  if (reviewResult.score !== null && reviewResult.grade !== null) {
    updatedResults = {
      ...existingReport,
      overall: reviewResult.score,
      grade: reviewResult.grade,
      codeReview: findings,
      scoreRationale: reviewResult.scoreRationale ?? undefined,
    };
  } else {
    updatedResults = recomputeWithAiReview(existingReport, reviewResult.findings);
    updatedResults = { ...updatedResults, codeReview: findings };
  }

  persistence.saveReport(reportPath, updatedResults);
  persistence.appendHistory(updatedResults, reportPath);
  persistence.saveCodeReview(reportPath, findingsRecord, reviewResult.summary);
  return updatedResults;
}

// ── Handler ───────────────────────────────────────────────────

export async function handleCodeReview(
  ctx: HandlerContext,
  ws: WSContext,
  reportPath: string,
  dirPath: string,
  workingDir: string,
  activeReviews: Set<string>,
  getPersistence: (dir: string) => QualityPersistence,
  sandboxed?: boolean,
): Promise<void> {
  if (activeReviews.has(dirPath)) {
    ctx.send(ws, { type: 'qualityError', data: { path: reportPath, error: 'A code review is already running for this directory.' } });
    return;
  }

  activeReviews.add(dirPath);
  const send = makeProgressSender(ctx, ws, reportPath);

  try {
    send('Starting AI code review...');
    const cliFindings = loadCliFindings(getPersistence, workingDir, reportPath);

    // ── Pass 1: Initial AI code review ──────────────────────
    const runner = new HeadlessRunner({
      workingDir: dirPath,
      directPrompt: buildCodeReviewPrompt(dirPath, cliFindings),
      stallWarningMs: 120_000,
      stallKillMs: 600_000,
      stallHardCapMs: 900_000,
      toolUseCallback: makeToolCallback(send),
      sandboxed,
    });

    send('Claude is analyzing your codebase...');
    const result = await runWithFileLogger('code-review', () => runner.run());
    const reviewResult = parseCodeReviewResponse(result.assistantResponse || '');

    // ── Phase 3: Deterministic post-validation ──────────────
    send(`Validating ${reviewResult.findings.length} findings against codebase...`);
    const validation = validateFindings(reviewResult.findings, dirPath);
    if (validation.stats.failed > 0) {
      send(`Filtered ${validation.stats.failed} finding(s) with invalid references`);
    }

    // ── Phase 2: LLM verification pass ──────────────────────
    let finalFindings = validation.validated;
    if (finalFindings.length > 0) {
      try {
        finalFindings = await runVerificationPass(dirPath, finalFindings, send, sandboxed);
      } catch {
        send('Verification pass skipped (timeout or error)');
      }
    }

    // ── Persist and send results ─────────────────────────────
    send('Generating review report...');
    const verifiedReviewResult: CodeReviewResult = { ...reviewResult, findings: finalFindings };

    let updatedResults: import('./quality-service.js').QualityResults | null = null;
    try {
      updatedResults = persistReviewResults(verifiedReviewResult, reportPath, getPersistence, workingDir);
    } catch {
      // Persistence failure should not break the review flow
    }

    ctx.send(ws, {
      type: 'qualityCodeReview',
      data: { path: reportPath, findings: verifiedReviewResult.findings, summary: verifiedReviewResult.summary, results: updatedResults },
    });
  } catch (error) {
    ctx.send(ws, { type: 'qualityError', data: { path: reportPath, error: error instanceof Error ? error.message : String(error) } });
  } finally {
    activeReviews.delete(dirPath);
  }
}
