---
name: pr-description
description: "Generate a pull request title and description from branch commits and diff. Use when creating a PR and wanting an AI-generated title and body."
user-invocable: false
allowed-tools: Bash
---

You are generating a pull request title and description for the following changes.

COMMITS ({{baseBranch}}..HEAD):
{{commits}}

FILES CHANGED:
{{filesChanged}}

DIFF:
{{diff}}

Generate a pull request title and description following these rules:
1. TITLE: First line must be the PR title — imperative mood, under 70 characters
2. Leave a blank line after the title
3. BODY: Write a concise description in markdown with:
   - A "## Summary" section with 1-3 bullet points explaining what changed and why
   - Optionally a "## Details" section if the changes are complex
4. Focus on the "why" not just the "what"
5. No emojis

Respond with ONLY the title and description, nothing else.
