// WRK-01 / PRF-04 latency: how long an edit made in one browser tab takes to show in another, over the
// local sync server (loopback), with the production client (Lobby's board page on Excalidraw: the engine
// core's scan and push, the room, the observer's apply into the scene, Excalidraw's render, the overlays).
//
// The writer tab edits sticky notes through the board page's LobbyCanvas (`transact`, one undo step and one
// sync write each, as a feature's write): a move of the note with its label, or a recolour of the note, one
// every 150–250 ms, after 40 unmeasured warm-up edits. Text edits are not in the plan: on this engine a text
// change goes through the edit lease and the label's layout, which a scripted write would skip (B9 and the
// tldraw harness this replaces differ there). The edits are planned in Node and handed to both tabs: the
// targets round-robin over up to 60 notes in the observer's view (a note is edited again only after every
// other target, about 12 s later, so no two edits of one note are in flight together), and each edit's
// value is unique for its note (a move's x carries the edit number in its thousandths), so the observer
// matches the value it sees to one edit. One clock: both tabs run on this machine, and every time is
// `Date.now()` (the clock every process here shares). Per edit, in the observer tab:
//   store   = the board page's port reported the change and the note holds the edit's value (the `changed`
//             event the facade's paint watch uses: Excalidraw's scene has it)
//   visible = two animation frames after that (the change painted), the facade's `watch` and B9's measure
// and the split, from a WebSocket wrapper installed before the app loads (initScript below):
//   send    = writer edit → the first push naming the note left the writer's socket (the core's scan,
//             coalescing and push)
//   wire    = writer socket → the first `changes` frame naming the note arrived on the observer's socket
//             (the server path, plus any wait for the observer's main thread: the message event runs only
//             when the tab is free)
//   apply   = observer socket → observer port (the observer's apply into the scene)
//   render  = store → visible
// Both tabs keep a mouse cursor moving over the canvas (presence both ways, as in a real session).
// Optional `busy` load: a third tab moves other notes continuously (unmeasured updates per second).
import type { BrowserContext, CDPSession, Page } from '@playwright/test'
import { logProfile, startProfile, stopProfile, summarizeProfile } from './fps.ts'
import { cpuMeter, type PerfView, type PerfWindow, round1, type Summary, setView, summarize } from './lib.ts'

export type View = Extract<PerfView, 'fit' | '100'>

/**
 * Installed with context.addInitScript before the app loads: keeps the time and text of every board-socket
 * frame this tab sends with a `push` and receives with a `changes` (JSON text frames), for the split.
 */
export function initScript() {
  const w = window as unknown as {
    WebSocket: typeof WebSocket
    __perfWs?: { sent: { t: number; d: string }[]; arrived: { t: number; d: string }[] }
  }
  if (w.__perfWs) return
  const sent: { t: number; d: string }[] = []
  const arrived: { t: number; d: string }[] = []
  w.__perfWs = { sent, arrived }
  const typeOf = (d: string) => /^\{"type":"([a-z-]+)"/.exec(d)?.[1] ?? ''
  const Native = w.WebSocket
  class Instrumented extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      this.addEventListener('message', (e) => {
        if (typeof e.data === 'string' && typeOf(e.data) === 'changes')
          arrived.push({ t: Date.now(), d: e.data })
      })
    }
    override send(data: Parameters<WebSocket['send']>[0]) {
      if (typeof data === 'string' && typeOf(data) === 'push') sent.push({ t: Date.now(), d: data })
      super.send(data)
    }
  }
  w.WebSocket = Instrumented
}

export async function instrument(context: BrowserContext) {
  await context.addInitScript(initScript)
}

/** A note the writer edits: its label moves with it; its first position is restored after the run. */
interface Target {
  id: string
  label: string | null
  x: number
  labelX: number
  backgroundColor: string
}

/** One planned edit: the note, the field the observer checks and the value it must reach. */
export interface PlannedEdit {
  seq: number
  id: string
  delayMs: number
  kind: 'move' | 'recolour'
  /** the note's patch (and the label's x for a move) */
  patch: Record<string, unknown>
  label: { id: string; x: number } | null
  field: 'x' | 'backgroundColor'
  value: number | string
}

