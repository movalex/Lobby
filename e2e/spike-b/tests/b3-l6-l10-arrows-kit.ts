// B3 L6 and L10 (docs/EXCALIDRAW-MIGRATION.md §8.3, §2.9.4): a resize, move or rotation of a leased
// container (a note, a rectangle) or of a free text while its holder types, with arrows bound to it,
// raced against a third user's drag of an arrow's own geometry, in BOTH commit orders. Separate Chromium
// processes A (types), B (resizes, moves, rotates), C (drags the arrow), on one board of a real stack
// (O1's room re-snaps bound ends; O2's engine holds every derived follow). Owner O2 (spec and evidence),
// with O1's server half (its log of fit writes and derived rows is not read here). Evidence
// docs/research/excalidraw/spike-b/B3.md.
//
// How the actions are made. A types for real, in its granted editor (keyboard). B's and C's edits are
// Excalidraw's own element operations run on a copy of the scene and installed as ONE local edit through
// CanvasPort.transact (window.__lobbyBoard.helpers, the operations of apps/sync/test/room/arrows/support:
// editTarget = mutateElement + updateBoundElements, as a resize leaves the scene; dragPoint = createPointAt
// + movePoints; dragSegment = moveFixedSegment; dragFrame = dragSelectedElements; rotateSelection = the
// rotation handle's writes), so the engine core sees exactly what a gesture's end leaves, the arrows'
// follow included (local and derived). The commit order is forced with the latency relay
// (testHooks.withLatency) on the side that must commit second; both releases wait on one barrier.
// Deviation (recorded in B3.md): B's and C's gestures are not pointer drags (their pointer paths are B1's
// and the arrow acceptance tests' client copies).
//
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b b3-l6-l10   (SPIKE_B3_ARROW_REPS, default 20;
//      SPIKE_B3_L10_VARIANTS, a comma list of L10 3-5's variants to run, default all of
//      3-left,5-centred-moved,5-slow-typist; a filtered run is a repro aid, never the check's evidence)
//
// SPLIT BY SCENARIO (wave C, C5). This was one 1,233-line spec whose seven tests ran in one worker for about
// an hour, and the Playwright worker ran out of heap (O2-part3.md: ~120 MB/min of growth in L6 1-2). The
// growth is the config's `trace: 'retain-on-failure'` recording every call of the three launched browsers
// (measured: live heap 81 -> 317 MB over 80 rows with it, 78 -> 108 MB without), so every scenario spec now
// says `test.use({ trace: 'off' })`. Each scenario is also its own file (b3-l6-l10-arrows-<scenario>.spec.ts)
// with a room of its own, so it can be run alone: `spike-b b3-l6-l10-arrows-l6-1-2`. The old filter
// `b3-l6-l10-arrows` still matches every one of them. This file holds the helpers they share (everything
// above the first test of the old spec).
import { expect, type Page } from '@playwright/test'
import { GEOMETRY_TOLERANCE_PX as TOL } from '../../../packages/canvas-schema/src/limits.ts'
import { harness } from '../support/harness.ts'
import type { BrowserProcess } from '../support/types.ts'
import {
  allSaved,
  board,
  converge,
  editorState,
  everywhere,
  focusCanvas,
  labelText,
  lc,
  note,
  opsFor,
  pushCount,
  REPS,
  type Room,
  room,
  toasts,
  waitSaved,
} from './b3-kit.ts'

export type Pt = [number, number]
/** the geometry fields these checks read */
export type Geo = { x: number; y: number; width: number; height: number; baseHeight: number }
export type Order = 'C-first' | 'B-first'
export const ORDERS: Order[] = ['C-first', 'B-first']
/** the latency (ms, both ways together) of the side that must commit second */
export const LAG = 1_000
/** the same when one side is A's typing (its pushes go out at most every TYPING_PUSH_MS, 500 ms) */
export const TYPING_LAG = 2_400

/** repetitions per variant (SPIKE_B3_ARROW_REPS, default 20) */
export const N = REPS('B3_ARROW', 20)

/** The room of the spec file being run: opened by openRoom (beforeAll), closed by closeRoom (afterAll). */
export let r: Room
let slot = 0
export const spot = () => {
  const n = slot++
  return { x: (n % 6) * 1000, y: Math.floor(n / 6) * 1000 }
}
/** A stack, browsers A (types), B (resizes, moves, rotates) and C (drags the arrow), one board, a clean grid. */
export async function openRoom(): Promise<void> {
  slot = 0
  r = await room(['A', 'B', 'C'])
}
export async function closeRoom(): Promise<void> {
  await r?.close()
}
export const A = () => r.by.A?.page as Page
export const B = () => r.by.B?.page as Page
export const C = () => r.by.C?.page as Page
export const only = (name: string) => [r.by[name] as BrowserProcess]
export const hooks = () => harness.testHooks(r.stack)

// ---- the page-side helpers (window.__lobbyBoard.helpers) -----------------------------------------------

export function hp<T>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ({ name, args }) => {
      // biome-ignore lint/suspicious/noExplicitAny: O2's debug handle, typed in apps/web
      const b = (window as any).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard')
      return b.helpers[name](...args)
    },
    { name, args },
  ) as Promise<T>
}
export const pointAt = (page: Page, id: string, i: number) => hp<Pt>(page, 'pointAt', id, i)
export const followError = (page: Page, id: string) => hp<number>(page, 'followError', id)
export const segments = (page: Page, id: string) =>
  hp<{ v: boolean; cross: number; index: number }[]>(page, 'segments', id)
