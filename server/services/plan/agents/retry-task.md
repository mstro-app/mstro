---
name: retry-task
description: "Recovery prompt for continuing a task after tool timeouts or process interruptions. Injects completed results and instructs continuation from last checkpoint. Internal recovery mechanism."
user-invocable: false
---

## AUTOMATIC RETRY — Previous Execution Interrupted

The previous execution was interrupted because {{hungToolName}} timed out after {{hungToolTimeoutSec}}s{{urlSuffix}}.

{{timedOutToolsSection}}

{{completedToolsSection}}

{{inProgressToolsSection}}

{{assistantTextSection}}

### Original task (continue from where you left off):
{{originalPrompt}}

INSTRUCTIONS:
1. Use the results above — do not re-fetch content you already have
2. Find ALTERNATIVE sources for the content that timed out (different URL, different approach)
3. Re-run any in-progress tools that were lost (listed above) if their results are needed
4. If no alternative exists, proceed with the results you have and note what was unavailable
