// WRK-01 / PRF-04 latency: how long an edit made in one browser tab takes to show in another, over the
// local sync server (loopback), with the production client (useSync, tldraw's 30 fps send/apply
// schedule, React rendering, our overlays).
//
// The writer tab edits sticky notes through the editor API: a move, a text change or a colour change,
// one every 150–250 ms, after 40 unmeasured warm-up edits. Each edit stamps
// `meta.perfStamp = "pw-<writer>|<seq>|<epoch ms>"` (a single string, so every wire diff carries it
// whole). One clock: both tabs run on this machine, and times are performance.timeOrigin +
// performance.now() in each tab. Per edit, in the observer tab:
//   store   = the change reached the observer's store (store.listen, source 'remote')
//   visible = the first animation frame after that has run and a task after it (the change painted),
//             the review's "visible on the next frame" (docs/REVIEW-2026-09-27.md §2)
// and the split, from a WebSocket wrapper installed before the app loads (initScript below):
//   send    = writer edit → its push left the writer's socket (the writer's send schedule)
//   wire    = writer socket → observer socket (the server path, plus any wait for the observer's main
//             thread: the message event runs only when the tab is free)
//   apply   = observer socket → observer store (the observer's apply schedule)
//   render  = store → visible
// Both tabs keep a mouse cursor moving over the canvas (presence both ways, as in a real session).
// Optional `busy` load: a third tab drags other notes continuously (unstamped updates per second).
import type { BrowserContext, CDPSession, Page } from '@playwright/test'
import { logProfile, startProfile, stopProfile, summarizeProfile } from './fps.ts'
import { cpuMeter, type PerfEditor, round1, type Summary, summarize } from './lib.ts'

export type View = 'fit' | '100'

/**
 * Installed with context.addInitScript before the app loads: records when a stamped edit leaves this
 * tab's socket (send) and when one arrives on it (message), keyed "<writer>|<seq>".
 */
export function initScript() {
  const w = window as unknown as {
    WebSocket: typeof WebSocket
    __perfWs?: { sent: Map<string, number>; arrived: Map<string, number> }
  }
  if (w.__perfWs) return
  const sent = new Map<string, number>()
  const arrived = new Map<string, number>()
  w.__perfWs = { sent, arrived }
  const STAMP = /pw-([a-z0-9]+)\|(\d+)\|/g
  const now = () => performance.timeOrigin + performance.now()
  const scan = (data: unknown, into: Map<string, number>) => {
    if (typeof data !== 'string' || !data.includes('pw-')) return
    const t = now()
    for (const m of data.matchAll(STAMP)) {
      const key = `${m[1]}|${m[2]}`
      if (!into.has(key)) into.set(key, t)
    }
  }
  const Native = w.WebSocket
  class Instrumented extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      this.addEventListener('message', (e) => scan(e.data, arrived))
    }
    override send(data: Parameters<WebSocket['send']>[0]) {
      scan(data, sent)
      super.send(data)
    }
  }
  w.WebSocket = Instrumented
}

export async function instrument(context: BrowserContext) {
  await context.addInitScript(initScript)
}

/** Camera for both tabs: the whole board, or 100% on the first frame's notes. */
export async function setView(page: Page, view: View) {
  await page.evaluate((view) => {
    const ed = (window as unknown as { editor: PerfEditor }).editor
    ed.selectNone()
    if (view === 'fit') {
      ed.zoomToFit({ immediate: true })
      return
    }
    const b = ed.getShapePageBounds('shape:perf-f0')
    if (!b) throw new Error('no frame 0')
    // the top-left of frame 0's note grid at the top-left of the viewport, at 100%
    ed.setCamera({ x: 20 - (b.x + 20), y: 20 - (b.y + 40), z: 1 }, { immediate: true })
  }, view)
}

/** Notes the observer can see in the current view (edits to them must be painted). */
async function visibleNotes(page: Page, limit: number): Promise<string[]> {
  return page.evaluate((limit) => {
    const ed = (window as unknown as { editor: PerfEditor }).editor
    const vp = ed.getViewportPageBounds()
    const culled = ed.getCulledShapes()
    const inView = ed
      .getRenderingShapes()
      .filter((r) => r.shape.type === 'note' && !culled.has(r.id))
      .map((r) => r.id)
      .filter((id) => {
        const b = ed.getShapePageBounds(id)
        return !!b && b.x >= vp.x && b.y >= vp.y && b.x + b.w <= vp.x + vp.w && b.y + b.h <= vp.y + vp.h
      })
    // spread over the view, deterministic
    const step = Math.max(1, Math.floor(inView.length / limit))
    return inView.filter((_, i) => i % step === 0).slice(0, limit)
  }, limit)
}