/** Notes fully in the observer's view (edits to them must be painted), spread over it, deterministic. */
async function visibleNotes(page: Page, limit: number): Promise<Target[]> {
  return page.evaluate((limit) => {
    const w = window as unknown as PerfWindow
    const c = w.__lobbyBoard?.canvas
    if (!c) throw new Error('no window.__lobbyBoard')
    const vp = c.viewport.get()
    const all = c.items()
    const byId = new Map(all.map((e) => [e.id, e]))
    const inView = all.filter(
      (e) =>
        e.type === 'stickynote' &&
        !e.isDeleted &&
        !c.isHidden(e.id) &&
        e.x >= vp.x &&
        e.y >= vp.y &&
        e.x + e.width <= vp.x + vp.width &&
        e.y + e.height <= vp.y + vp.height,
    )
    const step = Math.max(1, Math.floor(inView.length / limit))
    return inView
      .filter((_, i) => i % step === 0)
      .slice(0, limit)
      .map((e) => {
        const labelId = e.boundElements?.find((b) => b.type === 'text')?.id ?? null
        const label = labelId ? byId.get(labelId) : undefined
        return {
          id: e.id,
          label: label ? label.id : null,
          x: e.x,
          labelX: label?.x ?? 0,
          backgroundColor: e.backgroundColor ?? '',
        }
      })
  }, limit)
}

const COLOURS = ['#ffdf6b', '#9fd4ff', '#b8e994', '#d7b8ff', '#ffb870']

/** The edits, deterministic for `seed`: round-robin over `targets`, half moves (out, then back), half recolours. */
export function planEdits(targets: readonly Target[], edits: number, seed: number, from = 1): PlannedEdit[] {
  let s = seed
  const rand = () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
  const state = new Map(targets.map((t) => [t.id, { out: false, colour: t.backgroundColor }]))
  const out: PlannedEdit[] = []
  const n = targets.length
  for (let k = 0; k < edits; k++) {
    const seq = from + k
    const t = targets[k % n] as Target
    const st = state.get(t.id) as { out: boolean; colour: string }
    const delayMs = Math.round(150 + rand() * 100)
    // the kind turns over every round, so each note gets moves and recolours
    const kind = (k + Math.floor(k / n)) % 4 < 2 ? 'move' : 'recolour'
    if (kind === 'move') {
      st.out = !st.out
      // an x of its own per edit: the edit number in the hundredths (the server keeps 2 decimals), never 0
      const dx = (st.out ? 6 : 0) + ((seq % 99) + 1) / 100
      const x = Math.round((t.x + dx) * 100) / 100
      out.push({
        seq,
        id: t.id,
        delayMs,
        kind,
        patch: { x },
        label: t.label ? { id: t.label, x: Math.round((t.labelX + dx) * 100) / 100 } : null,
        field: 'x',
        value: x,
      })
    } else {
      // never the note's current colour (1 to 3 places on in the palette), so the edit always changes it
      const colour = COLOURS[
        (Math.max(0, COLOURS.indexOf(st.colour)) + 1 + (seq % 3)) % COLOURS.length
      ] as string
      st.colour = colour
      out.push({
        seq,
        id: t.id,
        delayMs,
        kind,
        patch: { backgroundColor: colour },
        label: null,
        field: 'backgroundColor',
        value: colour,
      })
    }
  }
  return out
}

/** Arms the observer: for each planned edit, the time its value reached the port and two frames later. */
function startObserver(page: Page, plan: readonly PlannedEdit[]) {
  return page.evaluate((plan) => {
    const w = window as unknown as PerfWindow & {
      __perfObs?: { rows: { seq: number; store: number; visible: number }[]; stop: () => void }
    }
    w.__perfObs?.stop()
    const board = w.__lobbyBoard
    const f = w.lobbyCanvas
    if (!board || !f) throw new Error('no board page')
    const queues = new Map<string, { seq: number; field: string; value: unknown }[]>()
    for (const e of plan) {
      const q = queues.get(e.id) ?? []
      q.push({ seq: e.seq, field: e.field, value: e.value })
      queues.set(e.id, q)
    }
    const rows: { seq: number; store: number; visible: number }[] = []
    const off = board.port.on('changed', (ids) => {
      const t = Date.now()
      const hit: { seq: number; store: number; visible: number }[] = []
      for (const id of ids) {
        const q = queues.get(id)
        if (!q?.length) continue
        const el = f.get(id) as Record<string, unknown> | null
        if (!el) continue
        const same = (a: unknown, b: unknown) =>
          typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 0.004 : a === b
        const k = q.findIndex((x) => same(el[x.field], x.value))
        if (k < 0) continue
        const [entry] = q.splice(0, k + 1).slice(-1)
        if (entry) hit.push({ seq: entry.seq, store: t, visible: 0 })
      }
      if (!hit.length) return
      rows.push(...hit)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const v = Date.now()
          for (const r of hit) r.visible = v
        }),
      )
    })
    w.__perfObs = { rows, stop: off }
  }, plan)
}

