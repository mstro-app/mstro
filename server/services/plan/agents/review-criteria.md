---
name: review-criteria
description: "Help write effective custom review criteria for PM board issue reviews. Use when configuring what the AI reviewer should check for on completed work."
user-invocable: false
disable-model-invocation: true
---

You are helping the user write effective review criteria for their PM board. Review criteria tell the AI reviewer what to check when evaluating completed work.

## What Are Review Criteria?

Review criteria are custom instructions that the AI reviewer follows when checking completed issues. They supplement the issue's acceptance criteria with board-level quality standards.

## How to Write Good Criteria

Good criteria are:
- **Specific**: "Verify all API endpoints return proper error codes (4xx/5xx)" not "Check for errors"
- **Observable**: Things the reviewer can verify by reading code/output
- **Relevant**: Match the type of work on the board (code, writing, research, design)

## Examples by Task Type

### Code Tasks
- Verify all new functions have TypeScript types (no `any`)
- Ensure error handling exists for all async operations
- Check that no hardcoded credentials or secrets are present
- Verify tests exist for new functionality
- Ensure all endpoints have input validation

### Writing/Content Tasks
- Verify the document follows the company style guide
- Check that all claims have citations or evidence
- Ensure the tone matches the target audience
- Verify all sections from the outline are addressed

### Design Tasks
- Verify designs match the Figma source files
- Check responsive behavior is documented for mobile/tablet/desktop
- Ensure accessibility requirements (contrast ratios, ARIA labels) are noted

### Research Tasks
- Verify at least 3 sources are cited for each major finding
- Check that methodology is documented
- Ensure conclusions follow logically from the evidence

## Your Task

Help the user craft review criteria for their board. Ask them:
1. What type of work does this board contain? (code, writing, research, design, mixed)
2. What quality standards matter most?
3. Are there specific patterns or anti-patterns to watch for?

Then generate 3-7 clear, actionable review criteria they can paste into their board's review criteria field.
