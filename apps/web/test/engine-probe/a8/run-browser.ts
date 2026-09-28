/**
 * Spike check A8, browser confirmation: the index collision through a mounted <Excalidraw>'s real
 * `api.updateScene`, without and with Lobby's pre-pass. The Node half is
 * `apps/web/src/canvas/sync/index-keys.test.ts`.
 *
 *   node apps/web/test/engine-probe/a8/run-browser.ts [--port=7751]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildProbePage, openProbePage } from '../browser/browser.ts'

const port = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? '7751')
const outDir = fileURLToPath(new URL('../../../../../test-results/engine-probe/', import.meta.url))
mkdirSync(outDir, { recursive: true })
await buildProbePage()
const s = await openProbePage(port)
try {
  const r = (await s.page.evaluate(() => window.__probe.a8?.())) as {
    withoutPrePass: { confirmedChanges: unknown[]; assertion: string | null }
    withPrePass: { confirmedChanges: unknown[]; assertion: string | null; rekeys: unknown[] }
  }
  const reproduced = r.withoutPrePass.confirmedChanges.length === 1 && r.withoutPrePass.assertion !== null
  const silent = r.withPrePass.confirmedChanges.length === 0 && r.withPrePass.assertion === null
  const pass = reproduced && silent && s.pageErrors.length === 0 && s.foreignRequests.length === 0
  writeFileSync(
    `${outDir}a8-browser.json`,
    JSON.stringify({ browser: s.browserVersion, pass, ...r }, null, 1),
  )
  console.log(
    `A8 browser: ${pass ? 'PASS' : 'FAIL'} — without pre-pass ${JSON.stringify(r.withoutPrePass.confirmedChanges)} ` +
      `(assertion fired: ${r.withoutPrePass.assertion !== null}); with pre-pass rekeys ${JSON.stringify(r.withPrePass.rekeys)}, ` +
      `confirmed changes ${r.withPrePass.confirmedChanges.length}, assertion silent: ${r.withPrePass.assertion === null}`,
  )
  process.exitCode = pass ? 0 : 1
} finally {
  await s.close()
}
