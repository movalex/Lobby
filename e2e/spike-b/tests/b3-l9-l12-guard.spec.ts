// B3 L9, L11 and L12 (docs/EXCALIDRAW-MIGRATION.md §8.3, §2.9.2): the editor opens only after a grant,
// on the real board (O1's lease table, its lease hook for delayed and held grants). Separate Chromium
// processes (A, B). Owner O2; evidence docs/research/excalidraw/spike-b/B3.md.
//
//   L9   on a FREE note A uses each editor-open path of L2 (grants delayed 300 ms by the room's lease hook)
//        → the editor opens (writable) only after the grant; P3b and P5 through the guard, read-only until
//          then; the keys typed during the pending grant are replayed in order at the caret; 0 ops pushed
//          before the grant (the open-time re-measure of the label included)            (20/20 per path)
//   L11  A on a 390 px phone under touch emulation double-taps a note B holds, then a free one
//        → first: the toast, no editor; second: the editor opens after the grant
//   L12  the guard regression (the verifier's A16 probes): (1) Enter on N1 with its grant held, then at
//        once a double-click on N2's label, then P5 on N2; (2) in each state text arrives with no keydown
//        (CDP Input.insertText, as an IME or dictation would); (3) with the editor open on N1 under a grant,
//        a double-click on N2's label; (4) the same with B holding N2
//        → never a writable editor without a granted lease (every unrequested editor read-only from its
//          first sight); insertText changes nothing before a grant; Lobby's session and Excalidraw's
//          editingTextElement agree after every step; N1's lease is released only after N1's final push
//          (the monitor at A, and the order B receives them in); with B holding N2, the toast, N2's text
//          unchanged; 0 ops for an element before its grant                        (20/20 per case)
//
// The monitor is the board page's guard monitor (apps/web/src/canvas/spike/board/monitor.ts, host-lab's
// A6/A16 monitor on the real board).
//
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b b3-l9-l12   (SPIKE_B3_GUARD_REPS, default 20)
import { type CDPSession, expect, type Page, test } from '@playwright/test'
import type { Op } from '../../../packages/canvas-schema/src/protocol.ts'
import { harness } from '../support/harness.ts'
import {
  allSaved,
  board,
  centre,
  converge,
  EDIT_PATHS,
  editorState,
  everywhere,
  focusCanvas,
  labelText,
  lc,
  note,
  openEditor,
  REPS,
  type Room,
  room,
  screenOf,
  show,
  toasts,
  tryPath,
  waitEditor,
  waitSaved,
} from './b3-kit.ts'

const N = REPS('B3_GUARD', 20)
test.describe.configure({ mode: 'serial' })
test.setTimeout(120 * 60_000)

let r: Room
let slot = 0
const spot = () => {
  const n = slot++
  return { x: (n % 8) * 700, y: Math.floor(n / 8) * 700 }
}
const A = () => r.by.A?.page as Page
const B = () => r.by.B?.page as Page
const hooks = () => harness.testHooks(r.stack)

test.beforeAll(async () => {
  // A under touch emulation (the double-tap path); mouse input still works there
  r = await room(['A', 'B'], { touch: ['A'] })
})
test.afterAll(async () => {
  await r?.close()
})

// ---- the page's guard monitor, grants and the push log ----------------------------------------------

type Report = {
  violations: { kind: string }[]
  firstSeen: { lease: string | null; readOnly: boolean; mayWrite: boolean }[]
  releases: { id: string; dirty: boolean }[]
}
const monitorStart = (p: Page) => board(p, (b) => b.monitor.start())
const monitorReport = (p: Page) => board(p, (b) => b.monitor.report() as Report)
const agreement = (p: Page) =>
  board(p, (b) => b.monitor.agreement() as { ok: boolean; issues: string[]; phase: string })

/** Records every grant the page's lease client receives (lease id → times). */
async function watchGrants(p: Page): Promise<void> {
  await board(p, (b) => {
    if (b.__grantsOff) return
    b.__grants = {}
    b.__grantsOff = b.lease.on((ev: { kind: string; id: string }) => {
      if (ev.kind === 'grant') {
        b.__grants[ev.id] ??= []
        b.__grants[ev.id].push(Date.now())
      }
    })
  })
}
const grantsOf = (p: Page) => board(p, (b) => b.__grants as Record<string, number[]>)

const opId = (o: Op) => (o.k === 'c' ? o.el.id : o.id)