export const noteLayout = (page: Page, id: string) =>
  hp<{ text: number; container: number; wrapped: boolean } | null>(page, 'noteLayoutError', id)
export const dist = (p: Pt, q: Pt) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]))
export const sub = (p: Pt, q: Pt): Pt => [p[0] - q[0], p[1] - q[1]]

export type End = { id: string; at: Pt } | null
export async function arrow(
  page: Page,
  props: Record<string, unknown>,
  start: End,
  end: End,
): Promise<string> {
  const id = await hp<string>(page, 'bindArrow', props, start, end)
  if (props.elbowed) await hp(page, 'routeElbow', id)
  await everywhere(r.browsers, id)
  await allSaved(r.browsers)
  return id
}

/** A fixed segment of an elbow arrow: its index, orientation (v: vertical) and scene position across its axis. */
export type Seg = { index: number; v: boolean; cross: number }

/** Gives elbow arrow `E` a fixed inner segment (Excalidraw's router picks the route), and returns it. */
export async function fixSegment(page: Page, E: string): Promise<Seg> {
  const el = (await lc(page).get(E)) as unknown as { x: number; y: number; points: Pt[] }
  let k = -1
  let v = true
  for (let i = 2; i < el.points.length - 1; i++) {
    const p = el.points[i - 1] as Pt
    const q = el.points[i] as Pt
    const dx = Math.abs(p[0] - q[0])
    const dy = Math.abs(p[1] - q[1])
    if ((dx < 1e-6 && dy > 1) || (dy < 1e-6 && dx > 1)) {
      k = i
      v = dx < 1e-6
      break
    }
  }
  if (k < 0) throw new Error(`no inner segment in ${JSON.stringify(el.points)}`)
  const q = el.points[k] as Pt
  const cross = Math.round(v ? el.x + q[0] : el.y + q[1])
  await hp(page, 'routeElbow', E, { index: k, x: cross, y: cross })
  await allSaved(r.browsers)
  const seg = (await segments(page, E)).find((s) => s.v === v && Math.abs(s.cross - cross) <= TOL)
  if (!seg) throw new Error(`segment not fixed: ${JSON.stringify(await segments(page, E))}`)
  return { index: seg.index, v, cross }
}
/** C's drag of that segment by 50 px across its axis. */
export const dragSeg = (page: Page, E: string, s: Seg, by = 50) =>
  hp(page, 'dragSegment', E, s.index, s.cross + by, s.cross + by)
export const moved = (s: Seg, by = 50) => ({ v: s.v, cross: s.cross + by })

/**
 * Releases two actions on one barrier; `late` (the side that must commit second) goes through the
 * latency relay meanwhile.
 */
