import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, expect, request, test } from '@playwright/test'
import type { PerfEditor } from '../../perf/lib.ts'
import { DPR, gpuInfo, launchGpuShell, measureView, VIEWPORT, type ViewResult } from '../fixtures/perf-kit.ts'
import { SPIKE_RUN_TAG } from '../support/ports.ts'

// A14 baseline: today's tldraw board, measured the SAME way as render-a14-heavy (fixtures/perf-kit.ts),
// in the same browser (Playwright's headless shell with e2e/perf's GPU flags), viewport and machine, so
// the Excalidraw numbers compare with it directly, and with the review's branded-Chrome numbers (3.36 s
// open; 26-32 / 49-54 / 58-60 fps). It reuses e2e/perf as is: the real api + sync + preview worker
// (e2e/perf/stack.ts on E2E_PORT_BASE, default 7820 here), the heavy seed (seed.ts: 20 frames, 4,500
// notes, 200 uploaded images with previews, tags, 40 comment threads) and openBoard (lib.ts).
// Opt-in (SPIKE_A14_TLDRAW=1): the seed alone takes about 2 minutes (upload rate limit).

test.skip(!process.env.SPIKE_A14_TLDRAW, 'set SPIKE_A14_TLDRAW=1 to measure the tldraw baseline')
test.setTimeout(30 * 60_000)

let browser: Browser
test.beforeAll(async () => {
  browser = await launchGpuShell()
})
test.afterAll(async () => {
  await browser?.close()
})

test('A14 baseline: the tldraw heavy board, same method, same browser', async () => {
  const run = process.env.SPIKE_A14_RUN ?? '0'
  const log = (s: string) => console.log(`[A14 tldraw run ${run}] ${s}`)
  process.env.E2E_PORT_BASE ??= '7820'
  // imported after E2E_PORT_BASE is set: tests/support/ports.ts reads it at import time
  const { startPerfStack } = await import('../../perf/stack.ts')
  const { Api } = await import('../../tests/support/api.ts')
  const { seedHeavyBoard, HEAVY } = await import('../../perf/seed.ts')
  const { openBoard, signedInContext } = await import('../../perf/lib.ts')
  const perf = await startPerfStack({
    reuseBuild: process.env.SPIKE_A14_REUSE_BUILD === '1',
    readable: false,
    log,
  })
  const disposers: (() => Promise<unknown>)[] = []
  try {
    const web = perf.web
    const alice = await Api.signIn({ request }, 'alice', 'Alice Park')
    disposers.push(() => alice.api.dispose())
    const studio = alice.me.workspaces.find((w) => w.name === 'Dev Studio')
    if (studio?.role !== 'owner') throw new Error('alice must be the first user of a fresh stack')
    const created = await alice.api.createBoard(studio.id, 'Perf heavy board')
    const seedCtx = await signedInContext(browser, web, 'alice', 'Alice Park')
    const seedPage = await seedCtx.newPage()
    await openBoard(seedPage, web, created.id)
    const board = await seedHeavyBoard(seedPage, created.id, HEAVY, log)
    await seedCtx.close()

    // cold opens, each in a fresh context (e2e/perf's openBoard: until every rendered shape is in the DOM)
    const opens: number[] = []
    for (let i = 0; i < 3; i++) {
      const ctx = await signedInContext(browser, web, 'alice', 'Alice Park')
      const p = await ctx.newPage()
      opens.push(await openBoard(p, web, board.boardId))
      await ctx.close()
      log(`open ${i + 1}: ${opens.at(-1)} ms`)
    }

    const ctx = await signedInContext(browser, web, 'alice', 'Alice Park')
    const page = await ctx.newPage()
    const gpu = await gpuInfo(browser, page)
    const openMs = await openBoard(page, web, board.boardId)
    const cdp = await ctx.newCDPSession(page)
    await page.evaluate(() => {
      const ed = (window as unknown as { editor: PerfEditor }).editor
      const w = window as unknown as Record<string, unknown>
      let o = { x: 0, y: 0, z: 1 }
      w.__panStart = () => {
        o = { ...ed.getCamera() }
      }
      w.__panBy = (dx: number, dy: number) =>
        ed.setCamera({ x: o.x - dx / o.z, y: o.y - dy / o.z, z: o.z }, { immediate: true })
      w.__panEnd = () => ed.setCamera(o, { immediate: true })
    })
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2)
    await page.waitForTimeout(3000)
    const views: (ViewResult & { visible: number })[] = []
    for (const view of ['fit', '0.25', '1'] as const) {
      const v = await page.evaluate(async (view) => {
        const ed = (window as unknown as { editor: PerfEditor }).editor
        ed.selectNone()
        const b = ed.getShapePageBounds('shape:perf-f0')
        if (!b) throw new Error('no frame 0')
        const vp = ed.getViewportScreenBounds()
        if (view === 'fit') ed.zoomToFit({ immediate: true })
        else if (view === '0.25') {
          const z = 0.25
          ed.setCamera({ x: vp.w / 2 / z - b.center.x, y: vp.h / 2 / z - b.center.y, z }, { immediate: true })
        } else ed.setCamera({ x: 20 - (b.x + 20), y: 20 - (b.y + 40), z: 1 }, { immediate: true })
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const r = ed.getRenderingShapes()
        return { zoom: ed.getZoomLevel(), visible: r.length - ed.getCulledShapes().size }
      }, view)
      await page.waitForTimeout(2500)
      await page
        .waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 15_000 })
        .catch(() => {})
      const r = await measureView(page, cdp, view, v.zoom)
      views.push({ ...r, visible: v.visible })
      log(
        `fps ${view} (zoom ${v.zoom.toFixed(3)}, ${v.visible} shapes visible): ${r.reps.map((x) => x.fps).join(' / ')} ` +
          `(median ${r.medianFps}; trace ${r.trace?.traceFps} fps drawn, main ${r.trace?.mainBusyPct}% busy; machine ${r.machineBusyPct}% busy)`,
      )
    }
    await ctx.close()
    const report = {
      at: new Date().toISOString(),
      run,
      gpu,
      viewport: `${VIEWPORT.width}x${VIEWPORT.height} @${DPR}`,
      board,
      opens,
      openMs,
      views,
    }
    const dir = join(import.meta.dirname, '..', '..', 'test-results', `${SPIKE_RUN_TAG}-a14`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `a14-tldraw-run-${run}.json`), JSON.stringify(report, null, 2))
    console.log('A14-TLDRAW-METRICS', JSON.stringify(report))
    expect(views).toHaveLength(3)
  } finally {
    for (const d of disposers.splice(0).reverse()) await d().catch(() => {})
    await perf.stop()
  }
})