/**
 * Ops the page pushed since `from` for `ids` (lease id → its element ids) BEFORE a grant of that lease id
 * (the push's time against the grants the page received).
 */
async function opsBeforeGrant(p: Page, from: number, leases: Record<string, string[]>): Promise<string[]> {
  const log = (await lc(p).pushedOps()).slice(from)
  const grants = await grantsOf(p)
  const bad: string[] = []
  for (const rec of log)
    for (const o of rec.ops)
      for (const [lease, ids] of Object.entries(leases)) {
        if (!ids.includes(opId(o))) continue
        const granted = (grants[lease] ?? []).some((t) => t <= rec.at)
        if (!granted) bad.push(`${opId(o)} at ${rec.at}`)
      }
  return bad
}

/** Text that arrives with no keydown (an IME commit, dictation): CDP Input.insertText. */
async function insertText(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send('Input.insertText', { text })
}

/** The label texts of these notes in a page's map. */
const texts = async (p: Page, ns: { label: string | null }[]) => {
  const out: (string | null)[] = []
  for (const n of ns) out.push(await labelText(p, n.label))
  return out
}

/** Closes whatever editor is open (Escape) and waits until the session is idle. */
async function closeAny(p: Page): Promise<void> {
  const e = await editorState(p)
  if (e.phase === 'idle' && e.textareas === 0) return
  await focusCanvas(p)
  await p.keyboard.press('Escape')
  await waitEditor(p, (s) => s.phase === 'idle' && s.textareas === 0)
}

// ---- L9 -----------------------------------------------------------------------------------------

test('L9: on a free note every open path waits for the grant (read-only until then), replays the keys, pushes nothing before it', async () => {
  await watchGrants(A())
  const rows: Record<string, unknown>[] = []
  const at = spot()
  const arrowId = await lc(A()).create('arrow', {
    x: at.x,
    y: at.y + 320,
    points: [
      [0, 0],
      [260, 0],
    ],
  })
  await everywhere(r.browsers, arrowId)
  await hooks().leaseGrant(r.boardId, { delayMs: 300 })
  try {
    for (const path of EDIT_PATHS) {
      for (let i = 0; i < N; i++) {
        const original = path === 'arrow-dbl' ? '' : `free ${path} ${i}`
        const n = await note(A(), r.browsers, spot(), original)
        const leaseId = path === 'arrow-dbl' ? arrowId : n.id
        const from = (await lc(A()).pushedOps()).length
        await monitorStart(A())
        await tryPath(A(), path, n, arrowId, 'zz')
        // the pending window: nothing writable, nothing pushed
        const during = await editorState(A())
        const e = await waitEditor(
          A(),
          (s) => s.phase === 'open' && s.readOnly === false && s.leaseId === leaseId,
        )
        const insert = path === 'type' ? 'qzz' : 'zz'
        const value = e.value ?? ''
        // the caret of §2.9.2: a Lobby-initiated open replays at the end of the text; a guard-caught open
        // keeps Excalidraw's caret or selection (P5: the click point; a double-click on the label: all the
        // text selected, so the keys replace it, as with an instant lease)
        const replayed =
          path === 'dbl-label'
            ? value === insert
            : path === 'p5'
              ? value.includes(insert) && value.replace(insert, '') === original
              : value === original + insert
        await focusCanvas(A())
        await A().keyboard.press('Escape')
        await waitEditor(A(), (s) => s.phase === 'idle' && s.textareas === 0)
        await waitSaved(A())
        const labelIds = path === 'arrow-dbl' ? [arrowId] : [n.id, n.label as string]
        const arrowLabel =
          path === 'arrow-dbl'
            ? (
                ((await lc(A()).get(arrowId))?.boundElements as { id: string; type: string }[] | null) ?? []
              ).find((b) => b.type === 'text')?.id
            : undefined
        if (arrowLabel) labelIds.push(arrowLabel)
        const early = await opsBeforeGrant(A(), from, { [leaseId]: labelIds })
        const rep = await monitorReport(A())
        const ok =
          early.length === 0 &&
          replayed &&
          rep.violations.length === 0 &&
          !(during.textareas > 0 && during.readOnly === false)
        rows.push({
          path,
          i,
          ok,
          early,
          replayed,
          value,
          during: { phase: during.phase, textareas: during.textareas, readOnly: during.readOnly },
          violations: rep.violations.slice(0, 4),
        })
        if (!ok) console.log('row', JSON.stringify(rows.at(-1)))
        // the arrow's new label goes again, so every repetition opens a fresh one
        if (arrowLabel) await lc(A()).delete(arrowLabel)
      }
    }
  } finally {
    await hooks().leaseGrant(r.boardId, { off: true })
  }
  const byPath = Object.fromEntries(
    EDIT_PATHS.map((p) => [p, rows.filter((x) => x.path === p && x.ok).length]),
  )
  console.log(
    'B3-L9',
    JSON.stringify({ n: rows.length, okByPath: byPath, failed: rows.filter((x) => !x.ok).slice(0, 8) }),
  )
  expect(rows.filter((x) => !x.ok)).toEqual([])
  await converge(r)
})