export async function race(
  late: Page,
  one: () => Promise<unknown>,
  two: () => Promise<unknown>,
  lag = LAG,
): Promise<void> {
  const off = await hooks().withLatency(late, lag)
  try {
    const barrier = harness.createBarrier(2)
    await Promise.all(
      [one, two].map(async (f) => {
        await barrier.arrive()
        await f()
      }),
    )
    await late.waitForTimeout(lag * 1.5)
  } finally {
    await off()
  }
}
/** B's action and C's, `order` naming who commits first. */
export const raceBC = (order: Order, b: () => Promise<unknown>, c: () => Promise<unknown>) =>
  race(order === 'C-first' ? B() : C(), b, c)

/** Arrow ops a page pushed since `from` for these arrows. */
export async function arrowOps(page: Page, ids: readonly string[], from: number): Promise<number> {
  let n = 0
  for (const id of ids) n += (await opsFor(page, id, from)).length
  return n
}

export interface Want {
  /** point `i` (negative from the end) at scene `at` */
  point?: { i: number; at: Pt }
  /** point `i` at `rel` from point 0 (a self-loop's midpoint moves with its start, §2.9.4) */
  rel?: { i: number; rel: Pt }
  /** a fixed segment of this orientation, across its axis at this scene position */
  seg?: { v: boolean; cross: number }
  /** the stored route is orthogonal */
  orthogonal?: boolean
}

/** In every browser: the bound ends on their targets' edges and the user-set geometry where it should be. */
export async function arrowChecks(id: string, want: Want = {}): Promise<string[]> {
  const bad: string[] = []
  for (const b of r.browsers) {
    const fe = await followError(b.page, id)
    if (!(fe <= TOL)) bad.push(`${b.name} followError ${fe.toFixed(3)}`)
    if (want.point) {
      const p = await pointAt(b.page, id, want.point.i)
      if (!(dist(p, want.point.at) <= TOL))
        bad.push(`${b.name} point ${want.point.i} ${JSON.stringify(p)} want ${JSON.stringify(want.point.at)}`)
    }
    if (want.rel) {
      const p = sub(await pointAt(b.page, id, want.rel.i), await pointAt(b.page, id, 0))
      if (!(dist(p, want.rel.rel) <= TOL))
        bad.push(`${b.name} rel ${want.rel.i} ${JSON.stringify(p)} want ${JSON.stringify(want.rel.rel)}`)
    }
    if (want.seg) {
      const w = want.seg
      const s = await segments(b.page, id)
      if (!s.some((x) => x.v === w.v && Math.abs(x.cross - w.cross) <= TOL))
        bad.push(`${b.name} segments ${JSON.stringify(s)} want ${JSON.stringify(w)}`)
    }
  }
  if (want.orthogonal) {
    const snap = await harness.readSnapshot(r.stack, r.boardId)
    const e = snap.elements.find((x) => x.id === id) as unknown as { points: Pt[] } | undefined
    const ok =
      !!e &&
      e.points.slice(1).every((p, k) => {
        const q = e.points[k] as Pt
        return Math.abs(p[0] - q[0]) < 1e-6 || Math.abs(p[1] - q[1]) < 1e-6
      })
    if (!ok) bad.push(`stored route not orthogonal: ${JSON.stringify(e?.points)}`)
  }
  return bad
}

/** The page's undo; returns the toasts it raised ("N change(s) kept — X edited it since"). */
/** The page's undo; returns its toasts, and `skip <id> <what> <reason>` for each non-silent skip. */
export async function undo(page: Page): Promise<string[]> {
  const t0 = (await toasts(page)).length
  const e0 = await eventCount(page)
  await focusCanvas(page)
  await page.keyboard.press('Control+z')
  await waitSaved(page)
  await converge(r)
  const skips = (await events(page, e0))
    .filter((e) => e.kind === 'undo')
    .flatMap(
      (e) => JSON.parse(e.detail ?? '[]') as { id: string; what: string; reason: string; silent: boolean }[],
    )
    .filter((s) => !s.silent)
    .map((s) => `skip ${s.id} ${s.what} ${s.reason}`)
  return [...(await toasts(page)).slice(t0), ...skips]
}
export const kept = (ts: readonly string[]) => ts.filter((t) => /kept/.test(t))
/**
 * Records a repetition's row (and prints it, so a failed convergence still shows it). The printed row ends
 * with the Playwright worker's heap in MB (`heapMB`, not part of the stored row): the worker once ran out
 * of heap in a whole-file run, so its growth is in every log. Run with `NODE_OPTIONS=--expose-gc` and the
 * number is the live heap after a collection; without it, it includes garbage and saws up and down.
 */
