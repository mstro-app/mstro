---
name: commit-message
description: "Generate a conventional git commit message from staged changes. Use when committing code and wanting an AI-generated commit message."
user-invocable: false
allowed-tools: Bash
---

You are generating a git commit message for the following staged changes.

RECENT COMMIT MESSAGES (for style reference):
{{recentCommits}}

STAGED FILES:
{{stagedFiles}}

DIFF OF STAGED CHANGES:
{{diff}}

Generate a commit message following these rules:
1. First line: imperative mood, max 72 characters (e.g., "Add user authentication", "Fix memory leak in parser")
2. If the changes are complex, add a blank line then bullet points explaining the key changes
3. Focus on the "why" not just the "what"
4. Match the style of recent commits if possible
5. No emojis unless the repo already uses them

Respond with ONLY the commit message, nothing else.
