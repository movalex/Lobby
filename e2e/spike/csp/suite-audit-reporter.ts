// The whole-suite CSP audit's timeline (suite-audit.config.ts): one JSON line per test start and end in
// CSP_AUDIT_TIMELINE, so suite-audit-dedupe.ts can tell which test was running when a report arrived (the
// suite runs one test at a time, so the latest test that began before a report is the one that caused
// it, give or take the browser's sending delay).
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter'

export default class SuiteAuditReporter implements Reporter {
  private readonly out = resolve(process.env.CSP_AUDIT_TIMELINE ?? 'csp-audit-timeline.jsonl')
  private readonly root = resolve(import.meta.dirname, '../../excalidraw')
  private passed = 0
  private failed = 0
  private skipped = 0
  private flaky = 0

  constructor() {
    mkdirSync(dirname(this.out), { recursive: true })
  }

  private write(line: Record<string, unknown>) {
    appendFileSync(this.out, `${JSON.stringify({ t: Date.now(), ...line })}\n`)
  }

  private where(test: TestCase) {
    return {
      file: relative(this.root, test.location.file).replaceAll('\\', '/'),
      line: test.location.line,
      title: test.titlePath().slice(3).join(' › '),
    }
  }

  onBegin() {
    this.write({ ev: 'run-begin' })
  }

  onTestBegin(test: TestCase, result: TestResult) {
    this.write({ ev: 'begin', ...this.where(test), retry: result.retry })
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const outcome = test.outcome()
    if (outcome === 'expected') this.passed++
    else if (outcome === 'unexpected') this.failed++
    else if (outcome === 'skipped') this.skipped++
    else this.flaky++
    this.write({
      ev: 'end',
      ...this.where(test),
      status: result.status,
      expected: test.expectedStatus,
      outcome,
      ms: result.duration,
      // the first line of the error only (no page content)
      error: result.error?.message?.split('\n')[0]?.slice(0, 200),
    })
  }

  onEnd(result: FullResult) {
    this.write({
      ev: 'run-end',
      status: result.status,
      ms: result.duration,
      passed: this.passed,
      failed: this.failed,
      skipped: this.skipped,
      flaky: this.flaky,
    })
  }
}
