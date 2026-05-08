// Copyright (c) 2025-present Mstro, Inc. All rights reserved.

/**
 * Internal Routes
 *
 * HTTP endpoints used by sibling subprocesses (like the MCP bouncer) to talk
 * back to the running CLI server. NOT mounted under `/api/*` — these are gated
 * by the per-process bouncer secret instead of the user's session token.
 *
 * Currently a single endpoint:
 *   POST /internal/ask-user-question
 *     Bouncer pauses Claude on AskUserQuestion; this blocks until the web
 *     user answers, then returns the answers Claude needs to continue.
 */

import { Hono } from 'hono'
import {
  isValidBouncerSecret,
  registerPendingQuestion,
} from '../services/websocket/ask-user-question-bridge.js'
import type { HandlerContext } from '../services/websocket/handler-context.js'
import { broadcastTabEvent } from '../services/websocket/tab-broadcast.js'
import type {
  AskUserQuestionItem,
  AskUserQuestionPayload,
} from '../services/websocket/types.js'

interface AskUserQuestionRequestBody {
  toolUseId?: unknown
  tabId?: unknown
  questions?: unknown
  /** Override default 15min timeout (ms). Optional. */
  timeoutMs?: unknown
}

/** Narrow an unknown into AskUserQuestionItem[] without throwing. */
function parseQuestions(value: unknown): AskUserQuestionItem[] | null {
  if (!Array.isArray(value)) return null
  const out: AskUserQuestionItem[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (typeof r.question !== 'string' || typeof r.header !== 'string') return null
    if (!Array.isArray(r.options)) return null
    const options = r.options.map((o) => {
      if (!o || typeof o !== 'object') return null
      const oo = o as Record<string, unknown>
      if (typeof oo.label !== 'string') return null
      return {
        label: oo.label,
        description: typeof oo.description === 'string' ? oo.description : '',
        preview: typeof oo.preview === 'string' ? oo.preview : undefined,
      }
    })
    if (options.some((o) => o === null)) return null
    out.push({
      question: r.question,
      header: r.header,
      options: options as AskUserQuestionItem['options'],
      multiSelect: r.multiSelect === true,
    })
  }
  return out
}

export function createInternalRoutes(ctx: HandlerContext): Hono {
  const app = new Hono()

  app.post('/ask-user-question', async (c) => {
    const secret = c.req.header('x-mstro-bouncer-secret')
    if (!isValidBouncerSecret(secret)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    let body: AskUserQuestionRequestBody
    try {
      body = (await c.req.json()) as AskUserQuestionRequestBody
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const toolUseId = typeof body.toolUseId === 'string' ? body.toolUseId : ''
    const tabId = typeof body.tabId === 'string' ? body.tabId : ''
    const questions = parseQuestions(body.questions)
    if (!toolUseId || !tabId || !questions || questions.length === 0) {
      return c.json({ error: 'toolUseId, tabId, and non-empty questions[] are required' }, 400)
    }

    const timeoutMs =
      typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? body.timeoutMs : undefined

    const payload: AskUserQuestionPayload = { toolUseId, questions }
    broadcastTabEvent(ctx, tabId, 'askUserQuestion', payload)

    try {
      const answers = await registerPendingQuestion({ toolUseId, tabId, timeoutMs })
      return c.json({ answers })
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'cancelled'
      // Tell every web client to dismiss the card so users don't keep poking
      // an already-dead question.
      broadcastTabEvent(ctx, tabId, 'askUserQuestionDismissed', {
        toolUseId,
        reason: reason === 'timeout' ? 'timeout' : 'cancelled',
      })
      const status = reason === 'timeout' ? 504 : 410
      return c.json({ error: reason }, status)
    }
  })

  return app
}
