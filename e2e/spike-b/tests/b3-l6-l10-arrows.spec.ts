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
import { expect, type Page, test } from '@playwright/test'
import { GEOMETRY_TOLERANCE_PX as TOL } from '../../../packages/canvas-schema/src/limits.ts'
import { harness } from '../support/harness.ts'
import type { BrowserProcess } from '../support/types.ts'
import {
  allSaved,
  board,
  closeEditor,
  converge,
  editorState,
  everywhere,
  focusCanvas,
  labelText,
  lc,
  note,
  openEditor,
  opsFor,
  pushCount,
  REPS,
  type Room,
  room,
  toasts,
  waitSaved,
} from './b3-kit.ts'

const N = REPS('B3_ARROW', 20)
test.describe.configure({ mode: 'serial' })
test.setTimeout(180 * 60_000)

type Pt = [number, number]
/** the geometry fields these checks read */
type Geo = { x: number; y: number; width: number; height: number; baseHeight: number }
type Order = 'C-first' | 'B-first'
const ORDERS: Order[] = ['C-first', 'B-first']
/** the latency (ms, both ways together) of the side that must commit second */
const LAG = 1_000
/** the same when one side is A's typing (its pushes go out at most every TYPING_PUSH_MS, 500 ms) */
const TYPING_LAG = 2_400

let r: Room
let slot = 0
const spot = () => {
  const n = slot++
  return { x: (n % 6) * 1000, y: Math.floor(n / 6) * 1000 }
}
const A = () => r.by.A?.page as Page
const B = () => r.by.B?.page as Page
const C = () => r.by.C?.page as Page
const only = (name: string) => [r.by[name] as BrowserProcess]
const hooks = () => harness.testHooks(r.stack)

test.beforeAll(async () => {
  r = await room(['A', 'B', 'C'])
})
test.afterAll(async () => {
  await r?.close()
})

// ---- the page-side helpers (window.__lobbyBoard.helpers) -----------------------------------------------

function hp<T>(page: Page, name: string, ...args: unknown[]): Promise<T> {
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
const pointAt = (page: Page, id: string, i: number) => hp<Pt>(page, 'pointAt', id, i)
const followError = (page: Page, id: string) => hp<number>(page, 'followError', id)
const segments = (page: Page, id: string) =>
  hp<{ v: boolean; cross: number; index: number }[]>(page, 'segments', id)
const noteLayout = (page: Page, id: string) =>
  hp<{ text: number; container: number; wrapped: boolean } | null>(page, 'noteLayoutError', id)
const dist = (p: Pt, q: Pt) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]))
const sub = (p: Pt, q: Pt): Pt => [p[0] - q[0], p[1] - q[1]]

type End = { id: string; at: Pt } | null
async function arrow(page: Page, props: Record<string, unknown>, start: End, end: End): Promise<string> {
  const id = await hp<string>(page, 'bindArrow', props, start, end)
  if (props.elbowed) await hp(page, 'routeElbow', id)
  await everywhere(r.browsers, id)
  await allSaved(r.browsers)
  return id
}

/** A fixed segment of an elbow arrow: its index, orientation (v: vertical) and scene position across its axis. */
type Seg = { index: number; v: boolean; cross: number }