function startObserver(page: Page, writer: string) {
  return page.evaluate((writer) => {
    const ed = (window as unknown as { editor: PerfEditor }).editor
    const w = window as unknown as {
      __perfObs?: { rows: { key: string; t0: number; store: number; visible: number }[]; stop: () => void }
    }
    w.__perfObs?.stop()
    const rows: { key: string; t0: number; store: number; visible: number }[] = []
    const seen = new Set<string>()
    let pending: { key: string; t0: number; store: number; visible: number }[] = []
    let scheduled = false
    const now = () => performance.timeOrigin + performance.now()
    const stop = ed.store.listen(
      (e) => {
        const t = now()
        const recs = [...Object.values(e.changes.added), ...Object.values(e.changes.updated).map((u) => u[1])]
        for (const r of recs) {
          const s = r.meta?.perfStamp
          if (typeof s !== 'string' || !s.startsWith(`pw-${writer}|`)) continue
          const [who, seq, at] = s.slice(3).split('|')
          const key = `${who}|${seq}`
          if (seen.has(key)) continue
          seen.add(key)
          const row = { key, t0: Number(at), store: t, visible: 0 }
          rows.push(row)
          pending.push(row)
        }
        if (pending.length && !scheduled) {
          scheduled = true
          requestAnimationFrame(() =>
            setTimeout(() => {
              const v = now()
              for (const row of pending) row.visible = v
              pending = []
              scheduled = false
            }, 0),
          )
        }
      },
      { source: 'remote', scope: 'document' },
    )
    w.__perfObs = { rows, stop }
  }, writer)
}

function runWriter(page: Page, writer: string, targets: string[], edits: number, seed: number) {
  return page.evaluate(
    async ({ writer, targets, edits, seed }) => {
      const ed = (window as unknown as { editor: PerfEditor }).editor
      let s = seed
      const rand = () => {
        s = (s * 16807) % 2147483647
        return s / 2147483647
      }
      const COLORS = ['yellow', 'light-blue', 'light-green', 'orange', 'light-violet']
      const nudged = new Set<string>()
      const WORDS = ['crop', 'warm', 'hero', 'logo', 'teal', 'grain', 'tight', 'fade']
      const text = (t: string) => ({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
      })
      for (let i = 1; i <= edits; i++) {
        await new Promise((r) => setTimeout(r, 150 + rand() * 100))
        const id = targets[Math.floor(rand() * targets.length)]
        const cur = id ? ed.getShape(id) : undefined
        if (!id || !cur) continue
        const perfStamp = `pw-${writer}|${i}|${performance.timeOrigin + performance.now()}`
        const meta = { ...cur.meta, perfStamp }
        const kind = i % 4
        if (kind === 0 || kind === 1) {
          // a small nudge, right then back for each note (the board stays put across runs)
          const out = !nudged.has(id)
          if (out) nudged.add(id)
          else nudged.delete(id)
          ed.updateShape({ id, type: 'note', x: cur.x + (out ? 6 : -6), meta })
        } else if (kind === 2) {
          ed.updateShape({
            id,
            type: 'note',
            props: {
              richText: text(`Edit ${i}: ${WORDS[i % WORDS.length]} ${WORDS[(i * 3) % WORDS.length]}`),
            },
            meta,
          })
        } else {
          ed.updateShape({ id, type: 'note', props: { color: COLORS[i % COLORS.length] }, meta })
        }
      }
      // notes still nudged out: moved back by restoreNudged, after the measurement
      return [...nudged]
    },
    { writer, targets, edits, seed },
  )
}

/** Moves the notes a run left nudged out back, in one batch (unstamped, outside the measurement). */
const restoreNudged = (page: Page, ids: string[]) =>
  page.evaluate((ids) => {
    const ed = (window as unknown as { editor: PerfEditor }).editor
    ed.run(() => {
      for (const id of ids) {
        const cur = ed.getShape(id)
        if (cur) ed.updateShape({ id, type: 'note', x: cur.x - 6 })
      }
    })
  }, ids)

/** Moves the mouse in a slow circle over the canvas until stopped (cursor presence, ~10 Hz). */
function wiggle(page: Page, cx: number, cy: number) {
  let stopped = false
  const done = (async () => {
    let a = 0
    while (!stopped) {
      a += 0.35
      await page.mouse.move(cx + Math.cos(a) * 120, cy + Math.sin(a) * 80).catch(() => {})
      await new Promise((r) => setTimeout(r, 100))
    }
  })()
  return async () => {
    stopped = true
    await done
  }
}