// ---- L12 ----------------------------------------------------------------------------------------

/** B's view of the order it receives N1's label writes and N1's lease broadcasts in. */
async function orderRecorder(p: Page): Promise<void> {
  await board(p, (b) => {
    b.__order = []
    b.__orderOff?.()
    b.__orderOff = b.core.on(
      (e: { kind: string; message?: { type: string; ops?: unknown[]; id?: string; holder?: unknown } }) => {
        if (e.kind !== 'message' || !e.message) return
        const m = e.message
        if (m.type === 'changes')
          for (const op of m.ops as { k: string; id?: string; el?: { id: string } }[])
            b.__order.push({ t: 'op', id: op.k === 'c' ? op.el?.id : op.id })
        if (m.type === 'lease') b.__order.push({ t: 'lease', id: m.id, held: m.holder !== null })
      },
    )
  })
}
const orderOf = (p: Page) => board(p, (b) => b.__order as { t: string; id: string; held?: boolean }[])

/** N1's last label write reached B before N1's release (the room keeps each session's order). */
function releasedAfterFinalPush(
  order: { t: string; id: string; held?: boolean }[],
  n1: string,
  label: string,
) {
  const rel = order.findIndex((o) => o.t === 'lease' && o.id === n1 && o.held === false)
  const lastWrite = order
    .map((o, k) => (o.t === 'op' && o.id === label ? k : -1))
    .reduce((a, b) => Math.max(a, b), -1)
  return rel >= 0 && lastWrite >= 0 && lastWrite < rel
}

test('L12 (1)(2): Enter on N1 with its grant held, then a double-click on N2 and P5 on N2, insertText in each state', async () => {
  await watchGrants(A())
  const cdp = await A().context().newCDPSession(A())
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < N; i++) {
    const at = spot()
    const n1 = await note(A(), r.browsers, at, `N1 ${i}`)
    const n2 = await note(A(), r.browsers, { x: at.x + 260, y: at.y }, `N2 ${i}`)
    const before = await texts(A(), [n1, n2])
    const from = (await lc(A()).pushedOps()).length
    const t0 = (await toasts(A())).length
    await show(A(), [n1.id, n2.id])
    await hooks().leaseGrant(r.boardId, { hold: true })
    await monitorStart(A())
    const agree: Record<string, string[]> = {}
    const step = async (name: string) => {
      await A().waitForTimeout(80)
      const a = await agreement(A())
      if (!a.ok) agree[name] = a.issues
    }
    try {
      // (1) Enter on N1: the request is pending (held)
      await lc(A()).select([n1.id])
      await focusCanvas(A())
      await A().keyboard.press('Enter')
      await step('enter-n1')
      await insertText(cdp, 'I1')
      await step('insert-1')
      // at once a double-click on N2's label
      const l2 = await centre(A(), n2.label as string)
      await A().mouse.dblclick(l2.x, l2.y)
      await step('dbl-n2')
      await insertText(cdp, 'I2')
      await step('insert-2')
      // then P5 on N2: a click on its body, a second click on its label
      const nb = await lc(A()).bounds(n2.id)
      const body = await screenOf(A(), { x: (nb?.x ?? 0) + 18, y: (nb?.y ?? 0) + 18 })
      await A().mouse.click(body.x, body.y)
      await A().waitForTimeout(600)
      await A().mouse.click(l2.x, l2.y)
      await step('p5-n2')
      await insertText(cdp, 'I3')
      await step('insert-3')
    } finally {
      await hooks().leaseGrant(r.boardId, { release: true })
      await hooks().leaseGrant(r.boardId, { off: true })
    }
    await A().waitForTimeout(500)
    await step('after-release')
    await closeAny(A())
    await allSaved(r.browsers)
    await converge(r)
    const after = await texts(B(), [n1, n2])
    const early = await opsBeforeGrant(A(), from, {
      [n1.id]: [n1.id, n1.label as string],
      [n2.id]: [n2.id, n2.label as string],
    })
    const rep = await monitorReport(A())
    const unrequested = rep.firstSeen.filter((f) => !f.mayWrite && !f.readOnly)
    const ok =
      JSON.stringify(after) === JSON.stringify(before) &&
      early.length === 0 &&
      rep.violations.length === 0 &&
      unrequested.length === 0 &&
      Object.keys(agree).length === 0
    rows.push({
      i,
      ok,
      before,
      after,
      early,
      violations: rep.violations.slice(0, 4),
      editors: rep.firstSeen.map((x) => `${x.readOnly ? 'ro' : 'rw'}${x.mayWrite ? '+lease' : ''}`),
      agree,
      toasts: (await toasts(A())).slice(t0),
    })
    if (!ok) console.log('row', JSON.stringify(rows.at(-1)))
  }
  console.log(
    'B3-L12-1-2',
    JSON.stringify({ n: rows.length, sample: rows[0], failed: rows.filter((x) => !x.ok).slice(0, 6) }),
  )
  expect(rows.filter((x) => !x.ok)).toEqual([])
})

