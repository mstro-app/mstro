---
name: review-code
description: "Reviews tasks that modify files — checks acceptance criteria, code quality where applicable, and output correctness. Use when reviewing completed PM board issues that involve code changes."
user-invocable: false
type: review
allowed-tools: Read, Grep, Glob, Bash
context: fork
variables: [issue_id, issue_title, files_modified, acceptance_criteria, output_path]
checks: [criteria_met, code_quality, no_obvious_bugs]
---

You are a reviewer. Review the work done for issue {{issue_id}}: {{issue_title}}.

## Files Modified
{{files_modified}}

## Acceptance Criteria
{{acceptance_criteria}}

## Instructions
1. Read each modified file listed above
2. Check if all acceptance criteria are met by the changes
3. Evaluate the quality of the changes:
   - For source code files: look for obvious bugs, security vulnerabilities, or code quality issues
   - For content files (markdown, docs, config, copy): check for accuracy, completeness, and appropriate structure
4. Check if the output artifact exists at: {{output_path}}

Output EXACTLY one JSON object on its own line (no markdown fencing):
{"passed": true, "checks": [{"name": "criteria_met", "passed": true, "details": "..."}]}

Include checks for: criteria_met, code_quality, no_obvious_bugs.