export function rec(rows: Record<string, unknown>[], row: Record<string, unknown>): void {
  rows.push(row)
  ;(globalThis as { gc?: () => void }).gc?.()
  console.log('row', JSON.stringify({ ...row, heapMB: Math.round(process.memoryUsage().heapUsed / 1e6) }))
}

export type LogEntry = { kind: string; id: string | null; detail: string | null; n: number }
/** The session's event log (acks, rejects, refits, notices) of a page after entry `from`. */
export const events = (page: Page, from: number) =>
  board(page, (b, f: number) => (b.session.eventLog as LogEntry[]).filter((e) => e.n > f), from)
/** The number of the page's last event-log entry. */
export const eventCount = (page: Page) =>
  board(page, (b) => ((b.session.eventLog as LogEntry[]).at(-1)?.n ?? 0) as number)
export type CoreLogEntry = { n: number; event: string; detail: unknown }
/** The number of the page's last core-log entry (session.coreLog: ids, counts and clocks only). */
export const boardLogCount = (page: Page) =>
  board(page, (b) => ((b.session.coreLog as CoreLogEntry[]).at(-1)?.n ?? 0) as number)
/**
 * A's record of one L10 5 race: its pushes of `id` after push `fromPush` (seq, base, sent at, the fit and
 * the group names), its acks, refits and the core's fit_superseded records after `fromEvent`/`fromLog`.
 */
export async function aTrace(id: string, fromPush: number, fromEvent: number, fromLog: number) {
  const pushes = (await lc(A()).pushedOps()).slice(fromPush).flatMap((p) =>
    p.ops
      .filter((o) => o.k === 'p' && o.id === id)
      .map((o) => ({
        seq: p.seq,
        base: p.base,
        at: p.at,
        fit: (o as { fit?: unknown }).fit ?? null,
        g: Object.keys((o as { g?: object }).g ?? {}),
      })),
  )
  const ev = (await events(A(), fromEvent))
    .filter((e) => e.kind === 'ack' || e.kind === 'refit' || e.kind === 'welcome')
    .map((e) => `${e.kind} ${e.id ?? ''} ${e.detail ?? ''}`.trim())
  const superseded = await board(
    A(),
    (b, from: number) =>
      (b.session.coreLog as CoreLogEntry[])
        .filter((e) => e.n > from && e.event.startsWith('fit_superseded'))
        .map((e) => e.detail),
    fromLog,
  )
  return { pushes, ev, superseded }
}
export const rejectsSince = async (page: Page, from: number) =>
  (await events(page, from)).filter((e) => e.kind === 'reject')

/**
 * The commit clock of the first push `page` made after push `fromPush` (and log entry `fromEvent`) that
 * wrote `id` (the ack's `clock`): which of two racing writes the server committed first.
 */
export async function commitClock(
  page: Page,
  id: string,
  fromPush: number,
  fromEvent: number,
): Promise<number | null> {
  const log = await lc(page).pushedOps()
  const seqs = log
    .slice(fromPush)
    .filter((p) => p.ops.some((o) => (o.k === 'c' ? o.el.id : o.id) === id))
    .map((p) => p.seq)
  if (!seqs.length) return null
  const acks = (await events(page, fromEvent)).filter((e) => e.kind === 'ack')
  const clocks = acks.filter((a) => seqs.includes(Number(a.id))).map((a) => Number(a.detail))
  return clocks.length ? Math.min(...clocks) : null
}
/** Which of B's write of `bId` and C's write of `cId` committed first (from the acks' clocks). */
export async function committedFirst(
  bId: string,
  cId: string,
  from: { B: number; C: number; eB: number; eC: number },
): Promise<string> {
  const b = await commitClock(B(), bId, from.B, from.eB)
  const c = await commitClock(C(), cId, from.C, from.eC)
  if (b === null || c === null) return `unknown (B ${b}, C ${c})`
  return c < b ? 'C-first' : 'B-first'
}

