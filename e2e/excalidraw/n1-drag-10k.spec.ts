// N1-6 (wave N): the per-change cost at 10k elements. A note of the 10k board (e2e/excalidraw/support/big-board.ts) is
// dragged with the real pointer for about 3 s at zoom 1 while the page counts every walk of the whole scene by its site
// (apps/web/src/canvas/api/parts/scene-index.ts `noteSceneWalk`, `window.__lobbyWalks`; dev-auth builds only) and the
// frames it draws. Three classes of site:
//  - Lobby's own overlays, passes and the board page (the scene index, the LOD pass, the presence hub, the frame-name
//    guard, the hidden-branch expansion, the hit guard, the board page's change stream): 0 walks per pointer move, and
//    any site counted that is not one of the two classes below fails the spec (a new per-move walk or whole-scene
//    allocation in canvas code that the counter sees);
//  - the engine's change detection (CHANGE_DETECTION): Excalidraw's onChange names no changed element, so the sync
//    adapter's fingerprint, the sync core's scan (and its `unseen` check when Saved is read), the port's version scan
//    (port-impl.ts afterSceneChange, counted at its caller in board/session.ts) and an apply of the server's changes
//    (`sync.apply`: the element array rebuilt around them) each walk the scene once per scene change (`sync.unseen` also
//    per inbound frame). Not 0: recorded, and bounded at CHANGE_DETECTION_PER_MOVE per pointer move each (O(changed) needs the engine's change increments, a
//    follow-up in the WS1 report);
//  - `items`: every `canvas.items()` read (the features' own walks: a production bundle names no module, so the table
//    has one row for them; under the Vite dev server they are named per feature). Recorded only.
// The walk table and the fps are attached (n1-drag-10k.json).
//
// The fps targets (at least 50 median on this machine, at least 25 with the CPU 4x slower: the laptop stand-in) are
// asserted with N1_PERF=1 (a measurement run on a quiet machine); without it they are recorded only.
//
//   N1_PERF=1 E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n1-drag-10k.spec.ts --project=chromium --workers=1
import { writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { logProfile, startProfile, stopProfile, summarizeProfile } from '../perf/fps.ts'
import { expect, itemCenterOnScreen, setViewport, test, waitForCanvas } from '../tests/support/canvas.ts'
import { BIG_BOARD_ELEMENTS, median, seedBigBoard } from './support/big-board.ts'

const PERF = process.env.N1_PERF === '1'
/** the features' `canvas.items()` reads (recorded only) */
const isItemsSite = (site: string) => site.startsWith('items')
/** the engine's change detection: one walk per scene change each (see the header), bounded, not 0 */
const CHANGE_DETECTION: ReadonlySet<string> = new Set([
  'sync.fingerprint',
  'sync.scan',
  'sync.unseen',
  'sync.apply',
  'port.scan',
])
/**
 * At most this many walks per pointer move at each change-detection site: one per scene change (about one per move),
 * and for `sync.unseen` one more per inbound frame and Saved read (the acks and the server's re-snaps of the drag; 1.2 to
 * 1.6 per move measured at CPU 1x and 4x)
 */
const CHANGE_DETECTION_PER_MOVE = 2

interface DragRun {
  cpu: number
  moves: number
  frames: number
  ms: number
  fps: number
  frameP95: number
  walks: Record<string, number>
  perMove: Record<string, number>
}

/** One drag of `id` for about `ms`, with the walk counter reset after the press (the press's own hit test is not a move). */
async function drag(page: Page, id: string, ms: number, cpu: number): Promise<DragRun> {
  const c = await itemCenterOnScreen(page, id)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.mouse.move(c.x + 5, c.y + 5)
  await page.evaluate(() => {
    const w = window as unknown as {
      __lobbyWalks?: { reset(): void }
      __n1drag?: { moves: number; frames: number[]; stop: boolean }
    }
    w.__lobbyWalks?.reset()
    const st = { moves: 0, frames: [] as number[], stop: false }
    w.__n1drag = st
    window.addEventListener('pointermove', () => st.moves++, { capture: true })
    const tick = (t: number) => {
      if (st.stop) return
      st.frames.push(t)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const t0 = Date.now()
  let i = 0
  while (Date.now() - t0 < ms) {
    i++
    const a = (i / 30) * Math.PI
    await page.mouse.move(c.x + 5 + 160 * Math.sin(a), c.y + 5 + 90 * Math.sin(a * 1.5))
  }
  // back where the drag started (the next run finds the note in view)
  await page.mouse.move(c.x + 5, c.y + 5)
  const r = await page.evaluate(() => {
    const w = window as unknown as {
      __lobbyWalks?: { counts(): Record<string, number> }
      __n1drag: { moves: number; frames: number[]; stop: boolean }
    }
    w.__n1drag.stop = true
    const f = w.__n1drag.frames
    const d: number[] = []
    for (let k = 1; k < f.length; k++) d.push((f[k] as number) - (f[k - 1] as number))
    d.sort((x, y) => x - y)
    return {
      moves: w.__n1drag.moves,
      frames: f.length,
      ms: (f.at(-1) ?? 0) - (f[0] ?? 0),
      p95: d[Math.floor(d.length * 0.95)] ?? 0,
      walks: w.__lobbyWalks?.counts() ?? {},
    }
  })
  await page.mouse.up()
  const perMove = Object.fromEntries(
    Object.entries(r.walks).map(([k, v]) => [k, Math.round((v / Math.max(1, r.moves)) * 1000) / 1000]),
  )
  return {
    cpu,
    moves: r.moves,
    frames: r.frames,
    ms: Math.round(r.ms),
    fps: Math.round(((r.frames - 1) / Math.max(1, r.ms)) * 10_000) / 10,
    frameP95: Math.round(r.p95 * 10) / 10,
    walks: r.walks,
    perMove,
  }
}

test('N1-6: dragging a note on the 10k board: 0 walks per move from the overlays and passes, the change detection bounded; fps recorded', async ({
  canvasSession,
  board,
}, testInfo) => {
  test.setTimeout(900_000)
  const a = await canvasSession('alice')
  const seeded = await seedBigBoard(a.page, board)
  expect(seeded.elements).toBe(BIG_BOARD_ELEMENTS)
  await a.page.goto(`/b/${board}?nocache=1`)
  await waitForCanvas(a.page, 300_000)
  await a.page.waitForFunction(
    (n) => {
      const f = (
        window as unknown as { lobbyCanvas?: { items(): unknown[]; saveState(): { state: string } } }
      ).lobbyCanvas
      return !!f && f.items().length >= n && f.saveState().state === 'saved'
    },
    BIG_BOARD_ELEMENTS - 1,
    { timeout: 300_000, polling: 250 },
  )
  expect(
    await a.page.evaluate(() => typeof (window as unknown as { __lobbyWalks?: unknown }).__lobbyWalks),
    'the walk counter (dev-auth builds)',
  ).toBe('object')
  // zoom 1 on frame 0's first note (the board's densest part)
  const note = seeded.board.noteIds[0] as string
  const b = await a.page.evaluate(
    (id) =>
      (
        window as unknown as { lobbyCanvas: { bounds(id: string): { x: number; y: number } | null } }
      ).lobbyCanvas.bounds(id),
    note,
  )
  if (!b) throw new Error(`no note ${note}`)
  await setViewport(a.page, { zoom: 1, x: b.x - 300, y: b.y - 200 })
  await a.page.waitForTimeout(1_000)

  const runs: DragRun[] = []
  for (const cpu of [1, 4]) {
    const cdp = await a.context.newCDPSession(a.page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
    for (let rep = 0; rep < 3; rep++) {
      runs.push(await drag(a.page, note, 3_000, cpu))
      await a.page.waitForTimeout(800)
    }
    // N1_DRAG_PROFILE=1: one more drag at this rate under the V8 profiler (the top functions logged)
    if (process.env.N1_DRAG_PROFILE === '1') {
      await startProfile(cdp)
      const r = await drag(a.page, note, 3_000, cpu)
      const profile = await stopProfile(cdp, testInfo.outputPath(`drag-cpu${cpu}.cpuprofile`))
      logProfile(
        (l) => console.log(`[n1-profile] ${l}`),
        `cpu ${cpu}x`,
        summarizeProfile(profile, r.frames),
        30,
      )
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await cdp.detach()
  }
  // the walk table: per site, per move, every run
  const sites = [...new Set(runs.flatMap((r) => Object.keys(r.walks)))].sort()
  const table = sites.map((site) => ({ site, perMove: runs.map((r) => r.perMove[site] ?? 0) }))
  const desktop = median(runs.filter((r) => r.cpu === 1).map((r) => r.fps))
  const cpu4 = median(runs.filter((r) => r.cpu === 4).map((r) => r.fps))
  const evidence = {
    board: { elements: seeded.elements },
    desktopMedianFps: desktop,
    cpu4MedianFps: cpu4,
    table,
    runs,
  }
  // the evidence on disk (the output folder) and in the log, as navigation-lod-fps.spec.ts keeps its own
  writeFileSync(testInfo.outputPath('n1-drag-10k.json'), JSON.stringify(evidence, null, 2))
  console.log(`[n1] n1-drag-10k: ${JSON.stringify(evidence)}`)
  await testInfo.attach('n1-drag-10k.json', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  })
  testInfo.annotations.push({
    type: 'n1 drag 10k',
    description: JSON.stringify({ desktopMedianFps: desktop, cpu4MedianFps: cpu4, table }),
  })
  for (const r of runs) {
    expect(r.moves, 'the drag moved').toBeGreaterThan(5)
    const overlayWalks = Object.fromEntries(
      Object.entries(r.walks).filter(([site]) => !isItemsSite(site) && !CHANGE_DETECTION.has(site)),
    )
    expect(
      overlayWalks,
      `whole-scene walks from Lobby's overlays, passes and board page during the drag (${JSON.stringify(r.walks)})`,
    ).toEqual({})
    for (const site of CHANGE_DETECTION)
      expect(
        r.perMove[site] ?? 0,
        `${site}: walks per pointer move (one per scene change) at CPU ${r.cpu}x`,
      ).toBeLessThanOrEqual(CHANGE_DETECTION_PER_MOVE)
  }
  if (PERF) {
    expect(desktop, 'drag fps, median, CPU 1x').toBeGreaterThanOrEqual(50)
    expect(cpu4, 'drag fps, median, CPU 4x').toBeGreaterThanOrEqual(25)
  }
})