/** Runs the plan in the writer tab; returns each edit's send time (`Date.now()` before its transact). */
function runWriter(page: Page, plan: readonly PlannedEdit[]) {
  return page.evaluate(async (plan) => {
    const c = (window as unknown as PerfWindow).__lobbyBoard?.canvas
    if (!c) throw new Error('no window.__lobbyBoard')
    const sentAt: [number, number][] = []
    for (const e of plan) {
      await new Promise((r) => setTimeout(r, e.delayMs))
      const t = Date.now()
      c.transact(`perf.${e.kind}`, (tx) => {
        tx.update(e.id, e.patch)
        if (e.label) tx.update(e.label.id, { x: e.label.x })
      })
      sentAt.push([e.seq, t])
    }
    return sentAt
  }, plan)
}

/** Puts every target (and its label) back where it was, in one write, outside the measurement. */
const restore = (page: Page, targets: readonly Target[]) =>
  page.evaluate((targets) => {
    const c = (window as unknown as PerfWindow).__lobbyBoard?.canvas
    c?.transact('perf.restore', (tx) => {
      for (const t of targets) {
        tx.update(t.id, { x: t.x })
        if (t.label) tx.update(t.label, { x: t.labelX })
      }
    })
  }, targets)

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

/** `perSecond` unmeasured note moves per second from another tab (a lively workshop), until stopped. */
function busyLoad(page: Page, targets: readonly Target[], perSecond: number) {
  return page.evaluate(
    ({ targets, perSecond }) => {
      const c = (window as unknown as PerfWindow).__lobbyBoard?.canvas
      if (!c) throw new Error('no window.__lobbyBoard')
      const w = window as unknown as { __perfBusy?: { stop: boolean; n: number } }
      const state = { stop: false, n: 0 }
      w.__perfBusy = state
      let last = performance.now()
      let debt = 0
      let i = 0
      const tick = (t: number) => {
        if (state.stop) {
          c.transact('perf.busy.restore', (tx) => {
            for (const b of targets) {
              tx.update(b.id, { x: b.x })
              if (b.label) tx.update(b.label, { x: b.labelX })
            }
          })
          return
        }
        debt += ((t - last) / 1000) * perSecond
        last = t
        const batch = Math.floor(debt)
        debt -= batch
        for (let k = 0; k < batch; k++, i++) {
          const b = targets[i % targets.length]
          if (!b) continue
          const dx = Math.floor(i / targets.length) % 2 ? 0 : 4
          c.transact('perf.busy', (tx) => {
            tx.update(b.id, { x: b.x + dx })
            if (b.label) tx.update(b.label, { x: b.labelX + dx })
          })
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
  zoom: number
  edits: number
  seen: number
  /** edits by kind */
  kinds: Record<string, number>
  busyPerSecond: number
  /** edit → painted in the observer tab (the WRK-01 number) */
  visible: Summary
  /** edit → observer port */
  store: Summary
  split: { send: Summary; wire: Summary; apply: Summary; render: Summary }
  /** frames per second the observer tab rendered during the run */
  observerFps: number
  writerFps: number
  /** main-thread tasks over 50 ms in each tab during the run */
  longTasks: { observer: { count: number; longestMs: number }; writer: { count: number; longestMs: number } }
  /** whole-machine CPU busy % during the edits */
  machineBusyPct: number
}

export async function measureLatency(opts: {
  writerPage: Page
  observerPage: Page
  view: View
  /** frame 0's id (the 100% view) */
  frame0: string
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
  await setView(writerPage, view, opts.frame0)
  const cam = await setView(observerPage, view, opts.frame0)
  if (opts.busyPage) await setView(opts.busyPage, view, opts.frame0)
  await observerPage.waitForTimeout(1500)
  let targets = await visibleNotes(observerPage, 60)
  if (targets.length < 10) throw new Error(`only ${targets.length} notes in the observer's view`)
  // Unmeasured warm-up edits: freshly opened tabs are still decoding images and compiling code, and the
  // first edits after opening read slower than the rest.
  const warmup = opts.warmup ?? 40
  if (warmup > 0) {
    await runWriter(writerPage, planEdits(targets, warmup, 5, 1_000_000))
    await restore(writerPage, targets)
    await writerPage.waitForTimeout(1000)
    // the warm-up recoloured some targets: plan from what they hold now
    const colours = await writerPage.evaluate(
      (ids) => ids.map((id) => (window as unknown as PerfWindow).lobbyCanvas?.get(id)?.backgroundColor ?? ''),
      targets.map((t) => t.id),
    )
    targets = targets.map((t, i) => ({ ...t, backgroundColor: colours[i] || t.backgroundColor }))
  }
  const plan = planEdits(targets, edits, view === 'fit' ? 11 : 23)
  await startObserver(observerPage, plan)
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
  const busy = opts.busyPage && opts.busyPerSecond ? opts.busyPerSecond : 0
  if (opts.busyPage && busy) {
    // the busy tab never touches the writer's targets
    const mine = new Set(targets.map((t) => t.id))
    const free = (await visibleNotes(opts.busyPage, 200)).filter((t) => !mine.has(t.id))
    if (free.length) await busyLoad(opts.busyPage, free, busy)
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
  const sentAt = new Map(await runWriter(writerPage, plan))
  await writerPage.waitForTimeout(2000)
  const machineBusyPct = machine()
  for (const [name, cdp, page] of profiled) {
    const profile = await stopProfile(cdp, opts.profileOut?.(name))
    const frameCount = await page.evaluate(
      () => (window as unknown as { __perfFps?: { frames: number } }).__perfFps?.frames ?? 1,
    )
    logProfile(opts.log, `${name} profile (${view})`, summarizeProfile(profile, frameCount))
  }
  if (opts.busyPage && busy) {
    await opts.busyPage.evaluate(() => {
      const b = (window as unknown as { __perfBusy?: { stop: boolean } }).__perfBusy
      if (b) b.stop = true
    })
  }
  for (const stop of stopWiggles) await stop()
  const observerTab = await readFps(observerPage)
  const writerTab = await readFps(writerPage)
  const edited = plan.map((e) => ({ seq: e.seq, id: e.id, at: sentAt.get(e.seq) ?? 0 }))
  // the first frame naming the note after the edit, on each socket (round-robin: one edit of a note in flight)
  const firstFrame = (page: Page, dir: 'sent' | 'arrived') =>
    page.evaluate(
      ({ edited, dir }) => {
        const frames = (window as unknown as { __perfWs?: Record<string, { t: number; d: string }[]> })
          .__perfWs?.[dir]
        const out: [number, number][] = []
        for (const e of edited) {
          const needle = `"${e.id}"`
          const f = frames?.find((x) => x.t >= e.at && x.d.includes(needle))
          if (f) out.push([e.seq, f.t])
        }
        return out
      },
      { edited, dir },
    )
  const sent = new Map(await firstFrame(writerPage, 'sent'))
  const arrived = new Map(await firstFrame(observerPage, 'arrived'))
  const rows = await observerPage.evaluate(() => {
    const w = window as unknown as {
      __perfObs?: { rows: { seq: number; store: number; visible: number }[]; stop: () => void }
    }
    w.__perfObs?.stop()
    return w.__perfObs?.rows ?? []
  })
  const at = (seq: number) => sentAt.get(seq) ?? 0
  const painted = rows.filter((r) => r.visible > 0)
  const split = {
    send: [] as number[],
    wire: [] as number[],
    apply: [] as number[],
    render: painted.map((r) => r.visible - r.store),
  }
  for (const r of rows) {
    const s = sent.get(r.seq)
    const a = arrived.get(r.seq)
    if (s !== undefined) split.send.push(s - at(r.seq))
    if (s !== undefined && a !== undefined) split.wire.push(a - s)
    if (a !== undefined) split.apply.push(r.store - a)
  }
  const kinds: Record<string, number> = {}
  for (const e of plan) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
  const result: LatencyResult = {
    view,
    zoom: Math.round(cam.zoom * 10_000) / 10_000,
    edits,
    seen: rows.length,
    kinds,
    busyPerSecond: busy,
    visible: summarize(painted.map((r) => r.visible - at(r.seq))),
    store: summarize(rows.map((r) => r.store - at(r.seq))),
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
    `latency ${view} (zoom ${result.zoom})${busy ? ` busy ${busy}/s` : ''}: ${rows.length}/${edits} edits seen in ${Math.round((Date.now() - t0) / 1000)} s; ` +
      `visible p50 ${result.visible.p50} p95 ${result.visible.p95} p99 ${result.visible.p99} ms; ` +
      `store p95 ${result.store.p95}; split p95 send ${result.split.send.p95} wire ${result.split.wire.p95} ` +
      `apply ${result.split.apply.p95} render ${result.split.render.p95}; fps observer ${result.observerFps} writer ${result.writerFps}; ` +
      `long tasks observer ${observerTab.longTasks} (max ${observerTab.longestTaskMs} ms) writer ${writerTab.longTasks} (max ${writerTab.longestTaskMs} ms); machine ${machineBusyPct}% busy`,
  )
  await restore(writerPage, targets)
  return result
}
