// Copyright (c) 2025-present Mstro, Inc. All rights reserved.
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Notification Routes
 *
 * Handles notification-related operations including AI-powered summary generation.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'

export function createNotificationRoutes(workingDir: string) {
  const routes = new Hono()

  /**
   * Generate a summary for browser notification using Claude Haiku
   * POST /summarize
   * Body: { prompt: string, output: string }
   * Returns: { summary: string }
   */
  routes.post('/summarize', async (c) => {
    try {
      const body = await c.req.json()
      const { prompt, output } = body

      if (!prompt || !output) {
        return c.json({ error: 'Missing required fields: prompt and output' }, 400)
      }

      const summary = await generateNotificationSummary(prompt, output, workingDir)
      return c.json({ summary })
    } catch (error) {
      console.error('[Notifications] Error generating summary:', error)
      // Return a fallback summary on error
      return c.json({ summary: 'Task completed' })
    }
  })

  return routes
}

/**
 * Generate a notification summary using Claude Haiku
 */
async function generateNotificationSummary(
  userPrompt: string,
  output: string,
  workingDir: string
): Promise<string> {
  return new Promise((resolve) => {
    // Create temp directory if it doesn't exist
    const tempDir = join(workingDir, '.mstro', 'tmp')
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true })
    }

    // Truncate output if too long (keep first and last parts for context)
    let truncatedOutput = output
    if (output.length > 4000) {
      const firstPart = output.slice(0, 2000)
      const lastPart = output.slice(-1500)
      truncatedOutput = `${firstPart}\n\n... [output truncated] ...\n\n${lastPart}`
    }

    // Build the prompt for summary generation
    const summaryPrompt = `You are generating a SHORT browser notification summary for a completed task.
The user ran a task and wants a brief notification to remind them what happened.

USER'S ORIGINAL PROMPT:
"${userPrompt}"

TASK OUTPUT (may be truncated):
${truncatedOutput}

Generate a notification summary following these rules:
1. Maximum 100 characters (this is a browser notification)
2. Focus on the OUTCOME, not the process
3. Be specific about what was accomplished
4. Use past tense (e.g., "Fixed bug in auth.ts", "Added 3 new tests")
5. If there was an error, mention it briefly
6. No emojis, no markdown, just plain text

Respond with ONLY the summary text, nothing else.`

    // Write prompt to temp file
    const promptFile = join(tempDir, `notif-summary-${Date.now()}.txt`)
    writeFileSync(promptFile, summaryPrompt)

    const systemPrompt = 'You are a notification summary assistant. Respond with only the summary text, no preamble or explanation.'

    const args = [
      '--print',
      '--model', 'haiku',
      '--system-prompt', systemPrompt,
      promptFile
    ]

    const claude = spawn('claude', args, {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    claude.stdout?.on('data', (data) => {
      stdout += data.toString()
    })

    claude.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    claude.on('close', (code) => {
      // Clean up temp file
      try {
        unlinkSync(promptFile)
      } catch {
        // Ignore cleanup errors
      }

      if (code === 0 && stdout.trim()) {
        // Truncate if somehow still too long
        const summary = stdout.trim().slice(0, 150)
        resolve(summary)
      } else {
        console.error('[Notifications] Claude error:', stderr || 'Unknown error')
        // Fallback to basic summary
        resolve(createFallbackSummary(userPrompt))
      }
    })

    claude.on('error', (err) => {
      console.error('[Notifications] Failed to spawn Claude:', err)
      resolve(createFallbackSummary(userPrompt))
    })

    // Timeout after 10 seconds
    setTimeout(() => {
      claude.kill()
      resolve(createFallbackSummary(userPrompt))
    }, 10000)
  })
}

/**
 * Create a fallback summary when AI summarization fails
 */
function createFallbackSummary(userPrompt: string): string {
  const truncated = userPrompt.slice(0, 60)
  if (userPrompt.length > 60) {
    return `Completed: "${truncated}..."`
  }
  return `Completed: "${truncated}"`
}