/** A types `text` at the caret of its open editor (`delay` ms between keys). */
export const typeKeys = (text: string, delay = 4) => A().keyboard.type(text, { delay })
/**
 * L10 5's slow typist: A's race typing spans several typing pushes (TYPING_PUSH_MS, 500 ms), so more than
 * one of A's x fits is in flight when B's move reaches A. The integration's first run hit this on a loaded
 * machine (B's move lost 20/20); a fast run (one push) never did.
 */
export const SLOW_KEY_MS = 90
export const buffer = () => editorState(A()).then((e) => e.value)

export const LONG =
  ' and then a much longer run of words, long enough that the note has to grow past its size to hold it all'

/** A's text intact: the label's text in every browser equals what A typed. */
export async function textIntact(label: string | null, typed: string | null): Promise<boolean> {
  if (!label || typed === null) {
    console.log('intact: no label or buffer', JSON.stringify({ label, typed }))
    return false
  }
  let ok = true
  for (const b of r.browsers) {
    const got = await labelText(b.page, label)
    if (got !== typed) {
      ok = false
      console.log('intact:', b.name, JSON.stringify({ got, typed }))
    }
  }
  return ok
}

/** The label of a container, in `page`'s map. */
export async function labelOf(page: Page, id: string): Promise<string | null> {
  const el = await lc(page).get(id)
  return (
    (el?.boundElements as { id: string; type: string }[] | null | undefined)?.find((b) => b.type === 'text')
      ?.id ?? null
  )
}

/** Opens A's editor on a container through P1 (select, Enter) and waits for it to be writable. */
export async function openOn(id: string): Promise<void> {
  await lc(A()).select([id])
  await focusCanvas(A())
  await A().keyboard.press('Enter')
  await expect.poll(async () => (await editorState(A())).phase).toBe('open')
  await expect.poll(async () => (await editorState(A())).readOnly).toBe(false)
}

/**
 * The label of note `id` is laid out (wrapped, fitted, the note grown) for the note's current size in
 * C's map, while A's editor is still open, and the note has B's width: "re-wrapped for B's width while A
 * still types".
 */
export async function rewrappedLive(id: string, width: number): Promise<boolean> {
  try {
    await expect
      .poll(
        async () => {
          const n = await lc(C()).get(id)
          const lay = await noteLayout(C(), id)
          return !!n && Math.abs((n.width ?? 0) - width) <= TOL && !!lay && lay.text <= TOL && lay.wrapped
        },
        { timeout: 8_000 },
      )
      .toBe(true)
    return (await editorState(A())).phase === 'open'
  } catch {
    return false
  }
}

// ---- L6 -----------------------------------------------------------------------------------------

export interface L6 {
  at: { x: number; y: number }
  n: { id: string; label: string | null }
  S: string
  E: string | null
  K: string | null
  F: string | null
}

/**
 * N (a 200 px note with a label) with a straight arrow S start-bound to its right edge (free end 260 px
 * to the right), and (unless `frame`) an elbow arrow E from N's right edge to a rectangle M. `loop`: a
 * curved arrow K bound to N at both ends. `frame`: N and S (with a bend) inside frame F.
 */
