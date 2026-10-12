/**
 * Wave O (WO-PAN) probe: the engine patch's pan speed-ups that live in Excalidraw's app and renderer (the visible pass,
 * the kept renderable map, the embeddable scans), against a mounted <Excalidraw> of the pinned build in headless
 * Chromium. The check itself is `browser/pan.ts` (`checkPanEngine`). `pnpm probe:browser` runs it after the render-cull
 * probe (render-cull/run-browser.ts imports this file when it is done).
 *
 *   node apps/web/test/engine-probe/pan/run-browser.ts [--port=7754]   (default: E2E_PORT_BASE + 38 when set)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildProbePage, openProbePage, PROBE_PORT_OFFSET, probePort } from '../browser/browser.ts'

const port = probePort(PROBE_PORT_OFFSET.pan, 7754)
const outDir = fileURLToPath(new URL('../../../../../test-results/engine-probe/', import.meta.url))
mkdirSync(outDir, { recursive: true })
await buildProbePage()
const s = await openProbePage(port)
try {
  const r = (await s.page.evaluate(() => window.__probe.pan?.())) as
    | ({ ok: boolean; detail: string[] } & Record<string, boolean>)
    | undefined
  if (!r) throw new Error('window.__probe.pan is not on the probe page')
  const pass = r.ok && s.pageErrors.length === 0 && s.foreignRequests.length === 0
  writeFileSync(
    `${outDir}pan-browser.json`,
    JSON.stringify({ browser: s.browserVersion, pass, ...r }, null, 1),
  )
  const why = r.detail.length ? `; ${r.detail.join('; ')}` : ''
  console.log(
    `pan speed-ups: ${pass ? 'PASS' : 'FAIL'} — ${Object.entries(r)
      .filter(([k]) => k !== 'ok' && k !== 'detail')
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}; page errors ${s.pageErrors.length}, foreign requests ${s.foreignRequests.length}${why}`,
  )
  if (!pass) process.exitCode = 1
} finally {
  await s.close()
}
