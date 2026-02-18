import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('WebSocket handler code quality', () => {
  const handlerSource = readFileSync(
    join(import.meta.dirname || __dirname, 'handler.ts'),
    'utf-8'
  )

  it('does not use require() — ESM only', () => {
    // Ensure no require() calls exist (the bug was require('fs').mkdirSync)
    const requireCalls = handlerSource.match(/require\s*\(/g)
    expect(requireCalls).toBeNull()
  })

  it('imports mkdirSync from fs at the top level', () => {
    expect(handlerSource).toContain("import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'")
  })
})
