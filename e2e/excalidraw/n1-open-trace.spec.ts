// N1 (wave N.1, the speed work): a diagnosis, not a gate (N1_TRACE=1 runs it; skipped otherwise). The 10k board
// (./support/big-board.ts) opened under the perf specs' conditions (CPU 4x, Chrome's Fast 4G unless
// N1_PERF_NET=loopback), each open recorded through Playwright's CDP session:
//  - a V8 CPU profile from the navigation to editable (`<open>.cpuprofile`, Chrome DevTools opens it);
//  - the network: every request (path, start, end, bytes) and every WebSocket frame received (time, bytes);
//  - the page's long tasks and `lobby.*` marks (./support/big-board.ts `watchOpen`).
// Logged per open: the timeline, the network, and the top functions of each long task over 100 ms (self time of the
// profile's samples inside the task) and of the whole open. Run it on the readable build (`vite build --minify false`)
// for function names. N1_TRACE_OPENS=warm,cold picks the opens (default both: a warm open after one open that
// writes the device's copy, then a cold `?nocache=1` open); N1_TRACE_FLAGS='{"DIFF_APPLY":true}' sets speed parts.
//
//   N1_TRACE=1 E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n1-open-trace.spec.ts --project=chromium --workers=1
import { writeFileSync } from 'node:fs'
import type { CDPSession, Page } from '@playwright/test'
import type { CpuProfile } from '../perf/fps.ts'
import { installPanHooks, pan, startProfile, stopProfile } from '../perf/fps.ts'
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import {
  BIG_BOARD_ELEMENTS,
  chromeTrace,
  mainThreadSelf,
  readOpen,
  type SpeedFlags,
  seedBigBoard,
  speedFlags,
  watchOpen,
} from './support/big-board.ts'

test.skip(process.env.N1_TRACE !== '1', 'a diagnosis: N1_TRACE=1 runs it')
test.use({ trace: 'off', screenshot: 'off' })

interface NetRow {
  id: string
  url: string
  type: string
  start: number
  end: number | null
  bytes: number
}

/** The network of one navigation, in the page's clock (ms from the document request). */
function recordNetwork(cdp: CDPSession) {
  const rows = new Map<string, NetRow>()
  const frames: { t: number; bytes: number }[] = []
  let t0: number | null = null
  const rel = (ts: number) => (t0 === null ? 0 : Math.round((ts - t0) * 1000))
  const onSend = (e: { requestId: string; request: { url: string }; timestamp: number; type?: string }) => {
    if (t0 === null && e.type === 'Document') t0 = e.timestamp
    if (t0 === null) return
    rows.set(e.requestId, {
      id: e.requestId,
      url: e.request.url.replace(/^https?:\/\/[^/]+/, ''),
      type: e.type ?? '',
      start: rel(e.timestamp),
      end: null,
      bytes: 0,
    })
  }
  const onDone = (e: { requestId: string; timestamp: number; encodedDataLength: number }) => {
    const r = rows.get(e.requestId)
    if (!r) return
    r.end = rel(e.timestamp)
    r.bytes = e.encodedDataLength
  }
  const onWs = (e: { requestId: string; url: string }) => {
    if (t0 === null) return
    rows.set(e.requestId, {
      id: e.requestId,
      url: e.url.replace(/^wss?:\/\/[^/]+/, '').replace(/\?.*$/, '?…'),
      type: 'WebSocket',
      start: 0,
      end: null,
      bytes: 0,
    })
  }
  const onWsOpen = (e: { requestId: string; timestamp: number }) => {
    const r = rows.get(e.requestId)
    if (r) r.start = rel(e.timestamp)
  }
  const onFrame = (e: {
    requestId: string
    timestamp: number
    response: { opcode: number; payloadData: string }
  }) => {
    const n =
      e.response.opcode === 2
        ? Math.floor((e.response.payloadData.length * 3) / 4)
        : e.response.payloadData.length
    frames.push({ t: rel(e.timestamp), bytes: n })
  }
  cdp.on('Network.requestWillBeSent', onSend as never)
  cdp.on('Network.loadingFinished', onDone as never)
  cdp.on('Network.webSocketCreated', onWs as never)
  cdp.on('Network.webSocketWillSendHandshakeRequest', onWsOpen as never)
  cdp.on('Network.webSocketFrameReceived', onFrame as never)
  return {
    stop() {
      cdp.off('Network.requestWillBeSent', onSend as never)
      cdp.off('Network.loadingFinished', onDone as never)
      cdp.off('Network.webSocketCreated', onWs as never)
      cdp.off('Network.webSocketWillSendHandshakeRequest', onWsOpen as never)
      cdp.off('Network.webSocketFrameReceived', onFrame as never)
      return { rows: [...rows.values()].sort((a, b) => a.start - b.start), frames, t0 }
    },
  }
}

