/**
 * Plan §6.5 probe "addFiles keeps the first entry for an id" (the one the spike-A report listed as missing),
 * against a mounted <Excalidraw> of the pinned build in headless Chromium. The checks themselves are
 * `browser/add-files.ts` (`checkAddFiles`); `add-files.test.ts` shows they fail on an engine that replaces.
 *
 *   node apps/web/test/engine-probe/add-files/run-browser.ts [--port=7752]   (default: E2E_PORT_BASE + 36 when set)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildProbePage, openProbePage, PROBE_PORT_OFFSET, probePort } from '../browser/browser.ts'

const port = probePort(PROBE_PORT_OFFSET.addFiles, 7752)
const outDir = fileURLToPath(new URL('../../../../../test-results/engine-probe/', import.meta.url))
mkdirSync(outDir, { recursive: true })
await buildProbePage()
const s = await openProbePage(port)
try {
  const r = (await s.page.evaluate(() => window.__probe.addFiles?.())) as
    | ({ ok: boolean } & Record<string, boolean>)
    | undefined
  if (!r) throw new Error('window.__probe.addFiles is not on the probe page')
  const pass = r.ok && s.pageErrors.length === 0 && s.foreignRequests.length === 0
  writeFileSync(
    `${outDir}add-files-browser.json`,
    JSON.stringify({ browser: s.browserVersion, pass, ...r }, null, 1),
  )
  console.log(
    `addFiles first entry: ${pass ? 'PASS' : 'FAIL'} — ${Object.entries(r)
      .filter(([k]) => k !== 'ok')
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}; page errors ${s.pageErrors.length}, foreign requests ${s.foreignRequests.length}`,
  )
  process.exitCode = pass ? 0 : 1
} finally {
  await s.close()
}