export async function l6Setup(o: { rotate?: number; frame?: boolean; loop?: boolean } = {}): Promise<L6> {
  const at = spot()
  let F: string | null = null
  if (o.frame) {
    F = await lc(A()).create('frame', { x: at.x - 40, y: at.y - 40, width: 600, height: 700, name: 'F' })
    await everywhere(r.browsers, F)
  }
  const n = await note(A(), r.browsers, at, 'typing here')
  if (F)
    await board(
      A(),
      (b, a) =>
        b.port.transact('frame children', (tx: { update(i: string, p: object): void }) => {
          tx.update(a.n, { frameId: a.F })
          if (a.l) tx.update(a.l, { frameId: a.F })
        }),
      { n: n.id, l: n.label, F },
    )
  if (o.rotate) await hp(A(), 'editTarget', n.id, { angle: o.rotate })
  const S = await arrow(
    A(),
    {
      x: at.x + 200,
      y: at.y + 100,
      points: o.frame
        ? [
            [0, 0],
            [130, -60],
            [260, 0],
          ]
        : [
            [0, 0],
            [260, 0],
          ],
      ...(F ? { frameId: F } : {}),
    },
    { id: n.id, at: [1, 0.5] },
    null,
  )
  let E: string | null = null
  if (!o.frame) {
    const M = await lc(A()).create('rectangle', {
      x: at.x + 520,
      y: at.y + 440,
      width: 160,
      height: 100,
      roughness: 0,
    })
    await everywhere(r.browsers, M)
    E = await arrow(
      A(),
      {
        x: at.x + 200,
        y: at.y + 160,
        points: [
          [0, 0],
          [320, 330],
        ],
        elbowed: true,
      },
      { id: n.id, at: [1, 0.8] },
      { id: M, at: [0, 0.5] },
    )
  }
  let K: string | null = null
  if (o.loop)
    K = await arrow(
      A(),
      {
        x: at.x + 200,
        y: at.y + 40,
        points: [
          [0, 0],
          [140, -120],
          [0, 100],
        ],
        roundness: { type: 2 },
      },
      { id: n.id, at: [1, 0.2] },
      { id: n.id, at: [1, 0.7] },
    )
  await allSaved(r.browsers)
  return { at, n, S, E, K, F }
}

export const arrowsOf = (s: L6) => [s.S, s.E, s.K].filter(Boolean) as string[]

/** The stored note has B's width/baseHeight/position, a height that fits A's text, and its label laid out. */
export async function noteKept(
  id: string,
  want: { width?: number; baseHeight?: number; x?: number; y?: number },
) {
  const bad: string[] = []
  for (const b of r.browsers) {
    const n = (await lc(b.page).get(id)) as unknown as Geo | null
    if (!n) {
      bad.push(`${b.name} no note`)
      continue
    }
    for (const k of ['width', 'baseHeight', 'x', 'y'] as const) {
      const w = want[k]
      if (w !== undefined && !(Math.abs((n[k] ?? 0) - w) <= TOL)) bad.push(`${b.name} ${k} ${n[k]} want ${w}`)
    }
    if (!((n.height ?? 0) >= (n.baseHeight ?? 0) - TOL))
      bad.push(`${b.name} height ${n.height} < baseHeight ${n.baseHeight}`)
    const lay = await noteLayout(b.page, id)
    if (!lay || !(lay.text <= TOL) || !(lay.container <= TOL) || !lay.wrapped)
      bad.push(`${b.name} layout ${JSON.stringify(lay)}`)
  }
  return bad
}

/** 3d / 3f / L10 6: B turns `target` by 90° while C drags E's fixed segment; live, or as C's offline replay. */
export async function rotateVsSegment(
  mode: 'live' | 'replay',
  order: Order,
  target: string,
  E: string,
  seg: Seg,
): Promise<Record<string, unknown>> {
  const rot = () => hp(B(), 'editTarget', target, { angle: Math.PI / 2 })
  const drag = () => dragSeg(C(), E, seg)
  const from = {
    B: await pushCount(B()),
    C: await pushCount(C()),
    eB: await eventCount(B()),
    eC: await eventCount(C()),
  }
  if (mode === 'live') await raceBC(order, rot, drag)
  else {
    await hooks().cutSocket(C())
    await expect.poll(async () => (await lc(C()).saveState()).state).toBe('offline')
    await drag()
    if (order === 'B-first') {
      await rot()
      await waitSaved(B())
      await hooks().restoreSocket(C())
      await waitSaved(C())
    } else {
      // C's replay commits before B's rotation, which B makes on a copy taken before the replay reached it
      const off = await hooks().withLatency(B(), 6_000)
      try {
        await hooks().restoreSocket(C())
        await rot()
        await waitSaved(C())
        await waitSaved(B(), 30_000)
      } finally {
        await off()
      }
    }
  }
  await allSaved(r.browsers)
  return { committed: await committedFirst(target, E, from) }
}
