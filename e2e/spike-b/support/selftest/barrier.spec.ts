// The 20 ms release across SEPARATE browser processes (docs/EXCALIDRAW-MIGRATION.md §8.1), on spike A's
// engine page (/spike/engine: Excalidraw with the fixed props, no session), before any spike B board page
// exists: three Chromium processes, 20 releases each way.
//  - runTogether: an in-page action (here: an updateScene on each page's own engine) armed for one
//    instant; the in-page start times must lie within 20 ms, every time;
//  - a Node-side barrier releasing page.mouse actions: the spread of the CDP calls is measured and
//    reported (it is what pointer races like B1.1's drag-up get).
import { type Browser, chromium, expect, type Page, test } from '@playwright/test'
import { waitSpikeReady } from '../../../spike/support/page.ts'
import { isForeign } from '../../../spike/support/watch.ts'
import { releaseTogether, runTogether } from '../barrier.ts'

const REPS = 20
const browsers: Browser[] = []
const pages: Page[] = []

test.beforeAll(async () => {
  for (let i = 0; i < 3; i++) {
    const b = await chromium.launch({ headless: true })
    browsers.push(b)
    const ctx = await b.newContext({
      baseURL: test.info().project.use.baseURL,
      viewport: { width: 1000, height: 700 },
    })
    await ctx.route(
      (u) => isForeign(u.href),
      (r) => r.abort('blockedbyclient'),
    )
    const p = await ctx.newPage()
    await p.goto('/spike/engine?role=editor&theme=light')
    await waitSpikeReady(p)
    pages.push(p)
  }
})
test.afterAll(async () => {
  await Promise.all(browsers.map((b) => b.close()))
})

test('in-page actions armed for one instant start within 20 ms across three processes', async () => {
  const spreads: number[] = []
  for (let i = 0; i < REPS; i++) {
    const r = await runTogether(
      pages.map((page, k) => ({
        name: `P${k}`,
        page,
        arg: { k, i },
        fn: ({ k, i }: { k: number; i: number }) => {
          const spike = (window as unknown as { __lobbySpike: { api: { updateScene(s: unknown): void } } })
            .__lobbySpike
          spike.api.updateScene({
            appState: { viewBackgroundColor: `#ffff${(10 + k + (i % 5)).toString(16)}` },
          })
          return Date.now()
        },
      })),
    )
    spreads.push(r.spreadMs)
    for (const p of r.parties) expect(p.startedAt).toBeGreaterThanOrEqual(r.releaseAt)
  }
  test.info().annotations.push({ type: 'in-page spread ms', description: spreads.join(' ') })
  expect(Math.max(...spreads)).toBeLessThanOrEqual(20)
})

test('a Node barrier releasing pointer actions: the spread is measured', async () => {
  const spreads: number[] = []
  const done: number[] = []
  for (let i = 0; i < REPS; i++) {
    const r = await releaseTogether(
      pages.map((page, k) => ({
        name: `P${k}`,
        run: async () => {
          await page.mouse.move(100 + k * 10 + i, 200)
          return Date.now()
        },
      })),
    )
    spreads.push(r.spreadMs)
    const ends = r.results.map((x) => x.doneAt)
    done.push(Math.max(...ends) - Math.min(...ends))
  }
  test.info().annotations.push({
    type: 'node barrier spread ms (start / completion)',
    description: `${spreads.join(' ')} / ${done.join(' ')}`,
  })
  expect(Math.max(...spreads)).toBeLessThanOrEqual(20)
})
