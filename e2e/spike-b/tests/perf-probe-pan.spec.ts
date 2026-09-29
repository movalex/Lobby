// O3's probe (not a §8.4 number; opt-in SPIKE_B_PROBES=1): why the spike board pans at about 6 fps in the
// perf-fps smoke run where spike A measured 53.7 / 60 fps on the same machine. The same board (4,500
// notes with labels in 20 frames, no images, seeded through the protocol), the same GPU shell, viewport
// and DPR as perf-kit, zoom 1 on frame 0; the page's rAF rate over 3 s of a scripted pan with each camera
// method, and idle:
//  - idle: no pan;
//  - port: CanvasPort.viewport.set({x, y}) (what perf-fps's camera hooks call), which passes appState
//    scrollX, scrollY AND a new zoom object to updateScene;
//  - scroll: api.updateScene({appState: {scrollX, scrollY}}) (spike A14's pan method);
//  - scroll+zoom: api.updateScene with scrollX, scrollY and zoom {value: current} (the zoom object alone);
//  - writer: no pan, while a remote writer (its own session) moves a note at 18 Hz, about L2's rate of
//    remote `changes` frames (B9's case).
// The 'scroll' and 'writer' phases are CPU-profiled: self time by script and by function.
// Also counted per method: the engine core's scans (lobby.onChange) and how long they took.
// SPIKE_B_PROBE_BOARD=heavy uses perf-fps's heavy board instead (the same notes and frames plus 200 real
// uploaded images with previews): the difference between the two boards is the images.
import { expect, test } from '@playwright/test'
import { DPR, GPU_ARGS, VIEWPORT } from '../../spike/fixtures/perf-kit.ts'
import type { O3BrowserProcess } from '../support/browsers.ts'
import { writeEvidence } from '../support/checks.ts'
import { canvasOf, closeAllBrowsers, harness } from '../support/harness.ts'
import { remoteWriter } from '../support/perf.ts'
import { seedHeavy, seedNotes } from '../support/seed.ts'
import type { O3Stack } from '../support/stack.ts'

test.skip(!process.env.SPIKE_B_PROBES, 'set SPIKE_B_PROBES=1 to run O3 probes')
test.setTimeout(15 * 60_000)
test.use({ trace: 'off', screenshot: 'off' })

let stack: O3Stack
let M: O3BrowserProcess

test.beforeAll(async () => {
  stack = await harness.startStack()
})
test.afterAll(async () => {
  await closeAllBrowsers()
  await stack?.stop()
})

test('probe: rAF rate while panning the spike board, by camera method', async () => {
  const owner = harness.devUser('Pan')
  const heavy = process.env.SPIKE_B_PROBE_BOARD === 'heavy'
  const seeded = heavy
    ? await seedHeavy(stack, owner, { log: (s) => console.log(`[probe pan] ${s}`) })
    : await seedNotes(stack, owner, { notes: 4_500, frames: 20, title: 'O3 pan probe' })
  M = await harness.launchBrowser(stack, owner, {
    name: 'M',
    relay: false,
    args: [...GPU_ARGS],
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
  })
  await M.openBoard(seeded.boardId)
  const f0 = seeded.board.elements.find((e) => e.id === seeded.board.frameIds[0]) as { x: number; y: number }
  await canvasOf(M.page).setViewport({ x: f0.x - 20, y: f0.y - 20, zoom: 1 })
  await M.page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2)
  await M.page.waitForTimeout(2_000)
  const out: Record<string, { fps: number; frames: number; scans: number; scanMs: number }> = {}
  // a CPU profile of the 'scroll' pan: self time by script and by function (minified names, file:line)
  const cdp = await M.context.newCDPSession(M.page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
  const profile: Record<string, unknown> = {}
  const profiled = (m: string) => m === 'scroll' || m === 'writer'
  for (const method of ['idle', 'port', 'scroll', 'scroll+zoom', 'idle again', 'writer'] as const) {
    await canvasOf(M.page).measures(true)
    const w =
      method === 'writer'
        ? await remoteWriter(stack, owner, seeded.boardId, seeded.board.frame0Notes[1] as string, 18)
        : null
    if (profiled(method)) await cdp.send('Profiler.start')
    out[method] = await M.page.evaluate(async (method) => {
      // biome-ignore lint/suspicious/noExplicitAny: O2's debug handle and Excalidraw's api, probe only
      const b = (window as any).__lobbyBoard
      const api = b.api
      const port = b.port
      const s0 = api.getAppState()
      const o = { x: s0.scrollX, y: s0.scrollY, z: s0.zoom.value }
      const v0 = port.viewport.get()
      const frames: number[] = []
      await new Promise<void>((resolve) => {
        let t0: number | null = null
        const step = (t: number) => {
          t0 ??= t
          frames.push(t)
          const e = (t - t0) / 1000
          const dx = 300 * Math.sin(e * 2)
          const dy = 150 * Math.sin(e * 3)
          if (method === 'port') port.viewport.set({ x: v0.x - dx, y: v0.y - dy })
          else if (method === 'scroll')
            api.updateScene({ appState: { scrollX: o.x + dx / o.z, scrollY: o.y + dy / o.z } })
          else if (method === 'scroll+zoom')
            api.updateScene({
              appState: { scrollX: o.x + dx / o.z, scrollY: o.y + dy / o.z, zoom: { value: o.z } },
            })
          if (t - t0 > 3_000) return resolve()
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })
      api.updateScene({ appState: { scrollX: o.x, scrollY: o.y } })
      const scans = performance.getEntriesByName('lobby.onChange')
      const span = ((frames.at(-1) as number) - (frames[0] as number)) / 1000
      return {
        fps: Math.round(((frames.length - 1) / span) * 10) / 10,
        frames: frames.length,
        scans: scans.length,
        scanMs: Math.round(scans.reduce((a, m) => a + m.duration, 0)),
      }
    }, method)
    await w?.stop()
    if (profiled(method)) {
      const { profile: p } = (await cdp.send('Profiler.stop')) as {
        profile: {
          nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]
          samples: number[]
          timeDeltas: number[]
        }
      }
      const self = new Map<number, number>()
      p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0) / 1000))
      const byUrl = new Map<string, number>()
      const byFn = new Map<string, number>()
      for (const n of p.nodes) {
        const ms = self.get(n.id) ?? 0
        const url = n.callFrame.url.split('/').pop() || `(${n.callFrame.functionName || 'native'})`
        byUrl.set(url, (byUrl.get(url) ?? 0) + ms)
        const fn = `${n.callFrame.functionName || '(anonymous)'} ${url}:${n.callFrame.lineNumber + 1}`
        byFn.set(fn, (byFn.get(fn) ?? 0) + ms)
      }
      const top = (m: Map<string, number>, k: number) =>
        [...m]
          .sort((a, b) => b[1] - a[1])
          .slice(0, k)
          .map(([n, ms]) => `${n} ${Math.round(ms)} ms`)
      profile[method] = { byScript: top(byUrl, 10), byFunction: top(byFn, 25) }
      console.log(`[probe pan] profile of ${method}: ${JSON.stringify(profile[method], null, 1)}`)
    }
    console.log(`[probe pan] ${method}: ${JSON.stringify(out[method])}`)
    await M.page.waitForTimeout(1_000)
  }
  writeEvidence(test.info(), 'perf-probe-pan', {
    board: heavy ? 'heavy (200 images)' : 'notes only',
    elements: seeded.board.elements.length,
    out,
    profile,
  })
  expect(Object.keys(out)).toHaveLength(6)
})