test("L12 (3)(4): with A's editor open on N1 under a grant, a double-click on N2's label (N2 free, then held by B)", async () => {
  await watchGrants(A())
  const cdp = await A().context().newCDPSession(A())
  const rows: Record<string, unknown>[] = []
  for (const held of [false, true]) {
    for (let i = 0; i < N; i++) {
      const at = spot()
      const n1 = await note(A(), r.browsers, at, `N1 ${i}`)
      const n2 = await note(A(), r.browsers, { x: at.x + 260, y: at.y }, `N2 ${i}`)
      const n2Before = await labelText(A(), n2.label)
      await show(A(), [n1.id, n2.id])
      if (held) {
        await board(B(), (b, id) => b.lease.acquire(id), n2.id)
        await expect
          .poll(() =>
            lc(A())
              .leaseState()
              .then((s) => s.holders[n2.id]?.name ?? null),
          )
          .not.toBeNull()
      }
      await orderRecorder(B())
      await openEditor(A(), n1.id)
      await monitorStart(A())
      const from = (await lc(A()).pushedOps()).length
      const t0 = (await toasts(A())).length
      await A().keyboard.press('End')
      await A().keyboard.type(' x')
      // N2's guard request is pending 300 ms (free N2), so text can arrive before its grant
      if (!held) await hooks().leaseGrant(r.boardId, { delayMs: 300 })
      const l2 = await centre(A(), n2.label as string)
      await A().mouse.dblclick(l2.x, l2.y)
      await insertText(cdp, 'I4')
      await A().waitForTimeout(80)
      const agreeAfterDbl = await agreement(A())
      let n2Open = false
      if (!held) {
        // free N2: its editor becomes writable only after its grant
        const e = await waitEditor(
          A(),
          (s) => s.phase === 'open' && s.leaseId === n2.id && s.readOnly === false,
        )
        n2Open = e.leaseId === n2.id
        await hooks().leaseGrant(r.boardId, { off: true })
      } else await A().waitForTimeout(500)
      await closeAny(A())
      await allSaved(r.browsers)
      await converge(r)
      const n1After = await labelText(B(), n1.label)
      const n2After = await labelText(B(), n2.label)
      const order = await orderOf(B())
      const rep = await monitorReport(A())
      const ts = (await toasts(A())).slice(t0)
      const early = await opsBeforeGrant(A(), from, { [n2.id]: [n2.id, n2.label as string] })
      const releasedOk = releasedAfterFinalPush(order, n1.id, n1.label as string)
      const ok =
        n1After === `N1 ${i} x` &&
        n2After === n2Before &&
        early.length === 0 &&
        rep.violations.length === 0 &&
        rep.firstSeen.every((f) => f.readOnly || f.mayWrite) &&
        agreeAfterDbl.ok &&
        releasedOk &&
        (held ? ts.some((t) => /is typing in this note/.test(t)) : n2Open)
      rows.push({
        held,
        i,
        ok,
        n1After,
        n2After,
        early,
        releasedOk,
        agree: agreeAfterDbl.issues,
        violations: rep.violations.slice(0, 4),
        editors: rep.firstSeen.map((x) => `${x.readOnly ? 'ro' : 'rw'}${x.mayWrite ? '+lease' : ''}`),
        releases: rep.releases,
        toasts: ts,
        n2Open,
      })
      if (!ok) console.log('row', JSON.stringify({ ...rows.at(-1), order: order.slice(-12) }))
      if (held) await board(B(), (b, id) => b.lease.release(id), n2.id)
    }
  }
  console.log(
    'B3-L12-3-4',
    JSON.stringify({ n: rows.length, sample: rows[0], failed: rows.filter((x) => !x.ok).slice(0, 6) }),
  )
  expect(rows.filter((x) => !x.ok)).toEqual([])
})