/** The profile's samples as (time ms from `t0` seconds, function key), for windows of the page's clock. */
function samplesOf(profile: CpuProfile & { startTime?: number }, t0: number | null) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const out: { t: number; fn: string; dt: number }[] = []
  let ts = profile.startTime ?? 0
  const deltas = profile.timeDeltas ?? []
  ;(profile.samples ?? []).forEach((id, i) => {
    ts += deltas[i] ?? 0
    const n = byId.get(id)
    if (!n) return
    const name = n.callFrame.functionName || '(anonymous)'
    if (name === '(idle)' || name === '(program)') return
    const file = n.callFrame.url.split('/').pop()?.split('?')[0] ?? ''
    out.push({
      t: t0 === null ? 0 : ts / 1000 - t0 * 1000,
      fn: file ? `${name} ${file}:${n.callFrame.lineNumber + 1}` : name,
      dt: (deltas[i + 1] ?? deltas[i] ?? 0) / 1000,
    })
  })
  return out
}

const top = (samples: { fn: string; dt: number }[], n: number) => {
  const m = new Map<string, number>()
  for (const s of samples) m.set(s.fn, (m.get(s.fn) ?? 0) + s.dt)
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([fn, ms]) => `${ms.toFixed(1).padStart(7)} ms  ${fn}`)
}

async function tracedOpen(
  page: Page,
  cdp: CDPSession,
  url: string,
  name: string,
  out: (f: string) => string,
) {
  const log = (s: string) => console.log(`[n1-trace] ${s}`)
  const net = recordNetwork(cdp)
  await startProfile(cdp)
  await page.goto(url)
  await waitForCanvas(page, 600_000)
  await page.waitForFunction(
    () => (window as unknown as { __n1?: { editable: number | null } }).__n1?.editable != null,
    undefined,
    { timeout: 600_000, polling: 250 },
  )
  const profile = (await stopProfile(cdp, out(`${name}.cpuprofile`))) as CpuProfile & { startTime?: number }
  const network = net.stop()
  const o = await readOpen(page)
  // the page's clock starts at its navigation; the network's at the document request (a few ms later)
  const navOffset = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    return n ? n.requestStart : 0
  })
  const samples = samplesOf(profile, network.t0).map((s) => ({ ...s, t: s.t + navOffset }))
  writeFileSync(out(`${name}-network.json`), JSON.stringify(network, null, 2))
  log(
    `== ${name}: elements ${o.elements}, first elements ${Math.round(o.firstElements ?? -1)}, editable ${Math.round(o.editable ?? -1)}`,
  )
  log(
    `marks ${Object.entries(o.marks)
      .map(([k, v]) => `${k.slice(6)}@${Math.round(v)}`)
      .join(' ')}`,
  )
  log(`long tasks ${o.longTasks.map((t) => `${Math.round(t.start)}+${Math.round(t.duration)}`).join(' ')}`)
  for (const r of network.rows)
    log(
      `net ${String(r.start + Math.round(navOffset)).padStart(6)} → ${String(r.end === null ? '' : r.end + Math.round(navOffset)).padStart(6)} ${String(r.bytes).padStart(9)} B ${r.type.padEnd(10)} ${r.url.slice(0, 110)}`,
    )
  const big = network.frames.filter((f) => f.bytes >= 2_000)
  log(
    `ws frames ${network.frames.length} (${network.frames.reduce((s, f) => s + f.bytes, 0)} B); over 2 kB: ${big.map((f) => `${f.t + Math.round(navOffset)}:${f.bytes}`).join(' ')}`,
  )
  for (const t of o.longTasks.filter((x) => x.duration >= 100)) {
    const inside = samples.filter((s) => s.t >= t.start && s.t <= t.start + t.duration)
    log(`-- task ${Math.round(t.start)}+${Math.round(t.duration)} (${inside.length} samples):`)
    for (const l of top(inside, 14)) log(`   ${l}`)
  }
  log(`-- the whole open, top self time:`)
  for (const l of top(samples, 40)) log(`   ${l}`)
  return o
}

