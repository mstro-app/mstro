import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Reporter } from 'vitest/reporters'
import type { File, TaskResultPack, TestCase } from 'vitest'

const logDir = join(homedir(), '.mstro', 'logs')
const logFile = join(logDir, 'cli_tests_logout.md')

export default class TestLogger implements Reporter {
  private counter = 0
  private lines: string[] = []

  onInit() {
    mkdirSync(logDir, { recursive: true })
    const timestamp = new Date().toISOString()
    this.lines = [
      `# CLI Test Run Log`,
      ``,
      `**Started:** ${timestamp}`,
      ``,
      `| # | Status | Test | File |`,
      `|---|--------|------|------|`,
    ]
    this.counter = 0
  }

  onTestCaseReady(testCase: TestCase) {
    const name = testCase.fullName
    appendFileSync(logFile, `About to run ${name} test\n`, 'utf-8')
  }

  onTaskUpdate(packs: TaskResultPack[]) {
    for (const [id, result, meta] of packs) {
      // We only care about completed test results
      if (!result?.state || result.state === 'run') continue
    }
  }

  onFinished(files?: File[]) {
    if (!files) return

    for (const file of files) {
      this.collectTests(file.tasks, file.name)
    }

    const timestamp = new Date().toISOString()
    this.lines.push(``, `**Finished:** ${timestamp}`, `**Total tests:** ${this.counter}`)

    writeFileSync(logFile, this.lines.join('\n') + '\n', 'utf-8')
  }

  private collectTests(tasks: any[], fileName: string, prefix = '') {
    for (const task of tasks) {
      if (task.type === 'suite' && task.tasks) {
        const suiteName = prefix ? `${prefix} > ${task.name}` : task.name
        this.collectTests(task.tasks, fileName, suiteName)
      } else if (task.type === 'test') {
        this.counter++
        const fullName = prefix ? `${prefix} > ${task.name}` : task.name
        const status = task.result?.state === 'pass' ? 'PASS'
          : task.result?.state === 'fail' ? 'FAIL'
          : task.result?.state === 'skip' ? 'SKIP'
          : task.result?.state ?? 'UNKNOWN'
        // Escape pipe chars for markdown table
        const safeName = fullName.replace(/\|/g, '\\|')
        const safeFile = fileName.replace(/\|/g, '\\|')
        this.lines.push(`| ${this.counter} | ${status} | ${safeName} | ${safeFile} |`)
      }
    }
  }
}
