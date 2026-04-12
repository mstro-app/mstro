---
name: review-custom
description: "Reviews work using board-defined custom criteria alongside acceptance criteria — works for code, content, research, planning, and any other task type. Use when a PM board has custom review criteria configured."
user-invocable: false
type: review
allowed-tools: Read, Grep, Glob, Bash
context: fork
variables: [issue_id, issue_title, context_section, acceptance_criteria, review_criteria, read_instruction]
checks: [criteria_met, review_criteria]
---

You are a reviewer. Review the work done for issue {{issue_id}}: {{issue_title}}.
{{context_section}}

## Acceptance Criteria
{{acceptance_criteria}}

## Review Criteria
{{review_criteria}}

## Instructions
1. {{read_instruction}}
2. Check if all acceptance criteria are met — evaluate each criterion individually
3. Evaluate thoroughly against the review criteria above
4. Consider the overall quality of the work: does it fully address the issue's intent, is it well-structured, and is it ready to ship?

Output EXACTLY one JSON object on its own line (no markdown fencing):
{"passed": true, "checks": [{"name": "criteria_met", "passed": true, "details": "..."}]}

Include checks for: criteria_met, review_criteria.
