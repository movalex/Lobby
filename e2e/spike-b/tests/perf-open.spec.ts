// §8.4 "Render": the heavy board's open THROUGH THE REAL STACK (ticket, socket, welcome, snapshot, apply,
// first paint), which spike A could not measure (it opened static JSON in 0.67–0.70 s), and a typical
// 2k-object board's open time. Same method as spike A14 (e2e/spike/fixtures/perf-kit.ts): Playwright's
// headless shell with e2e/perf's GPU flags, 1536x864 at DPR 1.25, 3 cold opens each in a fresh context
// (empty HTTP cache). The §8.5 gate: no slower than today's tldraw with the same method (median 3.8 s,
// re-measured in the same quiet window by render-a14-tldraw, scripts/o3-measure.sh).
//
// Opt-in, timing-gated: SPIKE_PERF=1, SPIKE_B_PORT_BASE=7885, the lead's quiet window; 3 runs
// (SPIKE_B_RUN=1..3). Needs M1 (the board page, the room) and O5's A1 (the images' file-refs).
import { type Browser, expect, test } from '@playwright/test'
import { median } from '../../perf/lib.ts'
import { gpuInfo, launchGpuShell } from '../../spike/fixtures/perf-kit.ts'
import { writeEvidence } from '../support/checks.ts'
import { harness } from '../support/harness.ts'
import { coldOpen, type OpenTiming } from '../support/perf.ts'
import { type SeededBoard, seedHeavy, seedNotes } from '../support/seed.ts'
import type { O3Stack } from '../support/stack.ts'
import type { DevUser } from '../support/types.ts'

test.skip(
  !process.env.SPIKE_PERF,
  'set SPIKE_PERF=1 (quiet window, SPIKE_B_PORT_BASE=7885) for the §8.4 numbers',
)
test.setTimeout(45 * 60_000)

let stack: O3Stack
let owner: DevUser
let browser: Browser
let heavy: SeededBoard
let typical: SeededBoard

test.beforeAll(async () => {
  stack = await harness.startStack()
  owner = harness.devUser('Perf')
  browser = await launchGpuShell()
  heavy = await seedHeavy(stack, owner, { log: (s) => console.log(`[perf-open] ${s}`) })
  // a typical board: about 2k objects (18 frames of 100 notes, 180 bound arrows): L1's workshop board
  typical = await seedNotes(stack, owner, {
    notes: 1_800,
    frames: 18,
    arrows: 180,
    title: 'O3 typical board',
  })
})
test.afterAll(async () => {
  await browser?.close()
  await stack?.stop()
})

test('§8.4: heavy board and a typical 2k-object board, open through the real stack', async () => {
  const testInfo = test.info()
  const page = await (await browser.newContext()).newPage()
  const gpu = await gpuInfo(browser, page)
  await page.context().close()
  const result: Record<string, { opens: OpenTiming[]; medianPaintedMs: number; elements: number }> = {}
  for (const [name, b] of [
    ['heavy', heavy],
    ['typical', typical],
  ] as const) {
    const opens: OpenTiming[] = []
    for (let i = 0; i < 3; i++) opens.push(await coldOpen(browser, stack, owner, b.boardId))
    result[name] = {
      opens,
      medianPaintedMs: median(opens.map((o) => o.paintedMs)),
      elements: b.board.elements.length,
    }
    console.log(
      `[perf-open] ${name}: ${opens.map((o) => `${o.paintedMs} ms`).join(' / ')} (ready ${opens.map((o) => o.readyMs).join('/')})`,
    )
    for (const o of opens) expect(o.elements).toBe(b.board.elements.filter((e) => !e.isDeleted).length)
  }
  writeEvidence(testInfo, 'perf-open', {
    gpu,
    seed: { heavy: heavy.seed, typical: typical.seed, uploadMs: heavy.uploadMs },
    result,
  })
})
