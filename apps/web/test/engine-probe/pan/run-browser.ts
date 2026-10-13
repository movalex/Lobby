/**
 * Wave O (WO-PAN) probes, against a mounted <Excalidraw> of the pinned build in headless Chromium:
 *  - O-1, at the e2e suite's device pixel ratio (1.25): the speed-ups that live in Excalidraw's app and renderer (the
 *    visible pass, the kept renderable map, the embeddable scans): `browser/pan.ts` (`checkPanEngine`);
 *  - O-2, at device pixel ratios 1, 1.25, 1.5 and 2 (a page each: the snap's rounding and the blit's whole-pixel shift
 *    depend on it): the pan blit draws what a full render draws, at five zooms, with grid mode on, after each input
 *    that must end a blit, and with its scratch canvas freed or lost: `browser/pan-blit.ts` (`checkPanBlit`).
 * `pnpm probe:browser` runs them after the render-cull probe (render-cull/run-browser.ts imports this file when it is
 * done).
 *
 *   node apps/web/test/engine-probe/pan/run-browser.ts [--port=7754]   (default: E2E_PORT_BASE + 38 when set)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildProbePage, openProbePage, PROBE_PORT_OFFSET, probePort } from '../browser/browser.ts'

/** the device pixel ratios the blit's pixel equality is checked at */
const BLIT_DPRS = [1, 1.25, 1.5, 2] as const

const port = probePort(PROBE_PORT_OFFSET.pan, 7754)
const outDir = fileURLToPath(new URL('../../../../../test-results/engine-probe/', import.meta.url))
mkdirSync(outDir, { recursive: true })
await buildProbePage()
const out: Record<string, unknown> = {}
let allPass = true

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
  out.browser = s.browserVersion
  out.engine = r
  allPass &&= pass
} finally {
  await s.close()
}

for (const dpr of BLIT_DPRS) {
  const p = await openProbePage(port, { deviceScaleFactor: dpr })
  try {
    const b = await p.page.evaluate(() => window.__probe.panBlit?.())
    if (!b) throw new Error('window.__probe.panBlit is not on the probe page')
    const blitPass = b.ok && p.pageErrors.length === 0 && p.foreignRequests.length === 0
    const views = b.views
      .map(
        (v) =>
          `${v.zoom}${v.grid ? ' grid' : ''}: control ${v.control.pixels} px (max ${v.control.max}), ${v.blits} blits, rest ${v.restVsBlit.pixels} px, full ${v.fullVsBlit.pixels} px (max ${v.fullVsBlit.max}), rest vs full ${v.restVsFull.pixels} px`,
      )
      .join('; ')
    const stale = b.stale
      .map(
        (c) =>
          `${c.name}: full at once ${c.fullAtOnce}, ${c.blitsAfter} blits, ${c.fullVsBlit.pixels} px (max ${c.fullVsBlit.max}), control ${c.control.pixels} px (max ${c.control.max}) near ${c.near.join(' ')}`,
      )
      .join('; ')
    const blitWhy = b.detail.length ? `; ${b.detail.join('; ')}` : ''
    const sc = b.scratch
    const scratch = `scratch seen ${sc.seen}, at rest ${sc.atRest.join(' x ')}, sized again ${sc.sizedAgain} (${sc.blitsAgain} blits, ${sc.fullVsBlit.pixels} px from a full render, control ${sc.control.pixels} px)`
    console.log(
      `pan blit at dpr ${dpr}: ${blitPass ? 'PASS' : 'FAIL'} — ${views}; ${stale}; ${scratch}; page errors ${p.pageErrors.length}, foreign requests ${p.foreignRequests.length}${blitWhy}`,
    )
    out[`blit@${dpr}`] = b
    allPass &&= blitPass
  } finally {
    await p.close()
  }
}

writeFileSync(`${outDir}pan-browser.json`, JSON.stringify({ pass: allPass, ...out }, null, 1))
if (!allPass) process.exitCode = 1