/** `busy` unstamped note updates per second from another tab (a lively workshop), until stopped. */
function busyLoad(page: Page, targets: string[], perSecond: number) {
  return page.evaluate(
    ({ targets, perSecond }) => {
      const ed = (window as unknown as { editor: PerfEditor }).editor
      const w = window as unknown as { __perfBusy?: { stop: boolean; n: number } }
      const state = { stop: false, n: 0 }
      w.__perfBusy = state
      let last = performance.now()
      let debt = 0
      let i = 0
      const tick = (t: number) => {
        if (state.stop) return
        debt += ((t - last) / 1000) * perSecond
        last = t
        const batch = Math.floor(debt)
        debt -= batch
        for (let k = 0; k < batch; k++, i++) {
          const id = targets[i % targets.length]
          const cur = id ? ed.getShape(id) : undefined
          if (!cur) continue
          ed.updateShape({ id, type: 'note', x: cur.x + (Math.floor(i / targets.length) % 2 ? -4 : 4) })
          state.n++
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    { targets, perSecond },
  )
}

export interface LatencyResult {
  view: View
  edits: number
  seen: number
  busyPerSecond: number
  /** edit → painted in the observer tab (the WRK-01 number) */
  visible: Summary
  /** edit → observer store */
  store: Summary
  split: { send: Summary; wire: Summary; apply: Summary; render: Summary }
  /** frames per second the observer tab rendered during the run */
  observerFps: number
  writerFps: number
  /** main-thread tasks over 50 ms in each tab during the run */
  longTasks: { observer: { count: number; longestMs: number }; writer: { count: number; longestMs: number } }
  /** whole-machine CPU busy % during the edits (this PC is shared) */
  machineBusyPct: number
}

export async function measureLatency(opts: {
  writerPage: Page
  observerPage: Page
  writerName: string
  view: View
  edits: number
  /** Unmeasured edits first (default 40). */
  warmup?: number
  busyPage?: Page
  busyPerSecond?: number
  /** CPU-profile both tabs during the edits and log the top functions (hot spots). */
  profile?: { writer: CDPSession; observer: CDPSession }
  /** Where to save the raw CPU profiles (DevTools .cpuprofile), per tab. */
  profileOut?: (tab: 'writer' | 'observer') => string
  log: (s: string) => void
}): Promise<LatencyResult> {
  const { writerPage, observerPage, view, edits } = opts
  // a stamp id per run: keys must not repeat across runs (the board keeps the last run's stamps)
  const writerName = `${opts.writerName}${view}${Date.now().toString(36)}`
  await setView(writerPage, view)
  await setView(observerPage, view)
  if (opts.busyPage) await setView(opts.busyPage, view)
  await observerPage.waitForTimeout(1500)
  const targets = await visibleNotes(observerPage, 60)
  if (targets.length < 10) throw new Error(`only ${targets.length} notes in the observer's view`)
  // Unmeasured warm-up edits: freshly opened tabs are still decoding images and compiling code, and the
  // first edits after opening read slower than the rest (seen as a p95 up to ~60 ms higher at fit).
  if (opts.warmup !== 0) {
    await restoreNudged(
      writerPage,
      await runWriter(writerPage, `${writerName}w`, targets, opts.warmup ?? 40, 5),
    )
    await writerPage.waitForTimeout(1000)
  }
  await startObserver(observerPage, writerName)
  // frames rendered and long tasks (main-thread stalls over 50 ms) per tab during the run
  const fpsCounter = (page: Page) =>
    page.evaluate(() => {
      const st = {
        frames: 0,
        since: performance.now(),
        stop: false,
        long: [] as number[],
        obs: null as unknown,
      }
      ;(window as unknown as { __perfFps?: typeof st }).__perfFps = st
      const f = () => {
        if (st.stop) return
        st.frames++
        requestAnimationFrame(f)
      }
      requestAnimationFrame(f)
      try {
        const obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) st.long.push(e.duration)
        })
        obs.observe({ type: 'longtask' })
        st.obs = obs
      } catch {}
    })
  const readFps = (page: Page) =>
    page.evaluate(() => {
      const st = (
        window as unknown as {
          __perfFps?: { frames: number; since: number; stop: boolean; long: number[]; obs: unknown }
        }
      ).__perfFps
      if (!st) return { fps: 0, longTasks: 0, longestTaskMs: 0 }
      st.stop = true
      ;(st.obs as PerformanceObserver | null)?.disconnect()
      return {
        fps: st.frames / ((performance.now() - st.since) / 1000),
        longTasks: st.long.length,
        longestTaskMs: Math.round(Math.max(0, ...st.long)),
      }
    })
  await fpsCounter(observerPage)
  await fpsCounter(writerPage)
  const stopWiggles = [wiggle(writerPage, 700, 420), wiggle(observerPage, 800, 460)]
  const busyTargets = opts.busyPage ? await visibleNotes(opts.busyPage, 200) : []
  const busy = opts.busyPage && opts.busyPerSecond ? opts.busyPerSecond : 0
  if (opts.busyPage && busy) {
    // the busy tab never touches the writer's targets
    const free = busyTargets.filter((id) => !targets.includes(id))
    await busyLoad(opts.busyPage, free.length ? free : busyTargets, busy)
  }
  const t0 = Date.now()
  const machine = cpuMeter()
  const profiled = opts.profile
    ? ([
        ['writer', opts.profile.writer, writerPage],
        ['observer', opts.profile.observer, observerPage],
      ] as const)
    : []
  for (const [, cdp] of profiled) await startProfile(cdp)
  const nudged = await runWriter(writerPage, writerName, targets, edits, view === 'fit' ? 11 : 23)
  await writerPage.waitForTimeout(2000)
  const machineBusyPct = machine()
  for (const [name, cdp, page] of profiled) {
    const profile = await stopProfile(cdp, opts.profileOut?.(name))
    const frameCount = await page.evaluate(
      () => (window as unknown as { __perfFps?: { frames: number } }).__perfFps?.frames ?? 1,
    )
    logProfile(opts.log, `${name} profile (${view})`, summarizeProfile(profile, frameCount))
  }
  if (opts.busyPage && busy)
    await opts.busyPage.evaluate(() => {
      const b = (window as unknown as { __perfBusy?: { stop: boolean } }).__perfBusy
      if (b) b.stop = true
    })
  for (const stop of stopWiggles) await stop()
  const observerTab = await readFps(observerPage)
  const writerTab = await readFps(writerPage)
  const rows = await observerPage.evaluate(() => {
    const w = window as unknown as {
      __perfObs?: { rows: { key: string; t0: number; store: number; visible: number }[]; stop: () => void }
      __perfWs?: { arrived: Map<string, number> }
    }
    w.__perfObs?.stop()
    return (w.__perfObs?.rows ?? []).map((r) => ({ ...r, arrived: w.__perfWs?.arrived.get(r.key) ?? 0 }))
  })
  const sent = new Map(
    await writerPage.evaluate(() => [
      ...((window as unknown as { __perfWs?: { sent: Map<string, number> } }).__perfWs?.sent ?? []),
    ]),
  )
  const visible = rows.filter((r) => r.visible > 0).map((r) => r.visible - r.t0)
  const store = rows.map((r) => r.store - r.t0)
  const split = {
    send: [] as number[],
    wire: [] as number[],
    apply: [] as number[],
    render: rows.filter((r) => r.visible > 0).map((r) => r.visible - r.store),
  }
  for (const r of rows) {
    const s = sent.get(r.key)
    if (s !== undefined) split.send.push(s - r.t0)
    if (s !== undefined && r.arrived) split.wire.push(r.arrived - s)
    if (r.arrived) split.apply.push(r.store - r.arrived)
  }
  const result: LatencyResult = {
    view,
    edits,
    seen: rows.length,
    busyPerSecond: busy,
    visible: summarize(visible),
    store: summarize(store),
    split: {
      send: summarize(split.send),
      wire: summarize(split.wire),
      apply: summarize(split.apply),
      render: summarize(split.render),
    },
    observerFps: round1(observerTab.fps),
    writerFps: round1(writerTab.fps),
    longTasks: {
      observer: { count: observerTab.longTasks, longestMs: observerTab.longestTaskMs },
      writer: { count: writerTab.longTasks, longestMs: writerTab.longestTaskMs },
    },
    machineBusyPct,
  }
  opts.log(
    `latency ${view}${busy ? ` busy ${busy}/s` : ''}: ${rows.length}/${edits} edits seen in ${Math.round((Date.now() - t0) / 1000)} s; ` +
      `visible p50 ${result.visible.p50} p95 ${result.visible.p95} p99 ${result.visible.p99} ms; ` +
      `store p95 ${result.store.p95}; split p95 send ${result.split.send.p95} wire ${result.split.wire.p95} ` +
      `apply ${result.split.apply.p95} render ${result.split.render.p95}; fps observer ${result.observerFps} writer ${result.writerFps}; ` +
      `long tasks observer ${observerTab.longTasks} (max ${observerTab.longestTaskMs} ms) writer ${writerTab.longTasks} (max ${writerTab.longestTaskMs} ms); machine ${machineBusyPct}% busy`,
  )
  await restoreNudged(writerPage, nudged)
  return result
}