// ---- L11 ----------------------------------------------------------------------------------------

test('L11: on a 390 px phone (touch), a double-tap on a note B holds: the toast, no editor; on a free one: the editor after the grant', async () => {
  const phone = await room(['P', 'Q'], {
    touch: ['P'],
    viewport: { P: { width: 390, height: 844 } },
    stack: r.stack,
  })
  try {
    const P = phone.by.P?.page as Page
    const Bq = phone.by.Q?.page as Page
    await board(P, (b) => {
      b.__grants = {}
      b.lease.on((ev: { kind: string; id: string }) => {
        if (ev.kind === 'grant') {
          b.__grants[ev.id] ??= []
          b.__grants[ev.id].push(Date.now())
        }
      })
    })
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      const held = await note(P, phone.browsers, { x: i * 500, y: 0 }, `held ${i}`)
      const free = await note(P, phone.browsers, { x: i * 500, y: 300 }, `free ${i}`)
      await board(Bq, (b, id) => b.lease.acquire(id), held.id)
      await expect
        .poll(() =>
          lc(P)
            .leaseState()
            .then((s) => s.holders[held.id]?.name ?? null),
        )
        .not.toBeNull()
      const t0 = (await toasts(P)).length
      const from = (await lc(P).pushedOps()).length
      // the held note
      await show(P, [held.id])
      const h = await centre(P, held.label as string)
      await P.touchscreen.tap(h.x, h.y)
      await P.waitForTimeout(60)
      await P.touchscreen.tap(h.x, h.y)
      await P.waitForTimeout(500)
      const eHeld = await editorState(P)
      const toast = (await toasts(P)).slice(t0).some((t) => /is typing in this note/.test(t))
      // the free note
      await show(P, [free.id])
      const f = await centre(P, free.label as string)
      await P.touchscreen.tap(f.x, f.y)
      await P.waitForTimeout(60)
      await P.touchscreen.tap(f.x, f.y)
      const eFree = await waitEditor(
        P,
        (s) => s.phase === 'open' && s.leaseId === free.id && s.readOnly === false,
      )
      const grantAt =
        ((await board(P, (b) => b.__grants as Record<string, number[]>))[free.id] ?? []).at(-1) ?? null
      await focusCanvas(P)
      await P.keyboard.press('Escape')
      await waitEditor(P, (s) => s.phase === 'idle' && s.textareas === 0)
      await waitSaved(P)
      const log = (await lc(P).pushedOps()).slice(from)
      const early = log.filter(
        (p) =>
          (grantAt === null || p.at < grantAt) && p.ops.some((o) => [free.id, free.label].includes(opId(o))),
      ).length
      const heldOps = log.filter((p) => p.ops.some((o) => [held.id, held.label].includes(opId(o)))).length
      const ok =
        eHeld.phase === 'idle' &&
        eHeld.textareas === 0 &&
        toast &&
        eFree.leaseId === free.id &&
        grantAt !== null &&
        early === 0 &&
        heldOps === 0
      rows.push({
        i,
        ok,
        held: { phase: eHeld.phase, textareas: eHeld.textareas },
        toast,
        grantAt: grantAt !== null,
        early,
        heldOps,
      })
      await board(Bq, (b, id) => b.lease.release(id), held.id)
    }
    console.log(
      'B3-L11',
      JSON.stringify({ n: rows.length, sample: rows[0], failed: rows.filter((x) => !x.ok).slice(0, 6) }),
    )
    expect(rows.filter((x) => !x.ok)).toEqual([])
    await converge(phone)
  } finally {
    await phone.close()
  }
})
