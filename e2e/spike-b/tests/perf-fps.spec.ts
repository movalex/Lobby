// §8.4 "Render": pan fps of the heavy board at Lobby's whole-board fit, at 0.25 and at 1 WITH SYNC
// RUNNING (the board opened through the real stack, the page's socket live), idle and with a remote
// writer moving a note in view at 5 Hz; and a 100-note drag preview relayed from a peer (a raw socket's
// presence `drag`: ids once, then deltas at 20 Hz). Same method as spike A14 (perf-kit.ts measureView:
// the pointer at rest, 3 scripted pans of 3 s per view, a 600 px sine, plus one traced pan), camera moved
// through CanvasPort's viewport (O3's facade side channel). §8.5 gates: ≥ 30 fps at 0.25 and at 1 with sync
// running; the fit number feeds the level-of-detail decision (24 fps at Lobby's fit).
//
// Opt-in, timing-gated: SPIKE_PERF=1, SPIKE_B_PORT_BASE=7885, the quiet window; 3 runs. Needs M2 (presence
// drag relay) for the drag row; the pan rows need M1.
import { type Browser, expect, type Page, test } from '@playwright/test'
import { DPR, GPU_ARGS, gpuInfo, measureView, repStats, VIEWPORT } from '../../spike/fixtures/perf-kit.ts'
import type { O3BrowserProcess } from '../support/browsers.ts'
import { writeEvidence } from '../support/checks.ts'
import { forgeSession } from '../support/forge.ts'
import { harness } from '../support/harness.ts'
import { installCamera, remoteWriter, setView, type View } from '../support/perf.ts'
import { type SeededBoard, seedHeavy } from '../support/seed.ts'
import type { O3Stack } from '../support/stack.ts'
import type { DevUser } from '../support/types.ts'

test.skip(
  !process.env.SPIKE_PERF,
  'set SPIKE_PERF=1 (quiet window, SPIKE_B_PORT_BASE=7885) for the §8.4 numbers',
)
test.setTimeout(60 * 60_000)

let stack: O3Stack
let owner: DevUser
let M: O3BrowserProcess
let heavy: SeededBoard
let peer: O3BrowserProcess

test.beforeAll(async () => {
  stack = await harness.startStack()
  owner = harness.devUser('Perf')
  const peerUser = harness.devUser('Peer')
  heavy = await seedHeavy(stack, owner, {
    members: [{ user: peerUser, role: 'editor' }],
    log: (s) => console.log(`[perf-fps] ${s}`),
  })
  M = await harness.launchBrowser(stack, owner, {
    name: 'M',
    relay: false,
    args: [...GPU_ARGS],
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
  })
  peer = await harness.launchBrowser(stack, peerUser, { name: 'Peer', relay: false })
})
test.afterAll(async () => {
  await M?.close()
  await peer?.close()
  await stack?.stop()
})

/** rAF timestamps in the page for `ms` (the drag preview's frame rate, as A14's dragPreview measured it). */
const frameTimes = (page: Page, ms: number) =>
  page.evaluate(
    (ms) =>
      new Promise<number[]>((resolve) => {
        const out: number[] = []
        let t0: number | null = null
        const step = (t: number) => {
          t0 ??= t
          out.push(t)
          if (t - t0 > ms) return resolve(out)
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }),
    ms,
  )

test('§8.4: pan fps at fit / 0.25 / 1 with sync running (idle, and with a remote writer), and a 100-note drag preview', async () => {
  const testInfo = test.info()
  await M.openBoard(heavy.boardId)
  const page = M.page
  const gpu = await gpuInfo(M.browser as Browser, page)
  const cdp = await M.context.newCDPSession(page)
  await installCamera(page)
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2)
  await page.waitForTimeout(3_000)
  const f0 = heavy.board.elements.find((e) => e.id === heavy.board.frameIds[0]) as {
    x: number
    y: number
    width: number
    height: number
  }
  const inView = heavy.board.frame0Notes[1] as string
  const rows = []
  for (const writer of [false, true]) {
    const w = writer ? await remoteWriter(stack, owner, heavy.boardId, inView, 5) : null
    for (const view of ['fit', '0.25', '1'] as View[]) {
      const cam = await setView(page, view, f0)
      await page.waitForTimeout(2_500)
      const r = await measureView(page, cdp, view, cam.zoom)
      rows.push({ writer, ...r, visible: cam.visible, total: cam.total })
      console.log(
        `[perf-fps] ${writer ? 'writer' : 'idle'} ${view} (zoom ${cam.zoom.toFixed(3)}, ${cam.visible}/${cam.total} in view): ${r.reps.map((x) => x.fps).join(' / ')} (median ${r.medianFps}; trace ${r.trace?.traceFps} fps drawn; machine ${r.machineBusyPct}% busy)`,
      )
    }
    const ws = await w?.stop()
    if (ws) rows.push({ writer: true, writerPushes: ws.pushes, writerAcked: ws.acked })
  }
  // the drag preview: the peer's own session relays a drag of frame 0's first 100 notes; M watches at zoom 1
  await setView(page, '1', f0)
  await page.waitForTimeout(1_500)
  await peer.openBoard(heavy.boardId)
  const { socket } = await forgeSession(peer.page, heavy.boardId)
  const ids = heavy.board.frame0Notes.slice(0, 100)
  const drag = []
  for (let rep = 0; rep < 3; rep++) {
    const d = 100 + rep
    const frames = frameTimes(page, 3_000)
    const t0 = Date.now()
    let first = true
    while (Date.now() - t0 < 3_000) {
      const e = (Date.now() - t0) / 1000
      const dx = Math.round(120 * Math.sin(e * 2) * 10) / 10
      const dy = Math.round(60 * Math.sin(e * 3) * 10) / 10
      await socket.send({
        type: 'presence',
        pointer: { x: f0.x + 400 + dx, y: f0.y + 300 + dy },
        button: 'down',
        sel: first ? ids : { count: ids.length },
        view: null,
        idle: false,
        editing: null,
        drag: first ? { d, ids, dx, dy } : { d, dx, dy },
      })
      first = false
      await new Promise((r) => setTimeout(r, 50))
    }
    await socket.send({
      type: 'presence',
      pointer: null,
      button: 'up',
      sel: [],
      view: null,
      idle: true,
      editing: null,
      drag: null,
    })
    drag.push(repStats(await frames))
    await page.waitForTimeout(500)
  }
  await socket.close()
  const measures = await page.evaluate(() => window.__lobbyHarness?.measures(true) ?? [])
  writeEvidence(testInfo, 'perf-fps', {
    gpu,
    viewport: `${VIEWPORT.width}x${VIEWPORT.height} @${DPR}`,
    elements: heavy.board.elements.length,
    rows,
    dragPreview: drag,
    lobbyMeasures: measures.length ? measures.slice(0, 200) : 'none (O2 emits no lobby.* measures)',
  })
  expect(rows.length).toBeGreaterThan(0)
})
