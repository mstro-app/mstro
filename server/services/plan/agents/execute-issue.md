---
name: execute-issue
description: "Execute a single PM board issue independently — read spec, fulfill acceptance criteria, write output, update status. Use when running a single issue from a PM board."
user-invocable: false
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

You are executing issue {{issue_id}}: {{issue_title}}.

## Project Directory
Working directory: {{workingDir}}
Plan directory: {{pmDir}}

## Issue Specification

**ID**: {{issue_id}}
**Title**: {{issue_title}}
**Type**: {{issue_type}} | **Priority**: {{issue_priority}} | **Estimate**: {{issue_estimate}}

### Description
{{issue_description}}

### Acceptance Criteria
{{acceptance_criteria}}

### Technical Notes
{{technical_notes}}
{{files_section}}{{predecessor_section}}

## Your Task

1. Read the full issue spec at {{issue_spec_path}}

### If "Files to Modify" is listed above:

2. **Implement the code changes** in the source files listed under "Files to Modify". You MUST edit or create the actual source code files — the acceptance criteria describe what the code must do, not what to document. Read each target file first, then make the changes using Edit or Write.
3. After implementation, write a brief summary of what you changed to **{{outputPath}}**
4. After writing output, update the issue front matter: change `status: in_progress` to `status: in_review`

### If no "Files to Modify":

2. Execute all acceptance criteria listed above
3. Write your output and results to **{{outputPath}}** — this is the handoff artifact for downstream issues
4. After writing output, update the issue front matter: change `status: in_progress` to `status: in_review`

## Rules

- Stay within this issue's scope. Do not modify files outside your assigned scope.
- The orchestrator manages STATE.md separately — do not edit STATE.md.
- If "Files to Modify" is present: the output file is a summary of work done, NOT a substitute for implementation. You must modify the actual source code files. A review gate will verify the source files were changed.
- If you cannot complete the issue, leave status as `in_progress` and document what blocked you in the output file.
