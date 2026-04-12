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
2. Execute all acceptance criteria listed above
3. Write your output and results to **{{outputPath}}** — this is the handoff artifact for downstream issues
4. After writing output, update the issue front matter: change `status: in_progress` to `status: in_review`

## Rules

- Stay within this issue's scope. Do not modify files outside your assigned scope.
- The orchestrator manages STATE.md separately — do not edit STATE.md.
- Write all significant output to {{outDir}}/ so downstream issues can reference it.
- If you cannot complete the issue, leave status as `in_progress` and document what blocked you in the output file.
