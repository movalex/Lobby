/**
 * Wave N (WS1, N1-5) probe: a render-override offset still culls on the pinned nightly (the level-of-detail pass's
 * seam, apps/web/src/canvas/lod/cull.ts), against a mounted <Excalidraw> of the pinned build in headless Chromium. The
 * check itself is `browser/render-cull.ts` (`checkRenderCull`). `pnpm probe:browser` runs it after the addFiles probe
 * (add-files/run-browser.ts imports this file when it is done), then wave O's pan probe (../pan/run-browser.ts).
 *
 *   node apps/web/test/engine-probe/render-cull/run-browser.ts [--port=7753]   (default: E2E_PORT_BASE + 37 when set)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildProbePage, openProbePage, PROBE_PORT_OFFSET, probePort } from '../browser/browser.ts'

const port = probePort(PROBE_PORT_OFFSET.renderCull, 7753)
const outDir = fileURLToPath(new URL('../../../../../test-results/engine-probe/', import.meta.url))
mkdirSync(outDir, { recursive: true })
await buildProbePage()
const s = await openProbePage(port)
try {
  const r = (await s.page.evaluate(() => window.__probe.renderCull?.())) as
    | ({ ok: boolean } & Record<string, boolean>)
    | undefined
  if (!r) throw new Error('window.__probe.renderCull is not on the probe page')
  const pass = r.ok && s.pageErrors.length === 0 && s.foreignRequests.length === 0
  writeFileSync(
    `${outDir}render-cull-browser.json`,
    JSON.stringify({ browser: s.browserVersion, pass, ...r }, null, 1),
  )
  console.log(
    `render-override offsets cull: ${pass ? 'PASS' : 'FAIL'} — ${Object.entries(r)
      .filter(([k]) => k !== 'ok')
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}; page errors ${s.pageErrors.length}, foreign requests ${s.foreignRequests.length}`,
  )
  if (!pass) process.exitCode = 1
} finally {
  await s.close()
}
// wave O (WO-PAN): the pan speed-ups probe, in its own page (it only ever sets a failing exit code)
await import('../pan/run-browser.ts')
