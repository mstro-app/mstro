# Claude Code Headless API & Process Management: Comprehensive Research

**Date:** 2026-02-15
**Context:** Research for Mstro platform -- managing Claude Code subprocesses from the CLI relay component.

---

## Table of Contents

1. [SDK & API Overview](#1-sdk--api-overview)
2. [Headless Mode (CLI -p Flag)](#2-headless-mode-cli--p-flag)
3. [TypeScript Agent SDK (Programmatic)](#3-typescript-agent-sdk-programmatic)
4. [Streaming & Progress Detection](#4-streaming--progress-detection)
5. [Timeout Management](#5-timeout-management)
6. [AbortController & Process Termination](#6-abortcontroller--process-termination)
7. [Known Stall/Hang Issues & Patterns](#7-known-stallhang-issues--patterns)
8. [Best Practices for Remote/Automation Execution](#8-best-practices-for-remoteautomation-execution)
9. [Recommendations for Mstro](#9-recommendations-for-mstro)

---

## 1. SDK & API Overview

### Package Evolution

The SDK has gone through a naming transition:

- **Old:** `@anthropic-ai/claude-code` (npm) -- now deprecated for installation via npm
- **Current:** `@anthropic-ai/claude-agent-sdk` (npm, version 0.2.x as of Feb 2026)
- **Python:** `claude-code-sdk` (PyPI) / `claude_agent_sdk`

The "headless mode" terminology has been deprecated in favor of "Agent SDK." The `-p` flag and all CLI options work the same way, but the SDK packages provide richer programmatic control.

### Two Interface Generations

**V1 (Stable):** Async generator pattern via `query()` function.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Fix the bug",
  options: { maxTurns: 10, abortController: controller }
})) {
  // Handle messages
}
```

**V2 (Unstable Preview):** Session-based `send()`/`stream()` pattern.

```typescript
import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";

await using session = unstable_v2_createSession({ model: "claude-opus-4-6" });
await session.send("Fix the bug");
for await (const msg of session.stream()) {
  // Handle messages
}
```

The V2 interface is explicitly marked as unstable. V1 is the production-ready interface.

### Key Interfaces (V1)

The `query()` function returns a `Query` object that extends `AsyncGenerator<SDKMessage, void>` with:

- `interrupt()` -- Interrupts the query (streaming input mode only)
- `rewindFiles(userMessageUuid)` -- Restores files to a checkpoint
- `setPermissionMode(mode)` -- Changes permission mode at runtime
- `setModel(model)` -- Changes model at runtime

---

## 2. Headless Mode (CLI -p Flag)

### Basic Usage

```bash
claude -p "Find and fix the bug in auth.py" --allowedTools "Read,Edit,Bash"
```

### Output Formats

| Format | Flag | Description |
|--------|------|-------------|
| `text` | `--output-format text` | Plain text (default) |
| `json` | `--output-format json` | Structured JSON with `result`, `session_id`, metadata |
| `stream-json` | `--output-format stream-json` | Newline-delimited JSON (NDJSON), real-time streaming |

### Streaming with stream-json

To get real-time token-by-token output:

```bash
claude -p "Explain recursion" \
  --output-format stream-json \
  --verbose \
  --include-partial-messages
```

Each line is a JSON object. Filter for text deltas:

```bash
claude -p "Write a poem" --output-format stream-json --verbose --include-partial-messages | \
  jq -rj 'select(.type == "stream_event" and .event.delta.type? == "text_delta") | .event.delta.text'
```

### Session Continuity

```bash
# Capture session ID
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')
# Resume later
claude -p "Continue that review" --resume "$session_id"
```

### Known Limitation

Claude CLI in headless mode returns empty output when processing large stdin input (~7000+ characters). Smaller inputs (~2500 characters) work correctly. (GitHub issue #7263)

---

## 3. TypeScript Agent SDK (Programmatic)

### Core Options

```typescript
interface Options {
  abortController?: AbortController;       // For cancelling operations
  allowedTools?: string[];                  // Allowed tool names
  cwd?: string;                            // Working directory
  maxTurns?: number;                        // Maximum conversation turns
  maxBudgetUsd?: number;                    // Maximum budget in USD
  maxThinkingTokens?: number;              // Max tokens for thinking
  includePartialMessages?: boolean;         // Enable streaming events
  model?: string;                           // Claude model to use
  permissionMode?: PermissionMode;          // default | acceptEdits | bypassPermissions | plan
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  env?: Dict<string>;                      // Environment variables
  stderr?: (data: string) => void;         // Callback for stderr output
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  fallbackModel?: string;                  // Model to use if primary fails
  resume?: string;                         // Session ID to resume
  settingSources?: SettingSource[];        // Which settings files to load
  // ... many more options
}
```

### Message Types

The SDK yields these message types via the async generator:

| Type | Description |
|------|-------------|
| `SDKAssistantMessage` | Complete assistant response (after generation finishes) |
| `SDKUserMessage` | User input message |
| `SDKResultMessage` | Final result with duration, cost, usage, errors |
| `SDKSystemMessage` | System init message with tools, model, session info |
| `SDKPartialAssistantMessage` | Streaming partial (only with `includePartialMessages: true`) |
| `SDKCompactBoundaryMessage` | Conversation compaction boundary |

### Result Message Structure (Critical for Detecting Completion)

```typescript
type SDKResultMessage =
  | {
      type: "result";
      subtype: "success";
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      result: string;
      total_cost_usd: number;
      usage: NonNullableUsage;
    }
  | {
      type: "result";
      subtype: "error_max_turns"
              | "error_during_execution"
              | "error_max_budget_usd"
              | "error_max_structured_output_retries";
      errors: string[];
      // ... same metadata fields
    }
```

**Key insight:** The `subtype` field distinguishes success from various error terminations. For Mstro, this is the definitive signal that Claude Code has finished.

### Hook Events for Monitoring

The SDK supports hooks that fire at specific lifecycle points:

```typescript
type HookEvent =
  | "PreToolUse"       // Before a tool executes
  | "PostToolUse"      // After a tool executes
  | "PostToolUseFailure"  // After a tool fails
  | "Notification"     // Claude sends a notification
  | "SessionStart"     // Session begins
  | "SessionEnd"       // Session ends
  | "Stop"             // Agent stops
  | "SubagentStart"    // Subagent launched
  | "SubagentStop"     // Subagent stopped
  | "PreCompact"       // Before context compaction
  | "PermissionRequest"; // Permission needed
```

---

## 4. Streaming & Progress Detection

### How to Know Claude Code is Working

When `includePartialMessages: true` is set, the SDK emits `stream_event` messages containing raw Claude API streaming events. The event flow is:

```
StreamEvent (message_start)
StreamEvent (content_block_start) - text block
StreamEvent (content_block_delta) - text chunks...     <-- ACTIVE TEXT GENERATION
StreamEvent (content_block_stop)
StreamEvent (content_block_start) - tool_use block     <-- TOOL CALL STARTING
StreamEvent (content_block_delta) - tool input chunks...
StreamEvent (content_block_stop)
StreamEvent (message_delta)
StreamEvent (message_stop)
AssistantMessage - complete message                    <-- TURN COMPLETE
... tool executes (GAP WITH NO EVENTS) ...             <-- TOOL EXECUTING
... more streaming events for next turn ...
ResultMessage - final result                           <-- DONE
```

### Critical Gap: Tool Execution Silence

**The biggest challenge for stall detection:** Between when Claude decides to call a tool and when the tool result is returned, there are NO streaming events from the SDK. During a `Bash` command execution, for example, the process is alive and working but produces no output through the SDK's message stream.

### Detecting Tool Calls in Progress

Use `content_block_start` with `type === "tool_use"` to detect when a tool call begins:

```typescript
if (event.type === "content_block_start") {
  if (event.content_block.type === "tool_use") {
    currentTool = event.content_block.name;
    // Mark: tool execution phase started
  }
}
```

### The stderr Callback

The `stderr` option provides a callback for Claude Code's subprocess stderr output:

```typescript
options: {
  stderr: (data: string) => void;  // Callback for stderr output
}
```

This can potentially be used to detect process-level activity even when the SDK message stream is silent.

### Known Limitation: Extended Thinking Blocks Streaming

When `maxThinkingTokens` is explicitly set, `StreamEvent` messages are NOT emitted. Only complete messages are yielded after each turn. Since thinking is disabled by default in the SDK, streaming works unless you enable it.

---

## 5. Timeout Management

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `BASH_DEFAULT_TIMEOUT_MS` | `120000` (2 min) | Default bash command timeout |
| `BASH_MAX_TIMEOUT_MS` | Not documented | Maximum allowable timeout |

### Configuration Location

Configure in `~/.claude/settings.json`:

```json
{
  "env": {
    "BASH_DEFAULT_TIMEOUT_MS": "1800000",
    "BASH_MAX_TIMEOUT_MS": "7200000"
  }
}
```

**Important:** A full application restart is required for settings to take effect. Shell `export` alone does NOT work reliably.

### Per-Tool Timeout

The `Bash` tool input supports a per-command timeout:

```typescript
interface BashInput {
  command: string;
  timeout?: number;  // Optional timeout in ms (max 600000 = 10 min)
}
```

### SDK-Level Controls

| Control | Description |
|---------|-------------|
| `maxTurns` | Hard cap on conversation turns |
| `maxBudgetUsd` | Hard cap on spending |
| `abortController` | Programmatic cancellation |

**There is no built-in overall wall-clock timeout in the SDK.** You must implement this yourself.

### Known Issue: BASH_DEFAULT_TIMEOUT_MS Ignored

GitHub issue #3964 reports that bash commands ignore `BASH_DEFAULT_TIMEOUT_MS` and hang indefinitely. The timeout only works when explicitly specified in the Bash tool's `timeout` parameter. This is a significant reliability concern.

---

## 6. AbortController & Process Termination

### Correct Usage (Critical)

The AbortController MUST be passed inside the `options` object, NOT as a top-level parameter:

```typescript
// WRONG -- abort signal is ignored
query({
  prompt: "...",
  abortController: controller  // BUG: not respected here
})

// CORRECT -- abort signal is respected
query({
  prompt: "...",
  options: {
    abortController: controller  // Works here
  }
})
```

This was a known bug (issue #2970) that was resolved by documentation clarification, not by fixing the top-level parameter.

### AbortController Behavior

Even when correctly placed, there are limitations:

1. **Queued tool calls may still complete.** The abort signal does not immediately kill in-flight tool executions.
2. **Subagent cascade termination:** In v1.0.62+, all subagents share a single AbortController. One failure kills all subagents (issue #6594).
3. **Post-abort session resume can fail:** Using abortController immediately after init causes subsequent `resume` calls to fail with "No conversation found" (claude-agent-sdk-typescript issue #69).

### Process Cleanup Concerns

- Claude Code spawns child processes (Bash commands, subagents) that may not be properly cleaned up on abort.
- In Docker containers, background process termination can crash Claude Code because Claude Code and spawned processes share the same process group. Killing the process group kills Claude Code itself (issue #16135).
- On macOS with broken `pgrep`, Claude Code's child-process tracking loop can spawn thousands of zombie processes until hitting per-user process limits.

### Recommended Abort Pattern

```typescript
const controller = new AbortController();

// Set a wall-clock timeout
const timeout = setTimeout(() => {
  controller.abort();
}, MAX_EXECUTION_MS);

try {
  for await (const message of query({
    prompt: taskPrompt,
    options: {
      abortController: controller,
      maxTurns: 20,
      includePartialMessages: true,
    }
  })) {
    // Reset timeout on each message (activity detected)
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);

    handleMessage(message);
  }
} finally {
  clearTimeout(timeout);
}
```

---

## 7. Known Stall/Hang Issues & Patterns

### Issue Catalog

| Issue | Summary | Status |
|-------|---------|--------|
| #4744 | Agent execution timeout: persistent hanging during complex tasks (800-900s+) | Closed |
| #17711 | Interactive CLI degrades over time, leading to UI lag and repeated timeout errors | Open |
| #15945 | MCP server causes 16+ hour hang with no timeout or stuck detection | Open |
| #6857 | Bash command execution hangs and exceeds timeout limits | Open |
| #3964 | Bash commands ignore BASH_DEFAULT_TIMEOUT_MS and hang indefinitely | Open |
| #1554 | Hanging/freezing mid-work, hung indefinitely | Closed |
| #619 | CLI hangs or becomes unresponsive in WSL | Open |
| #2970 | AbortController not respected (fixed via docs clarification) | Closed |
| #6594 | Subagent termination bug: one failure kills all subagents | Open |
| #18532 | Complete freeze, 100% CPU, main thread stuck in infinite loop | Open |
| #15012 | Claude update detects its own spawned process as "another instance running" | Open |
| #7263 | Empty output with large stdin input in headless mode | Open |

### Common Stall Patterns

1. **MCP Server Hangs:** MCP servers that become unresponsive (e.g., waiting for sudo password) block Claude Code indefinitely with no timeout.
2. **Subagent Recursive Spawning:** `Task()` tool can create infinite loops of subagents calling subagents.
3. **Context Accumulation:** After many turns, context grows until the system becomes sluggish and eventually stalls.
4. **Bash Command Hangs:** Long-running or interactive bash commands that ignore configured timeouts.
5. **API Timeout Loops:** API request timeouts trigger retry loops that themselves get stuck.
6. **Process Group Issues:** Killing a process group in Docker kills Claude Code itself.

### What Happens When Claude Code Stalls

Based on the issues:
- **No error output.** Silent failures are common.
- **CPU may spike to 100%** or the process may sit idle at 0%.
- **No heartbeat mechanism.** There is no built-in liveness signal.
- **Process stays alive.** The Node.js process remains running; it just stops producing output.
- **Zombie children accumulate.** Child processes from bash commands pile up.

---

## 8. Best Practices for Remote/Automation Execution

### From Official Documentation (GitHub Actions)

1. **Set `--max-turns`** to cap conversation iterations (default: 10 in GitHub Actions).
2. **Set workflow-level timeouts** (`timeout-minutes` in GitHub Actions).
3. **Use `--allowedTools`** to restrict tool access.
4. **Use `permissionMode: "acceptEdits"` or `"bypassPermissions"`** for unattended execution.
5. **Monitor costs** via `maxBudgetUsd`.

### From Community Experience

1. **Implement your own wall-clock timeout.** The SDK has no built-in overall timeout. Use `AbortController` with `setTimeout`.
2. **Implement idle detection.** Track time since last `stream_event` and abort if it exceeds a threshold.
3. **Use `includePartialMessages: true`** to get real-time activity signals.
4. **Cap process trees.** Wrap Claude Code in a process limiter (e.g., `CLAUDE_CODE_MAXPROC=1000`).
5. **Clean up on exit.** Always kill child processes in a `finally` block. Consider `pkill -P <pid>` or process group cleanup.
6. **Avoid MCP servers in automation** unless you control their timeout behavior.
7. **Use `maxTurns`** as a safety net against infinite loops.

### From Trigger.dev Integration

```typescript
// AbortController integration with external cancellation
signal.addEventListener("abort", () => abortController.abort());

// Always use try/finally for cleanup
try {
  for await (const message of query({ prompt, options })) {
    // Process messages
  }
} finally {
  // Clean up temp directories, kill child processes
}
```

### Process Management in Remote Contexts

- Claude Code manages its own subprocess tree (bash shells, background processes).
- When running inside Docker/containers, be aware of process group issues (issue #16135).
- On Windows/WSL, use `CREATE_NEW_PROCESS_GROUP` for process tree management.
- Set `encoding="utf-8"` on Windows to avoid crashes on non-ASCII output.

---

## 9. Recommendations for Mstro

Based on this research, here are specific recommendations for the Mstro CLI component that manages Claude Code processes:

### A. Use the TypeScript SDK, Not CLI Subprocess

Use `@anthropic-ai/claude-agent-sdk` with the V1 `query()` function rather than spawning `claude -p` as a child process. This provides:
- Typed message stream
- Proper AbortController integration
- Hook callbacks for lifecycle events
- No stdout/stderr parsing needed

### B. Implement a Three-Layer Timeout System

```
1. IDLE TIMEOUT (per-message): Reset on every SDKMessage received.
   If no message received for N seconds, assume stall.
   Recommended: 120-300 seconds for complex tasks.

2. TURN TIMEOUT (per-turn): Track time between AssistantMessage events.
   Long tool executions (Bash, Task) can take minutes.
   Recommended: 600 seconds per turn.

3. WALL-CLOCK TIMEOUT (per-session): Total execution time cap.
   Use AbortController with setTimeout.
   Recommended: 1800 seconds (30 min) default, configurable per task.
```

### C. Activity Detection via Streaming

Enable `includePartialMessages: true` and track:

```typescript
let lastActivityTimestamp = Date.now();
let currentPhase: 'idle' | 'generating' | 'tool_executing' | 'done' = 'idle';

for await (const message of queryGenerator) {
  lastActivityTimestamp = Date.now();

  if (message.type === 'stream_event') {
    const event = message.event;
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      currentPhase = 'tool_executing';
      // Relay tool name to web clients for status display
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      currentPhase = 'generating';
      // Relay text delta to web clients
    }
  } else if (message.type === 'assistant') {
    currentPhase = 'tool_executing'; // About to execute tool calls
  } else if (message.type === 'result') {
    currentPhase = 'done';
  }
}
```

### D. Watchdog Timer

Run a separate interval that checks `lastActivityTimestamp`:

```typescript
const STALL_THRESHOLD_MS = 180_000; // 3 minutes with no messages

const watchdog = setInterval(() => {
  const silentMs = Date.now() - lastActivityTimestamp;
  if (silentMs > STALL_THRESHOLD_MS && currentPhase !== 'done') {
    console.error(`Claude Code stall detected: ${silentMs}ms silent in phase ${currentPhase}`);
    // Option 1: Abort and restart
    abortController.abort();
    // Option 2: Send notification to web clients
    broadcastStallWarning(silentMs);
  }
}, 30_000);
```

### E. Process Cleanup

```typescript
// Ensure child process tree is cleaned up
process.on('exit', () => {
  try {
    // Kill the entire process group if possible
    process.kill(-childProcess.pid, 'SIGKILL');
  } catch (e) {
    // Process may already be dead
  }
});
```

### F. AbortController Placement

Always pass `abortController` inside `options`:

```typescript
// CORRECT
query({
  prompt: taskPrompt,
  options: {
    abortController: controller,  // MUST be here
    maxTurns: 20,
    includePartialMessages: true,
  }
})
```

### G. Relay Activity to Web Clients

Map SDK messages to WebSocket events for the web frontend:

| SDK Event | Web Client Message |
|-----------|-------------------|
| `stream_event` (text_delta) | `{ type: "text_delta", text: "..." }` |
| `stream_event` (content_block_start, tool_use) | `{ type: "tool_start", name: "Bash" }` |
| `stream_event` (content_block_stop) | `{ type: "tool_end" }` |
| `assistant` (complete) | `{ type: "assistant_turn_complete" }` |
| `result` (success) | `{ type: "task_complete", result: "..." }` |
| `result` (error_*) | `{ type: "task_error", errors: [...] }` |
| Watchdog stall detection | `{ type: "stall_warning", silentMs: N }` |

### H. Configuration Recommendations

```typescript
const DEFAULT_OPTIONS = {
  maxTurns: 50,              // Safety cap
  maxBudgetUsd: 5.0,         // Cost cap
  includePartialMessages: true,  // Enable streaming
  permissionMode: "acceptEdits", // Auto-approve file edits
  allowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "WebSearch", "WebFetch"],
  settingSources: ["project"],   // Load CLAUDE.md
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: "You are running inside Mstro. Report progress clearly."
  }
};
```

---

## Key Takeaways

1. **There is no built-in heartbeat or liveness mechanism in Claude Code.** You must implement your own watchdog.

2. **The streaming event gap during tool execution is the primary challenge** for stall detection. When a Bash command runs for 5 minutes, the SDK goes silent.

3. **AbortController works but has caveats:** must be in `options`, may not immediately kill in-flight tools, and can cause cascade failures with subagents.

4. **The bash timeout system is unreliable.** `BASH_DEFAULT_TIMEOUT_MS` is reportedly ignored in many cases. Per-command timeouts via the tool's `timeout` parameter are more reliable but are controlled by the model, not the caller.

5. **Process cleanup is your responsibility.** Claude Code can leave zombie processes, especially in Docker/container environments.

6. **The V2 SDK interface (send/stream) may be better for Mstro's session model** but is unstable. V1 query() is production-ready.

7. **Max turns + wall-clock timeout + idle timeout is the defensive triad** for preventing runaway sessions.