/**
 * N1_TRACE_OPENS=…,pan: the 3 s scripted pan of navigation-lod-fps.spec.ts (perf/fps.ts `pan`) at Lobby's whole-board
 * fit (or N1_TRACE_PAN_ZOOM), CPU 4x, the level-of-detail pass as N1_TRACE_LOD says (size-on, size-off, off; default
 * the page's own), traced: the renderer main thread's self time per event name per frame, the DOM and layer counts,
 * and the CPU profile's top functions.
 */
async function tracedPan(page: Page, cdp: CDPSession, out: (f: string) => string) {
  const log = (s: string) => console.log(`[n1-trace] ${s}`)
  const lod = process.env.N1_TRACE_LOD
  const zoom = process.env.N1_TRACE_PAN_ZOOM
  await page.evaluate(
    ({ lod, zoom }) => {
      const w = window as unknown as {
        __lobbyLod?: { setEnabled(on: boolean): void; setSizeAware?(on: boolean): void }
        __lobbyBoard: {
          canvas: {
            select(ids: string[]): void
            items(): { x: number; y: number; width: number; height: number; isDeleted?: boolean }[]
            viewport: {
              get(): { x: number; y: number; width: number; height: number; zoom: number }
              set(v: { zoom?: number; x?: number; y?: number }): void
              zoomTo(r: object, o: object): void
            }
          }
        }
      }
      if (lod === 'off') w.__lobbyLod?.setEnabled(false)
      else if (lod === 'size-on' || lod === 'size-off') {
        w.__lobbyLod?.setEnabled(true)
        w.__lobbyLod?.setSizeAware?.(lod === 'size-on')
      }
      const c = w.__lobbyBoard.canvas
      c.select([])
      let x1 = Number.POSITIVE_INFINITY
      let y1 = Number.POSITIVE_INFINITY
      let x2 = Number.NEGATIVE_INFINITY
      let y2 = Number.NEGATIVE_INFINITY
      for (const e of c.items()) {
        if (e.isDeleted) continue
        x1 = Math.min(x1, e.x)
        y1 = Math.min(y1, e.y)
        x2 = Math.max(x2, e.x + e.width)
        y2 = Math.max(y2, e.y + e.height)
      }
      c.viewport.zoomTo({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, { maxZoom: 1 })
      if (zoom) {
        const v = c.viewport.get()
        const z = Number(zoom)
        c.viewport.set({ zoom: z, x: v.x + v.width / 2 - (v.width * v.zoom) / z / 2, y: v.y })
      }
    },
    { lod, zoom },
  )
  await installPanHooks(page)
  await page.waitForTimeout(3_000)
  await page.waitForFunction(
    () => {
      const s = (
        window as unknown as {
          __lobbyLod?: { state(): { active: boolean; pendingInView?: number; stale: number } }
        }
      ).__lobbyLod?.state()
      return !s?.active || (s.pendingInView ?? s.stale) === 0
    },
    undefined,
    { timeout: 180_000, polling: 250 },
  )
  await page.waitForTimeout(500)
  const dom = await page.evaluate(() => ({
    nodes: document.querySelectorAll('*').length,
    canvases: [...document.querySelectorAll('canvas')].map((c) => `${c.width}x${c.height}`).join(' '),
    lod: (window as unknown as { __lobbyLod?: { state(): unknown } }).__lobbyLod?.state() ?? null,
  }))
  log(`== pan: ${dom.nodes} DOM nodes; canvases ${dom.canvases}; lod ${JSON.stringify(dom.lod)}`)
  await cdp.send('LayerTree.enable')
  const layers = await new Promise<number>((resolve) => {
    const t = setTimeout(() => resolve(-1), 3_000)
    cdp.once('LayerTree.layerTreeDidChange', (e: { layers?: unknown[] }) => {
      clearTimeout(t)
      resolve(e.layers?.length ?? -1)
    })
    void page.evaluate(() => (window as unknown as { __panBy(dx: number, dy: number): void }).__panBy(1, 0))
  })
  await cdp.send('LayerTree.disable')
  log(`layers ${layers}`)
  let times: number[] = []
  const events = await chromeTrace(cdp, out('pan.trace.json'), async () => {
    times = await pan(page, 3_000, 600)
  })
  const fps =
    times.length > 1 ? ((times.length - 1) / ((times.at(-1) as number) - (times[0] as number))) * 1000 : 0
  const self = mainThreadSelf(events)
  const frames = Math.max(1, times.length - 1)
  log(`pan: ${fps.toFixed(1)} fps (${times.length} frames); main-thread self time per frame, ms:`)
  for (const [name, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25))
    log(`   ${(us / 1000 / frames).toFixed(2).padStart(8)}  ${name}`)
  await startProfile(cdp)
  const t2 = await pan(page, 3_000, 600)
  const profile = (await stopProfile(cdp, out('pan.cpuprofile'))) as CpuProfile & { startTime?: number }
  log(`-- pan profile (${t2.length} frames), top self time:`)
  for (const l of top(samplesOf(profile, null), 30)) log(`   ${l}`)
}

test('N1 trace: a warm and a cold open of the 10k board at CPU 4x, profiled', async ({
  canvasSession,
  board,
}, testInfo) => {
  test.setTimeout(1_800_000)
  const a = await canvasSession('alice')
  const seeded = await seedBigBoard(a.page, board)
  expect(seeded.elements).toBe(BIG_BOARD_ELEMENTS)
  await watchOpen(a.context)
  const flags = JSON.parse(process.env.N1_TRACE_FLAGS ?? '{}') as SpeedFlags
  await speedFlags(a.context, flags)
  const cdp = await a.context.newCDPSession(a.page)
  await cdp.send('Network.enable')
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  if ((process.env.N1_PERF_NET ?? 'fast4g') === 'fast4g')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 60,
      downloadThroughput: (9_000 * 1024) / 8,
      uploadThroughput: (1_500 * 1024) / 8,
    })
  const opens = (process.env.N1_TRACE_OPENS ?? 'warm,cold').split(',')
  const out = (f: string) => testInfo.outputPath(f)
  // one open writes this device's copy
  await a.page.goto(`/b/${board}`)
  await waitForCanvas(a.page, 600_000)
  await a.page.waitForFunction(
    () => (window as unknown as { __n1?: { editable: number | null } }).__n1?.editable != null,
    undefined,
    { timeout: 600_000, polling: 250 },
  )
  await a.page.evaluate(() =>
    (
      window as unknown as { __lobbyBoard: { session: { flushBoardCache(): Promise<boolean> } } }
    ).__lobbyBoard.session.flushBoardCache(),
  )
  for (const open of opens) {
    if (open === 'pan') {
      await tracedPan(a.page, cdp, out)
      continue
    }
    if (open === 'net') {
      // the network emulation's throughput for one large HTTP download (the page's largest script, not cached), to
      // compare with the reset snapshot's WebSocket frame under the same conditions
      const r = await a.page.evaluate(async () => {
        const big = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
          .filter((e) => e.initiatorType === 'script')
          .sort((x, y) => y.decodedBodySize - x.decodedBodySize)[0]
        if (!big) return null
        const t0 = performance.now()
        const res = await fetch(`${big.name}?n1=${Math.random()}`, { cache: 'no-store' })
        const bytes = (await res.arrayBuffer()).byteLength
        return {
          url: big.name.replace(/^https?:\/\/[^/]+/, ''),
          bytes,
          ms: Math.round(performance.now() - t0),
        }
      })
      console.log(
        `[n1-trace] net: ${JSON.stringify(r)}${r ? ` = ${Math.round(r.bytes / 1024 / (r.ms / 1000))} KiB/s` : ''}`,
      )
      continue
    }
    const o = await tracedOpen(
      a.page,
      cdp,
      open === 'cold' ? `/b/${board}?nocache=1` : `/b/${board}`,
      open,
      out,
    )
    expect(o.elements).toBeGreaterThanOrEqual(BIG_BOARD_ELEMENTS - 1)
    if (open === 'warm')
      await a.page.evaluate(() =>
        (
          window as unknown as { __lobbyBoard: { session: { flushBoardCache(): Promise<boolean> } } }
        ).__lobbyBoard.session.flushBoardCache(),
      )
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
})
