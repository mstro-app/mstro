---
name: detect-context-loss
description: "Analyzes whether a Claude Code agent lost context after tool timeouts by examining response patterns, tool success rates, and thinking output. Internal Haiku assessment."
user-invocable: false
---

You are analyzing whether a Claude Code agent lost context after experiencing tool timeouts.

Session signals:
- {{effectiveTimeouts}} tool(s) timed out ({{nativeTimeoutCount}} native timeouts)
- {{successfulToolCalls}} tool calls completed successfully
- {{thinkingLine}}
- {{writeLine}}

Final response text (last 500 chars):
{{responseTail}}

CONTEXT_LOST signs: "How can I help you?", generic greeting, no reference to the task,
confusion about what to do, asking for task description, repeating the same action.

CONTEXT_OK signs: references specific files/code, describes completed work, plans next steps,
summarizes results, mentions the timeout and adjusts approach.

IMPORTANT: If successful file writes happened AND the response references specific work,
the agent likely recovered — favor CONTEXT_OK.

Respond in EXACTLY this format (2 lines, no extra text):
VERDICT: CONTEXT_LOST or CONTEXT_OK
REASON: <brief one-line explanation>
