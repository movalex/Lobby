/**
 * Wave O (WO-PAN) probes, against a mounted <Excalidraw> of the pinned build in headless Chromium at the e2e suite's
 * device pixel ratio (1.25):
 *  - O-1: the speed-ups that live in Excalidraw's app and renderer (the visible pass, the kept renderable map, the
 *    embeddable scans): `browser/pan.ts` (`checkPanEngine`);
 *  - O-2: the pan blit draws what a full render draws, at five zooms and after each input that must end a blit:
 *    `browser/pan-blit.ts` (`checkPanBlit`).
 * `pnpm probe:browser` runs them after the render-cull probe (render-cull/run-browser.ts imports this file when it is
 * done).
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
const s = await openProbePage(port, { deviceScaleFactor: 1.25 })
try {
  const r = (await s.page.evaluate(() => window.__probe.pan?.())) as
    | ({ ok: boolean; detail: string[] } & Record<string, boolean>)
    | undefined
  if (!r) throw new Error('window.__probe.pan is not on the probe page')
  const pass = r.ok && s.pageErrors.length === 0 && s.foreignRequests.length === 0
  const why = r.detail.length ? `; ${r.detail.join('; ')}` : ''
  console.log(
    `pan speed-ups: ${pass ? 'PASS' : 'FAIL'} — ${Object.entries(r)
      .filter(([k]) => k !== 'ok' && k !== 'detail')
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}; page errors ${s.pageErrors.length}, foreign requests ${s.foreignRequests.length}${why}`,
  )
  const b = await s.page.evaluate(() => window.__probe.panBlit?.())
  if (!b) throw new Error('window.__probe.panBlit is not on the probe page')
  const blitPass = b.ok && s.pageErrors.length === 0 && s.foreignRequests.length === 0
  const views = b.views
    .map(
      (v) =>
        `${v.zoom}: control ${v.control.pixels} px (max ${v.control.max}), ${v.blits} blits, rest ${v.restVsBlit.pixels} px, full ${v.fullVsBlit.pixels} px (max ${v.fullVsBlit.max}), rest vs full ${v.restVsFull.pixels} px`,
    )
    .join('; ')
  const stale = b.stale
    .map(
      (c) =>
        `${c.name}: full at once ${c.fullAtOnce}, ${c.blitsAfter} blits, ${c.fullVsBlit.pixels} px (max ${c.fullVsBlit.max}), control ${c.control.pixels} px (max ${c.control.max}) near ${c.near.join(' ')}`,
    )
    .join('; ')
  const blitWhy = b.detail.length ? `; ${b.detail.join('; ')}` : ''
  console.log(`pan blit: ${blitPass ? 'PASS' : 'FAIL'} — ${views}; ${stale}${blitWhy}`)
  writeFileSync(
    `${outDir}pan-browser.json`,
    JSON.stringify({ browser: s.browserVersion, pass: pass && blitPass, engine: r, blit: b }, null, 1),
  )
  if (!pass || !blitPass) process.exitCode = 1
} finally {
  await s.close()
}
