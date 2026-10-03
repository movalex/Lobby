// The whole-suite CSP audit's positive control (suite-audit.config.ts with CSP_AUDIT_CONTROL=1): proves
// that a page opened the way the suite opens one (the fixtures' signed-in session on a board) reports
// what the policy would block, for each kind of violation the audit looks for. Four deliberate
// violations, each from the board page: a data: fetch (connect-src), a string-compiled function
// (script-src 'eval'), a WebAssembly compile (script-src 'wasm-eval') and a blob: video (media-src via
// default-src). Nothing is blocked (report-only), so each call still succeeds; the collector must then
// hold at least one new report per kind. The audit's summary files these under this spec, never as a
// finding.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '../../tests/support/canvas.ts'
import { WEB_PORT } from '../../tests/support/ports.ts'

const COLLECTOR = `http://127.0.0.1:${Number(process.env.CSP_AUDIT_COLLECTOR_PORT || WEB_PORT + 3)}`
const REPORTS = resolve(
  process.env.CSP_AUDIT_DIR || resolve(import.meta.dirname, `../../test-results/csp-audit-${WEB_PORT}`),
  'reports.jsonl',
)

const kinds = (from: number) =>
  readFileSync(REPORTS, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .slice(from)
    .map((l) => {
      const r = (JSON.parse(l) as { report: { 'csp-report'?: Record<string, string> } }).report['csp-report']
      return `${r?.['effective-directive']} ${r?.['blocked-uri']}`
    })

test('control: a board page reports a data: fetch, an eval, a wasm compile and a blob: video', async ({
  canvasSession,
}) => {
  const count = async () => Number(await (await fetch(`${COLLECTOR}/count`)).text())
  const lines = () =>
    readFileSync(REPORTS, 'utf8')
      .split('\n')
      .filter((l) => l.trim()).length
  const alice = await canvasSession('alice')
  await alice.page.waitForTimeout(1000)
  const before = await count()
  const from = lines()
  const ran = await alice.page.evaluate(async () => {
    const data = await (await fetch('data:,control')).text()
    const evaluated = new Function('return 1')() as number
    const wasm = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
    const video = document.createElement('video')
    video.src = URL.createObjectURL(new Blob([new Uint8Array(16)], { type: 'video/mp4' }))
    document.body.append(video)
    return { data, evaluated, wasm: wasm instanceof WebAssembly.Module }
  })
  expect(ran).toEqual({ data: 'control', evaluated: 1, wasm: true })
  await expect.poll(count, { timeout: 15_000 }).toBeGreaterThanOrEqual(before + 4)
  const got = kinds(from)
  console.log(`control reports: ${got.join(', ')}`)
  for (const want of ['connect-src data', 'script-src eval', 'script-src wasm-eval', 'media-src blob'])
    expect(got, want).toContain(want)
})