/** Gives elbow arrow `E` a fixed inner segment (Excalidraw's router picks the route), and returns it. */
async function fixSegment(page: Page, E: string): Promise<Seg> {
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
const dragSeg = (page: Page, E: string, s: Seg, by = 50) =>
  hp(page, 'dragSegment', E, s.index, s.cross + by, s.cross + by)
const moved = (s: Seg, by = 50) => ({ v: s.v, cross: s.cross + by })

/**
 * Releases two actions on one barrier; `late` (the side that must commit second) goes through the
 * latency relay meanwhile.
 */
async function race(
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
const raceBC = (order: Order, b: () => Promise<unknown>, c: () => Promise<unknown>) =>
  race(order === 'C-first' ? B() : C(), b, c)

/** Arrow ops a page pushed since `from` for these arrows. */
async function arrowOps(page: Page, ids: readonly string[], from: number): Promise<number> {
  let n = 0
  for (const id of ids) n += (await opsFor(page, id, from)).length
  return n
}

interface Want {
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
async function arrowChecks(id: string, want: Want = {}): Promise<string[]> {
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
async function undo(page: Page): Promise<string[]> {
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
const kept = (ts: readonly string[]) => ts.filter((t) => /kept/.test(t))
/** Records a repetition's row (and prints it, so a failed convergence still shows it). */
function rec(rows: Record<string, unknown>[], row: Record<string, unknown>): void {
  rows.push(row)
  console.log('row', JSON.stringify(row))
}

type LogEntry = { kind: string; id: string | null; detail: string | null; n: number }
/** The session's event log (acks, rejects, refits, notices) of a page after entry `from`. */
const events = (page: Page, from: number) =>
  board(page, (b, f: number) => (b.session.eventLog as LogEntry[]).filter((e) => e.n > f), from)
/** The number of the page's last event-log entry. */
const eventCount = (page: Page) =>
  board(page, (b) => ((b.session.eventLog as LogEntry[]).at(-1)?.n ?? 0) as number)
type CoreLogEntry = { n: number; event: string; detail: unknown }
/** The number of the page's last core-log entry (session.coreLog: ids, counts and clocks only). */
const boardLogCount = (page: Page) =>
  board(page, (b) => ((b.session.coreLog as CoreLogEntry[]).at(-1)?.n ?? 0) as number)
/**
 * A's record of one L10 5 race: its pushes of `id` after push `fromPush` (seq, base, sent at, the fit and
 * the group names), its acks, refits and the core's fit_superseded records after `fromEvent`/`fromLog`.
 */
async function aTrace(id: string, fromPush: number, fromEvent: number, fromLog: number) {
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
const rejectsSince = async (page: Page, from: number) =>
  (await events(page, from)).filter((e) => e.kind === 'reject')

/**
 * The commit clock of the first push `page` made after push `fromPush` (and log entry `fromEvent`) that
 * wrote `id` (the ack's `clock`): which of two racing writes the server committed first.
 */
async function commitClock(
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
async function committedFirst(
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
const type = (text: string, delay = 4) => A().keyboard.type(text, { delay })
/**
 * L10 5's slow typist: A's race typing spans several typing pushes (TYPING_PUSH_MS, 500 ms), so more than
 * one of A's x fits is in flight when B's move reaches A. The integration's first run hit this on a loaded
 * machine (B's move lost 20/20); a fast run (one push) never did.
 */
const SLOW_KEY_MS = 90
const buffer = () => editorState(A()).then((e) => e.value)

const LONG =
  ' and then a much longer run of words, long enough that the note has to grow past its size to hold it all'

/** A's text intact: the label's text in every browser equals what A typed. */
async function textIntact(label: string | null, typed: string | null): Promise<boolean> {
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
async function labelOf(page: Page, id: string): Promise<string | null> {
  const el = await lc(page).get(id)
  return (
    (el?.boundElements as { id: string; type: string }[] | null | undefined)?.find((b) => b.type === 'text')
      ?.id ?? null
  )
}

/** Opens A's editor on a container through P1 (select, Enter) and waits for it to be writable. */
async function openOn(id: string): Promise<void> {
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
async function rewrappedLive(id: string, width: number): Promise<boolean> {
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

interface L6 {
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
async function l6Setup(o: { rotate?: number; frame?: boolean; loop?: boolean } = {}): Promise<L6> {
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

const arrowsOf = (s: L6) => [s.S, s.E, s.K].filter(Boolean) as string[]

/** The stored note has B's width/baseHeight/position, a height that fits A's text, and its label laid out. */
async function noteKept(id: string, want: { width?: number; baseHeight?: number; x?: number; y?: number }) {
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

test('L6 1-2: B resizes N while A types (and moves N rotated 15°); arrows follow through the server only', async () => {
  const rows: Record<string, unknown>[] = []
  for (const variant of ['resize', 'rotated-move'] as const) {
    for (let i = 0; i < N; i++) {
      const s = await l6Setup(variant === 'rotated-move' ? { rotate: (15 * Math.PI) / 180 } : {})
      const from = { A: await pushCount(A()), B: await pushCount(B()), C: await pushCount(C()) }
      await openEditor(A(), s.n.id)
      await A().keyboard.press('End')
      await type(LONG)
      await everywhere(only('B'), s.n.label as string, (e) =>
        ((e as { originalText?: string }).originalText ?? '').endsWith('all'),
      )
      const nb = (await lc(B()).get(s.n.id)) as unknown as Geo
      const want =
        variant === 'resize'
          ? { width: nb.width + 80, baseHeight: 260, x: nb.x, y: nb.y }
          : { width: nb.width, baseHeight: nb.baseHeight, x: nb.x + 60, y: nb.y + 40 }
      if (variant === 'resize')
        await hp(B(), 'editTarget', s.n.id, {
          width: want.width,
          baseHeight: 260,
          height: Math.max(260, nb.height),
        })
      else await hp(B(), 'editTarget', s.n.id, { x: want.x, y: want.y })
      await waitSaved(B())
      await everywhere(
        only('A'),
        s.n.id,
        (e) => Math.abs((e.width ?? 0) - want.width) <= TOL && Math.abs((e.x ?? 0) - want.x) <= TOL,
      )
      await type(' more')
      const live = await rewrappedLive(s.n.id, want.width)
      const typed = await buffer()
      await closeEditor(A())
      // every map equals the snapshot first: the checks then read the final state in every browser
      await converge(r)
      const bad = [...(await noteKept(s.n.id, want))]
      for (const a of arrowsOf(s)) bad.push(...(await arrowChecks(a, { orthogonal: a === s.E })))
      const aArrow = await arrowOps(A(), arrowsOf(s), from.A)
      const bArrow = await arrowOps(B(), arrowsOf(s), from.B)
      const cOps = (await pushCount(C())) - from.C
      const intact = await textIntact(s.n.label, typed)
      const ok = bad.length === 0 && aArrow === 0 && bArrow === 0 && cOps === 0 && intact && live
      rec(rows, { variant, i, ok, bad, aArrow, bArrow, cOps, intact, live })
      await converge(r)
    }
  }
  console.log('B3-L6.1-2', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 6) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})

test("L6 3/3a-3c + 5: C's free end, loop midpoint or fixed segment survives B's resize while A types, both orders; C undoes", async () => {
  const rows: Record<string, unknown>[] = []
  for (const kind of ['3a-free-end', '3b-midpoint', '3c-segment'] as const) {
    for (const order of ORDERS) {
      for (let i = 0; i < N; i++) {
        const s = await l6Setup({ loop: kind === '3b-midpoint' })
        let target = s.S
        let want: Want
        let before: Want
        let drag: () => Promise<unknown>
        if (kind === '3a-free-end') {
          const p0 = await pointAt(C(), s.S, -1)
          const to: Pt = [p0[0] + 40, p0[1] + 90]
          before = { point: { i: -1, at: p0 } }
          want = { point: { i: -1, at: to } }
          drag = () => hp(C(), 'dragPoint', s.S, -1, to)
        } else if (kind === '3b-midpoint') {
          target = s.K as string
          const m0 = await pointAt(C(), target, 1)
          const s0 = await pointAt(C(), target, 0)
          const to: Pt = [m0[0] + 50, m0[1] - 30]
          before = { rel: { i: 1, rel: sub(m0, s0) } }
          want = { rel: { i: 1, rel: sub(to, s0) } }
          drag = () => hp(C(), 'dragPoint', target, 1, to)
        } else {
          target = s.E as string
          const seg = await fixSegment(C(), target)
          before = { seg: moved(seg, 0), orthogonal: true }
          want = { seg: moved(seg), orthogonal: true }
          drag = () => dragSeg(C(), target, seg)
        }
        const from = { A: await pushCount(A()), B: await pushCount(B()), C: await pushCount(C()) }
        const ev = await eventCount(C())
        const evB = await eventCount(B())
        await openEditor(A(), s.n.id)
        await A().keyboard.press('End')
        await type(LONG)
        const nb = (await lc(B()).get(s.n.id)) as unknown as Geo
        const w = nb.width + 70
        await raceBC(
          order,
          () =>
            hp(B(), 'editTarget', s.n.id, { width: w, baseHeight: 300, height: Math.max(300, nb.height) }),
          drag,
        )
        await type(' more')
        const typed = await buffer()
        await closeEditor(A())
        // every map equals the snapshot first: the checks then read the final state in every browser
        await converge(r)
        const bad = [
          ...(await noteKept(s.n.id, { width: w, baseHeight: 300 })),
          ...(await arrowChecks(target, want)),
        ]
        for (const a of arrowsOf(s)) if (a !== target) bad.push(...(await arrowChecks(a)))
        const aArrow = await arrowOps(A(), arrowsOf(s), from.A)
        const bArrow = await arrowOps(B(), arrowsOf(s), from.B)
        const cArrow = await arrowOps(C(), [target], from.C)
        const cOps = (await pushCount(C())) - from.C
        const cRejects = await rejectsSince(C(), ev)
        const intact = await textIntact(s.n.label, typed)
        const committed = await committedFirst(s.n.id, target, { B: from.B, C: from.C, eB: evB, eC: ev })
        // 5: C undoes its drag after B's write landed: the dragged point back, bound ends on N's current edge
        const t = await undo(C())
        const undoBad = await arrowChecks(target, before)
        const ok =
          bad.length === 0 &&
          aArrow === 0 &&
          bArrow === 0 &&
          cArrow === 1 &&
          cOps === 1 &&
          cRejects.length === 0 &&
          intact &&
          committed === order &&
          undoBad.length === 0 &&
          kept(t).length === 0
        rec(rows, {
          kind,
          order,
          committed,
          i,
          ok,
          bad,
          aArrow,
          bArrow,
          cArrow,
          cOps,
          cRejects,
          intact,
          undoBad,
          undoToasts: t,
        })
        await converge(r)
      }
    }
  }
  console.log('B3-L6.3a-c', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 6) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})

test("L6 4 + 5: B drags frame F (N and an arrow with a free end and a bend) while A types, both orders of the drag and A's fit; B undoes", async () => {
  const rows: Record<string, unknown>[] = []
  for (const order of ['drag-first', 'fit-first'] as const) {
    for (let i = 0; i < N; i++) {
      const s = await l6Setup({ frame: true })
      const F = s.F as string
      const free0 = await pointAt(B(), s.S, -1)
      const bend0 = await pointAt(B(), s.S, 1)
      const f0 = (await lc(B()).get(F)) as unknown as { x: number; y: number }
      const by = { x: 70, y: 45 }
      const from = { A: await pushCount(A()), B: await pushCount(B()) }
      await openEditor(A(), s.n.id)
      await A().keyboard.press('End')
      await type(' typing')
      await waitSaved(A())
      const at = { A: await pushCount(A()), eA: await eventCount(A()), eB: await eventCount(B()) }
      // A's fit (keystrokes that re-lay the label out) and B's frame drag on one barrier; the side that
      // must commit second goes through the relay
      await race(
        order === 'drag-first' ? A() : B(),
        () => hp(B(), 'dragFrame', F, by),
        () => type(LONG),
        TYPING_LAG,
      )
      await type(' more')
      const typed = await buffer()
      await closeEditor(A())
      // every map equals the snapshot first: the checks then read the final state in every browser
      await converge(r)
      const bad = [
        ...(await noteKept(s.n.id, { x: s.at.x + by.x, y: s.at.y + by.y })),
        ...(await arrowChecks(s.S, { point: { i: -1, at: [free0[0] + by.x, free0[1] + by.y] } })),
      ]
      for (const b of r.browsers) {
        const bend = await pointAt(b.page, s.S, 1)
        if (!(dist(bend, [bend0[0] + by.x, bend0[1] + by.y]) <= TOL))
          bad.push(`${b.name} bend ${JSON.stringify(bend)}`)
        const a = (await lc(b.page).get(s.S)) as unknown as { frameId: string | null }
        const ab = await lc(b.page).bounds(s.S)
        const fb = await lc(b.page).bounds(F)
        if (a.frameId !== F) bad.push(`${b.name} frameId ${a.frameId}`)
        if (
          !ab ||
          !fb ||
          ab.x < fb.x ||
          ab.y < fb.y ||
          ab.x + ab.width > fb.x + fb.width ||
          ab.y + ab.height > fb.y + fb.height
        )
          bad.push(`${b.name} arrow outside F`)
      }
      const fNow = (await lc(C()).get(F)) as unknown as { x: number; y: number }
      if (!(Math.abs(fNow.x - (f0.x + by.x)) <= TOL && Math.abs(fNow.y - (f0.y + by.y)) <= TOL))
        bad.push(`F at ${fNow.x},${fNow.y}`)
      const aArrow = await arrowOps(A(), [s.S], from.A)
      const bS = (await opsFor(B(), s.S, from.B)).length
      const intact = await textIntact(s.n.label, typed)
      const cf = await commitClock(A(), s.n.label as string, at.A, at.eA)
      const cd = await commitClock(B(), s.n.id, from.B, at.eB)
      const committed =
        cf === null || cd === null ? `unknown (fit ${cf}, drag ${cd})` : cd < cf ? 'drag-first' : 'fit-first'
      // 5: B undoes the frame drag: F, N and the arrow back by F's offset; the bound end on N's edge
      const t = await undo(B())
      const undoBad = await arrowChecks(s.S, { point: { i: -1, at: free0 } })
      const fBack = (await lc(C()).get(F)) as unknown as { x: number; y: number }
      if (!(Math.abs(fBack.x - f0.x) <= TOL && Math.abs(fBack.y - f0.y) <= TOL))
        undoBad.push(`F back at ${fBack.x},${fBack.y}`)
      const ok =
        bad.length === 0 &&
        aArrow === 0 &&
        bS === 1 &&
        intact &&
        committed === order &&
        undoBad.length === 0 &&
        kept(t).length === 0
      rec(rows, { order, committed, i, ok, bad, aArrow, bS, intact, undoBad, undoToasts: t })
      await converge(r)
    }
  }
  console.log('B3-L6.4', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 6) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})

/** 3d / 3f / L10 6: B turns `target` by 90° while C drags E's fixed segment; live, or as C's offline replay. */
async function rotateVsSegment(
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

test("L6 3d-3f + 5: a 90° turn of N against C's segment drag (live and offline replay) and a selection rotation against C's free-end drag, both orders", async () => {
  const rows: Record<string, unknown>[] = []
  for (const kind of ['3d-turn', '3f-replay', '3e-rotate-selection'] as const) {
    for (const order of ORDERS) {
      for (let i = 0; i < N; i++) {
        const s = await l6Setup()
        const E = s.E as string
        const seg = kind === '3e-rotate-selection' ? null : await fixSegment(C(), E)
        const from = { A: await pushCount(A()), B: await pushCount(B()), C: await pushCount(C()) }
        const ev = await eventCount(C())
        await openEditor(A(), s.n.id)
        await A().keyboard.press('End')
        await type(' typing')
        const bad: string[] = []
        const row: Record<string, unknown> = { kind, order, i }
        if (seg) {
          Object.assign(
            row,
            await rotateVsSegment(kind === '3d-turn' ? 'live' : 'replay', order, s.n.id, E, seg),
          )
          await type(' more')
          await closeEditor(A())
          // every map equals the snapshot first: the checks then read the final state in every browser
          await converge(r)
          if (row.committed !== order) bad.push(`committed ${row.committed}`)
          bad.push(
            ...(await arrowChecks(E, { seg: moved(seg), orthogonal: true })),
            ...(await arrowChecks(s.S)),
          )
          const cRejects = await rejectsSince(C(), ev)
          if (cRejects.length) bad.push(`C rejects ${JSON.stringify(cRejects)}`)
          const cE = (await opsFor(C(), E, from.C)).length
          if (cE !== 1) bad.push(`C pushed E ${cE} times`)
          // 5: C's undo finds the renumbered segment by order; then B's undo of the turn leaves C's segment
          const tc = await undo(C())
          const undoC = await arrowChecks(E, { seg: moved(seg, 0), orthogonal: true })
          const tb = await undo(B())
          const undoB = await arrowChecks(E, { seg: moved(seg, 0), orthogonal: true })
          if (kept(tc).length || kept(tb).length) bad.push(`kept: ${JSON.stringify([...tc, ...tb])}`)
          bad.push(...undoC.map((x) => `C undo: ${x}`), ...undoB.map((x) => `B undo: ${x}`))
        } else {
          // 3e: B rotates a selection holding N and S; C drags S's free end
          const p0 = await pointAt(C(), s.S, -1)
          const to: Pt = [p0[0] + 30, p0[1] + 80]
          const versions: { B?: { angle: number; end: Pt }; C?: { angle: number; end: Pt } } = {}
          const at = {
            B: await pushCount(B()),
            C: await pushCount(C()),
            eB: await eventCount(B()),
            eC: await eventCount(C()),
          }
          await raceBC(
            order,
            async () => {
              await hp(B(), 'rotateSelection', [s.n.id, s.S], 0.5)
              const a = (await lc(B()).get(s.S)) as unknown as { angle: number }
              versions.B = { angle: a.angle, end: await pointAt(B(), s.S, -1) }
            },
            async () => {
              await hp(C(), 'dragPoint', s.S, -1, to)
              const a = (await lc(C()).get(s.S)) as unknown as { angle: number }
              versions.C = { angle: a.angle, end: await pointAt(C(), s.S, -1) }
            },
          )
          await closeEditor(A())
          // every map equals the snapshot first: the checks then read the final state in every browser
          await converge(r)
          const stored = (await lc(C()).get(s.S)) as unknown as { angle: number }
          const end = await pointAt(C(), s.S, -1)
          const is = (v?: { angle: number; end: Pt }) =>
            !!v && Math.abs(v.angle - stored.angle) <= 1e-6 && dist(v.end, end) <= TOL
          const whose = is(versions.C) ? 'C' : is(versions.B) ? 'B' : 'mixture'
          row.whose = whose
          row.committed = await committedFirst(s.S, s.S, at)
          if (row.committed !== order) bad.push(`committed ${row.committed}`)
          // the later commit's whole version is stored
          if (whose !== (order === 'C-first' ? 'B' : 'C'))
            bad.push(`stored is ${whose}'s, the later writer is not`)
          if (whose === 'mixture')
            bad.push(`stored ${JSON.stringify({ angle: stored.angle, end })} vs ${JSON.stringify(versions)}`)
          bad.push(...(await arrowChecks(s.S)))
          const bS = (await opsFor(B(), s.S, from.B)).length
          if (bS !== 1) bad.push(`B pushed S ${bS} times`)
          // 5: the earlier writer's undo is skipped as changed (the later version is stored); the later
          // writer's undo then applies
          const later = whose === 'C' ? C() : B()
          const earlier = whose === 'C' ? B() : C()
          const te = await undo(earlier)
          const tl = await undo(later)
          row.undo = { later: tl, earlier: te }
          if (kept(tl).length) bad.push(`later undo kept: ${JSON.stringify(tl)}`)
          if (!kept(te).length) bad.push(`earlier undo not skipped: ${JSON.stringify(te)}`)
          bad.push(...(await arrowChecks(s.S)))
        }
        const aArrow = await arrowOps(A(), arrowsOf(s), from.A)
        const bArrow = await arrowOps(B(), kind === '3e-rotate-selection' ? [E] : arrowsOf(s), from.B)
        if (aArrow || bArrow) bad.push(`arrow ops A ${aArrow} B ${bArrow}`)
        rec(rows, { ...row, ok: bad.length === 0, bad })
        await converge(r)
      }
    }
  }
  console.log('B3-L6.3d-f', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 6) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})

// ---- L10 ----------------------------------------------------------------------------------------

test("L10 1-2 + 4: A types in a rectangle's label until it grows while B resizes it; then with C's free-end drag, both orders; C undoes", async () => {
  const rows: Record<string, unknown>[] = []
  for (const withC of [false, true]) {
    for (const order of withC ? ORDERS : (['C-first'] as Order[])) {
      for (let i = 0; i < N; i++) {
        const at = spot()
        const R = await lc(A()).create('rectangle', {
          x: at.x,
          y: at.y,
          width: 220,
          height: 80,
          roughness: 0,
        })
        await everywhere(r.browsers, R)
        const S = await arrow(
          A(),
          {
            x: at.x + 220,
            y: at.y + 40,
            points: [
              [0, 0],
              [240, 60],
            ],
          },
          { id: R, at: [1, 0.5] },
          null,
        )
        const p0 = await pointAt(C(), S, -1)
        const to: Pt = [p0[0] + 60, p0[1] - 50]
        const from = { A: await pushCount(A()), B: await pushCount(B()), C: await pushCount(C()) }
        // A opens the editor on the empty rectangle (P1 makes its label) and types until it grows
        await openOn(R)
        await type('a label that wraps onto many lines so the rectangle has to grow')
        const rb = (await lc(B()).get(R)) as unknown as Geo
        const w = rb.width + 90
        const resize = () => hp(B(), 'editTarget', R, { width: w })
        const ev = { B: from.B, C: from.C, eB: await eventCount(B()), eC: await eventCount(C()) }
        if (withC) await raceBC(order, resize, () => hp(C(), 'dragPoint', S, -1, to))
        else {
          await resize()
          await waitSaved(B())
        }
        await type(' and again')
        const typed = await buffer()
        await closeEditor(A())
        // every map equals the snapshot first: the checks then read the final state in every browser
        await converge(r)
        const label = await labelOf(C(), R)
        const bad = await arrowChecks(S, withC ? { point: { i: -1, at: to } } : {})
        for (const b of r.browsers) {
          const e = (await lc(b.page).get(R)) as unknown as Geo
          const lb = label ? await lc(b.page).bounds(label) : null
          if (!(Math.abs(e.width - w) <= TOL)) bad.push(`${b.name} width ${e.width} want ${w}`)
          if (!lb || lb.height > e.height + TOL)
            bad.push(`${b.name} label does not fit: ${JSON.stringify(lb)} in ${e.height}`)
        }
        const intact = await textIntact(label, typed)
        const aArrow = await arrowOps(A(), [S], from.A)
        const bArrow = await arrowOps(B(), [S], from.B)
        const cOps = (await pushCount(C())) - from.C
        const committed = withC ? await committedFirst(R, S, ev) : null
        let undoBad: string[] = []
        let t: string[] = []
        if (withC) {
          t = await undo(C())
          undoBad = await arrowChecks(S, { point: { i: -1, at: p0 } })
        }
        const ok =
          bad.length === 0 &&
          intact &&
          aArrow === 0 &&
          bArrow === 0 &&
          cOps === (withC ? 1 : 0) &&
          (!withC || committed === order) &&
          undoBad.length === 0 &&
          kept(t).length === 0
        rec(rows, {
          withC,
          order,
          committed,
          i,
          ok,
          bad,
          intact,
          aArrow,
          bArrow,
          cOps,
          undoBad,
          undoToasts: t,
        })
        await converge(r)
      }
    }
  }
  console.log('B3-L10.1-2', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 6) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})

test("L10 3-5: an arrow bound to a free text T follows T's box on every write while A types; C's free end survives; a centred T moved by B keeps B's move", async () => {
  const rows: Record<string, unknown>[] = []
  const all = ['3-left', '5-centred-moved', '5-slow-typist'] as const
  const pick = (process.env.SPIKE_B3_L10_VARIANTS ?? '').split(',').filter(Boolean)
  for (const variant of all.filter((v) => !pick.length || pick.includes(v))) {
    const slow = variant === '5-slow-typist'
    for (const order of ['A-first', 'other-first'] as const) {
      for (let i = 0; i < N; i++) {
        const at = spot()
        const T = await lc(A()).create('text', {
          x: at.x,
          y: at.y,
          text: 'free',
          textAlign: variant === '3-left' ? 'left' : 'center',
          roughness: 0,
        })
        await everywhere(r.browsers, T)
        const tb0 = await lc(A()).bounds(T)
        const S = await arrow(
          A(),
          {
            x: (tb0?.x ?? 0) + (tb0?.width ?? 0),
            y: (tb0?.y ?? 0) + (tb0?.height ?? 0) / 2,
            points: [
              [0, 0],
              [250, 80],
            ],
          },
          { id: T, at: [1, 0.5] },
          null,
        )
        const p0 = await pointAt(C(), S, -1)
        const to: Pt = [p0[0] + 40, p0[1] + 60]
        const from = { A: await pushCount(A()), B: await pushCount(B()), C: await pushCount(C()) }
        const evA = await eventCount(A())
        for (const b of r.browsers) await hp(b.page, 'startSampling', [S])
        await openEditor(A(), T)
        await A().keyboard.press('End')
        await type(' grows')
        await waitSaved(A())
        const other = variant === '3-left' ? C() : B()
        const otherId = variant === '3-left' ? S : T
        const at0 = {
          A: await pushCount(A()),
          O: await pushCount(other),
          eA: await eventCount(A()),
          eO: await eventCount(other),
          lA: await boardLogCount(A()),
        }
        let bMove: { x: number; y: number; w: number; cx: number } | null = null
        const trace: Record<string, unknown> = {}
        if (variant === '3-left')
          await race(
            order === 'A-first' ? other : A(),
            () => type(' wider and wider'),
            () => hp(C(), 'dragPoint', S, -1, to),
            TYPING_LAG,
          )
        else {
          const tb = (await lc(B()).get(T)) as unknown as Geo
          const move = { x: tb.x + 80, y: tb.y + 50, w: tb.width, cx: tb.x + 80 + tb.width / 2 }
          bMove = move
          await race(
            order === 'A-first' ? other : A(),
            () => type(' centred text grows', slow ? SLOW_KEY_MS : 4),
            () => hp(B(), 'editTarget', T, { x: move.x, y: move.y }),
            TYPING_LAG,
          )
        }
        const geo = async (p: Page) => {
          const e = (await lc(p).get(T)) as unknown as Geo
          return { x: e.x, w: e.width, cx: e.x + e.width / 2 }
        }
        trace.beforeEnd = { A: await geo(A()), C: await geo(C()) }
        await type(' end')
        await waitSaved(A())
        trace.afterEnd = { A: await geo(A()), C: await geo(C()) }
        const typed = await buffer()
        await closeEditor(A())
        // every map equals the snapshot first: the checks then read the final state in every browser
        await converge(r)
        trace.closed = { A: await geo(A()) }
        const samples: Record<string, unknown> = {}
        let followMax = 0
        for (const b of r.browsers) {
          const s = await hp<{ max: Record<string, number>; samples: number } | null>(b.page, 'stopSampling')
          samples[b.name] = s
          followMax = Math.max(followMax, s?.max[S] ?? 0)
        }
        const bad = await arrowChecks(S, variant === '3-left' ? { point: { i: -1, at: to } } : {})
        if (!(followMax <= TOL)) bad.push(`follow sampled ${followMax.toFixed(3)} ${JSON.stringify(samples)}`)
        let intact = true
        for (const b of r.browsers)
          if (((await lc(b.page).get(T)) as { originalText?: string } | null)?.originalText !== typed)
            intact = false
        if (bMove)
          for (const b of r.browsers) {
            const e = (await lc(b.page).get(T)) as unknown as Geo
            if (!(Math.abs(e.y - bMove.y) <= TOL)) bad.push(`${b.name} y ${e.y} want ${bMove.y}`)
            // B's move committed first: A's fit (computed before it) is dropped and redone on B's position,
            // so the text grows around the centre B left. A's fit first: B's write (x from B's copy) lands
            // on the grown text; from there A's typing keeps the centre, which lies between the two bounds
            const cx = e.x + e.width / 2
            const lo = bMove.cx
            const hi = bMove.x + e.width / 2
            const inRange =
              order === 'other-first' ? Math.abs(cx - lo) <= TOL : cx >= lo - TOL && cx <= hi + TOL
            if (!inRange)
              bad.push(`${b.name} centre ${cx} want ${order === 'other-first' ? lo : `[${lo}, ${hi}]`}`)
          }
        const refits = (await events(A(), evA)).filter((e) => e.kind === 'refit').length
        // A's side of the race, for the evidence: its pushes of T (seq, base, the fit and the groups), its
        // acks (seq -> commit clock) and refits, and the core's fit_superseded records (ids and numbers only)
        if (bMove) trace.a = await aTrace(T, at0.A, at0.eA, at0.lA)
        const ca = await commitClock(A(), T, at0.A, at0.eA)
        const co = await commitClock(other, otherId, at0.O, at0.eO)
        const committed =
          ca === null || co === null ? `unknown (A ${ca}, other ${co})` : ca < co ? 'A-first' : 'other-first'
        const aArrow = await arrowOps(A(), [S], from.A)
        const bArrow = await arrowOps(B(), [S], from.B)
        const cOps = (await pushCount(C())) - from.C
        let undoBad: string[] = []
        let t: string[] = []
        if (variant === '3-left') {
          t = await undo(C())
          undoBad = await arrowChecks(S, { point: { i: -1, at: p0 } })
        }
        const ok =
          bad.length === 0 &&
          intact &&
          aArrow === 0 &&
          bArrow === 0 &&
          cOps === (variant === '3-left' ? 1 : 0) &&
          committed === order &&
          undoBad.length === 0 &&
          kept(t).length === 0
        rec(rows, {
          variant,
          order,
          committed,
          i,
          ok,
          bad,
          intact,
          aArrow,
          bArrow,
          cOps,
          refits,
          followMax,
          ...(bMove ? { trace, bMove } : {}),
          undoBad,
          undoToasts: t,
        })
        await converge(r)
      }
    }
  }
  console.log('B3-L10.3-5', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 6) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})

test("L10 6: B turns a rectangle 90° while C drags its elbow arrow's fixed segment, live and as an offline replay, both orders; undo", async () => {
  const rows: Record<string, unknown>[] = []
  for (const mode of ['live', 'replay'] as const) {
    for (const order of ORDERS) {
      for (let i = 0; i < N; i++) {
        const at = spot()
        const R = await lc(A()).create('rectangle', {
          x: at.x,
          y: at.y,
          width: 220,
          height: 120,
          roughness: 0,
        })
        const M = await lc(A()).create('rectangle', {
          x: at.x + 560,
          y: at.y + 420,
          width: 150,
          height: 100,
          roughness: 0,
        })
        await everywhere(r.browsers, M)
        const E = await arrow(
          A(),
          {
            x: at.x + 220,
            y: at.y + 60,
            points: [
              [0, 0],
              [340, 410],
            ],
            elbowed: true,
          },
          { id: R, at: [1, 0.5] },
          { id: M, at: [0, 0.5] },
        )
        const seg = await fixSegment(C(), E)
        const from = { A: await pushCount(A()), B: await pushCount(B()), C: await pushCount(C()) }
        const ev = await eventCount(C())
        await openOn(R)
        await type('label')
        const row = await rotateVsSegment(mode, order, R, E, seg)
        await type(' more')
        await closeEditor(A())
        // every map equals the snapshot first: the checks then read the final state in every browser
        await converge(r)
        const bad = await arrowChecks(E, { seg: moved(seg), orthogonal: true })
        if (row.committed !== order) bad.push(`committed ${row.committed}`)
        const cRejects = await rejectsSince(C(), ev)
        if (cRejects.length) bad.push(`C rejects ${JSON.stringify(cRejects)}`)
        const cE = (await opsFor(C(), E, from.C)).length
        if (cE !== 1) bad.push(`C pushed E ${cE} times`)
        const aArrow = await arrowOps(A(), [E], from.A)
        const bArrow = await arrowOps(B(), [E], from.B)
        if (aArrow || bArrow) bad.push(`arrow ops A ${aArrow} B ${bArrow}`)
        const t = await undo(C())
        const undoBad = await arrowChecks(E, { seg: moved(seg, 0), orthogonal: true })
        if (kept(t).length) undoBad.push(`kept ${JSON.stringify(t)}`)
        const ok = bad.length === 0 && undoBad.length === 0
        rec(rows, { mode, order, i, ok, bad, undoBad, ...row })
        await converge(r)
      }
    }
  }
  console.log('B3-L10.6', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 6) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})
