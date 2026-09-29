// B2 (docs/EXCALIDRAW-MIGRATION.md §8.3): per-user undo never reverts the other user. Separate Chromium
// processes, each a different dev user, on one board of a real stack (O1's room). Undo and redo are the
// real keys (Ctrl+Z / Ctrl+Shift+Z on the board: Lobby's allowlist runs Lobby's field-level undo, §2.8).
// After every case: every map hashes equal to the test snapshot, the invariants hold, and the watcher
// (when there is one) pushed nothing. Owner O2; evidence docs/research/excalidraw/spike-b/B2.md.
//
//   U1  A +1s N; B +1s N; A undoes                          → B's +1 stays; A's is gone
//   U2  A tags N #x; B tags N #y; A undoes                  → #y stays
//   U3  A groups {N, M}; B groups that with P; A undoes     → B's outer group on N, M, P; A's inner gone
//   U4  A moves N; B recolours N; A undoes                  → N back where A found it; B's colour stays
//   U5  A recolours N red; B blue; A undoes                 → blue stays; A sees "1 change kept"
//   U6  A creates N; B deletes N; A undoes, then redoes     → N stays deleted throughout
//   U7  A drags a frame with 6 children; B recolours child 1; C moves child 2; A undoes
//                                                           → children back except child 2; child 1 keeps B's colour
//   U8  A selects and deselects 10 times, then undoes       → A's last real change undone, not a selection
//   U9  300 ms latency: A recolours N, moves it before the first ack; undo, undo
//                                                           → first undoes only the move, second only the colour
//   U10 A draws a stroke (the server rounds its points: fix) and binds an arrow to a note B deletes
//       (binding nulled); A undoes each                     → no "change kept"; stack ≤ A's real actions
//   U11 A deletes X by an undo; B restores X; C deletes X again; A redoes → X stays deleted
//
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b -- b2-undo   (SPIKE_B2_REPS, default 3)
import { expect, type Page, test } from '@playwright/test'
import { harness } from '../support/harness.ts'
import {
  allSaved,
  board,
  centre,
  converge,
  everywhere,
  focusCanvas,
  lc,
  pushCount,
  REPS,
  type Room,
  room,
  screenOf,
  show,
  toasts,
  waitSaved,
} from './b3-kit.ts'

const N = REPS('B2', 3)
test.describe.configure({ mode: 'serial' })
test.setTimeout(30 * 60_000)

let r: Room
let slot = 0
const spot = () => {
  const n = slot++
  return { x: (n % 10) * 500, y: Math.floor(n / 10) * 500 }
}

test.beforeAll(async () => {
  r = await room(['A', 'B', 'C'])
})
test.afterAll(async () => {
  await r?.close()
})

const A = () => r.by.A?.page as Page
const B = () => r.by.B?.page as Page
const C = () => r.by.C?.page as Page

async function undo(page: Page, redo = false): Promise<void> {
  await focusCanvas(page)
  await page.keyboard.press(redo ? 'Control+Shift+Z' : 'Control+z')
  await waitSaved(page)
}

const uid = (page: Page) => board(page, (b) => b.core.welcome.you.uid as string)
const lobby = async (page: Page, id: string) =>
  ((await lc(page).get(id))?.customData?.lobby ?? {}) as Record<string, unknown>

async function rect(page: Page, props: Record<string, unknown> = {}): Promise<string> {
  const at = spot()
  const id = await lc(page).create('rectangle', { x: at.x, y: at.y, width: 160, height: 100, ...props })
  await everywhere(r.browsers, id)
  await allSaved(r.browsers)
  return id
}

test('U1: +1s are per user', async () => {
  for (let i = 0; i < N; i++) {
    const n = await rect(A())
    const [ua, ub] = [await uid(A()), await uid(B())]
    await lc(A()).update(n, { customData: { lobby: { [`plusOne:${ua}`]: true } } })
    await everywhere(r.browsers, n, (e) => !!e.customData?.lobby?.[`plusOne:${ua}`])
    await lc(B()).update(n, { customData: { lobby: { [`plusOne:${ub}`]: true } } })
    await everywhere(r.browsers, n, (e) => !!e.customData?.lobby?.[`plusOne:${ub}`])
    await allSaved(r.browsers)
    await undo(A())
    await everywhere(r.browsers, n, (e) => !e.customData?.lobby?.[`plusOne:${ua}`])
    expect(Object.keys(await lobby(B(), n))).toEqual([`plusOne:${ub}`])
    await converge(r)
  }
})

test('U2: tags are per key', async () => {
  // the board's tag list (doc keys), written once through the engine (the tag feature's own path is O5's)
  await board(A(), (b) =>
    b.core.setDoc({ 'tagDef:x': { name: 'x', color: 'blue' }, 'tagDef:y': { name: 'y', color: 'red' } }),
  )
  await waitSaved(A())
  for (let i = 0; i < N; i++) {
    const n = await rect(A())
    await lc(A()).update(n, { customData: { lobby: { 'tag:x': { name: 'x', color: 'blue' } } } })
    await everywhere(r.browsers, n, (e) => !!e.customData?.lobby?.['tag:x'])
    await lc(B()).update(n, { customData: { lobby: { 'tag:y': { name: 'y', color: 'red' } } } })
    await everywhere(r.browsers, n, (e) => !!e.customData?.lobby?.['tag:y'])
    await allSaved(r.browsers)
    await undo(A())
    await everywhere(
      r.browsers,
      n,
      (e) => !e.customData?.lobby?.['tag:x'] && !!e.customData?.lobby?.['tag:y'],
    )
    await converge(r)
  }
})

test("U3: A's inner group goes, B's outer group stays", async () => {
  for (let i = 0; i < N; i++) {
    const at = spot()
    const ids: string[] = []
    for (const dx of [0, 200, 400]) {
      ids.push(await lc(A()).create('rectangle', { x: at.x + dx, y: at.y, width: 150, height: 100 }))
    }
    const [n, m, p] = ids as [string, string, string]
    for (const id of ids) await everywhere(r.browsers, id)
    await allSaved(r.browsers)
    // A groups N and M (Ctrl+G, delegated to Excalidraw's group action: one step)
    await lc(A()).select([n, m])
    await focusCanvas(A())
    await A().keyboard.press('Control+g')
    await everywhere(r.browsers, m, (e) => e.groupIds.length === 1)
    const inner = (await lc(B()).get(n))?.groupIds[0] as string
    await allSaved(r.browsers)
    // B groups that group with P
    await lc(B()).select([n, m, p])
    await focusCanvas(B())
    await B().keyboard.press('Control+g')
    await everywhere(r.browsers, p, (e) => e.groupIds.length === 1)
    const outer = (await lc(B()).get(p))?.groupIds[0] as string
    await allSaved(r.browsers)
    await undo(A())
    for (const id of [n, m])
      await everywhere(r.browsers, id, (e) => !e.groupIds.includes(inner) && e.groupIds.includes(outer))
    await everywhere(r.browsers, p, (e) => JSON.stringify(e.groupIds) === JSON.stringify([outer]))
    await converge(r)
  }
})

test("U4: A's move is undone; B's recolour stays", async () => {
  for (let i = 0; i < N; i++) {
    const n = await rect(A())
    const before = await lc(A()).get(n)
    await lc(A()).update(n, { x: (before?.x ?? 0) + 120, y: (before?.y ?? 0) + 40 })
    await everywhere(r.browsers, n, (e) => e.x === (before?.x ?? 0) + 120)
    await allSaved(r.browsers)
    await lc(B()).update(n, { strokeColor: '#e03131' })
    await everywhere(r.browsers, n, (e) => e.strokeColor === '#e03131')
    await allSaved(r.browsers)
    await undo(A())
    await everywhere(
      r.browsers,
      n,
      (e) => e.x === before?.x && e.y === before?.y && e.strokeColor === '#e03131',
    )
    await converge(r)
  }
})

test('U5: same field, B later: A sees "1 change kept"', async () => {
  for (let i = 0; i < N; i++) {
    const n = await rect(A())
    await lc(A()).update(n, { backgroundColor: '#ffc9c9' })
    await everywhere(r.browsers, n, (e) => e.backgroundColor === '#ffc9c9')
    await allSaved(r.browsers)
    await lc(B()).update(n, { backgroundColor: '#a5d8ff' })
    await everywhere(r.browsers, n, (e) => e.backgroundColor === '#a5d8ff')
    await allSaved(r.browsers)
    await undo(A())
    await expect.poll(async () => (await toasts(A())).some((t) => /1 change kept/.test(t))).toBe(true)
    expect((await lc(B()).get(n))?.backgroundColor).toBe('#a5d8ff')
    await converge(r)
  }
})

test('U6: a deleted element is never resurrected by an undo or a redo', async () => {
  for (let i = 0; i < N; i++) {
    const n = await rect(A())
    await lc(B()).delete(n)
    await everywhere(r.browsers, n, (e) => e.isDeleted === true)
    await allSaved(r.browsers)
    await undo(A())
    await undo(A(), true)
    await allSaved(r.browsers)
    for (const b of r.browsers) expect((await lc(b.page).get(n))?.isDeleted ?? true).toBe(true)
    const snap = await harness.readSnapshot(r.stack, r.boardId)
    expect(snap.elements.find((e) => e.id === n)?.isDeleted).toBe(true)
    await converge(r)
  }
})

test("U7: a frame drag is undone except where someone moved a child since; child 1 keeps B's colour", async () => {
  for (let i = 0; i < N; i++) {
    const at = spot()
    const f = await lc(A()).create('frame', { x: at.x, y: at.y, width: 460, height: 320, name: 'F' })
    const kids: string[] = []
    for (let k = 0; k < 6; k++)
      kids.push(
        await lc(A()).create('rectangle', {
          x: at.x + 20 + (k % 3) * 145,
          y: at.y + 30 + Math.floor(k / 3) * 140,
          width: 120,
          height: 100,
          frameId: f,
        }),
      )
    for (const id of [f, ...kids]) await everywhere(r.browsers, id)
    await allSaved(r.browsers)
    const before = new Map<string, { x: number; y: number }>()
    for (const id of kids) {
      const e = await lc(A()).get(id)
      before.set(id, { x: e?.x ?? 0, y: e?.y ?? 0 })
    }
    // A drags the frame (Excalidraw moves its children with it)
    await show(A(), [f])
    await lc(A()).select([f])
    // a frame is dragged by its border or its name (not its inside): its left edge, between two children
    const grab = await screenOf(A(), { x: at.x, y: at.y + 150 })
    await A().mouse.move(grab.x, grab.y)
    await A().mouse.down()
    for (let s = 1; s <= 10; s++) await A().mouse.move(grab.x + s * 10, grab.y + s * 6)
    await A().mouse.up()
    const k0 = kids[0] as string
    await everywhere(r.browsers, k0, (e) => e.x !== before.get(k0)?.x)
    await allSaved(r.browsers)
    const moved = await lc(A()).get(k0)
    const dx = (moved?.x ?? 0) - (before.get(k0)?.x ?? 0)
    expect(dx).not.toBe(0)
    // B recolours child 1, C moves child 2
    const k1 = kids[1] as string
    const k2 = kids[2] as string
    await lc(B()).update(k1, { backgroundColor: '#b2f2bb' })
    const c2 = await lc(C()).get(k2)
    await lc(C()).update(k2, { x: (c2?.x ?? 0) + 33, y: (c2?.y ?? 0) + 7 })
    await everywhere(r.browsers, k2, (e) => e.x === (c2?.x ?? 0) + 33)
    await allSaved(r.browsers)
    await undo(A())
    for (const id of kids) {
      if (id === k2)
        await everywhere(r.browsers, id, (e) => e.x === (c2?.x ?? 0) + 33 && e.y === (c2?.y ?? 0) + 7)
      else await everywhere(r.browsers, id, (e) => e.x === before.get(id)?.x && e.y === before.get(id)?.y)
    }
    expect((await lc(C()).get(k1))?.backgroundColor).toBe('#b2f2bb')
    await converge(r)
  }
})

test('U8: selection changes are never steps', async () => {
  for (let i = 0; i < N; i++) {
    const n = await rect(A())
    const m = await rect(A())
    const before = await lc(A()).get(n)
    await lc(A()).update(n, { x: (before?.x ?? 0) + 50 })
    await allSaved(r.browsers)
    for (let k = 0; k < 10; k++) {
      await lc(A()).select(k % 2 ? [] : [m])
      await A().waitForTimeout(20)
    }
    await undo(A())
    await everywhere(r.browsers, n, (e) => e.x === before?.x)
    await converge(r)
  }
})

test('U9: two steps inside one round trip (300 ms latency) undo one at a time', async () => {
  const hooks = harness.testHooks(r.stack)
  for (let i = 0; i < N; i++) {
    const n = await rect(A())
    const before = await lc(A()).get(n)
    const off = await hooks.withLatency(A(), 300)
    try {
      await lc(A()).update(n, { strokeColor: '#1971c2' })
      await lc(A()).update(n, { x: (before?.x ?? 0) + 80 })
      // both before the first ack: two entries (recorded against lastLocal)
      await undo(A())
      await everywhere(r.browsers, n, (e) => e.x === before?.x && e.strokeColor === '#1971c2')
      await undo(A())
      await everywhere(r.browsers, n, (e) => e.x === before?.x && e.strokeColor === before?.strokeColor)
    } finally {
      await off()
    }
    await converge(r)
  }
})

test('U10: fixes and repairs create no step and no "change kept"', async () => {
  for (let i = 0; i < N; i++) {
    const at = spot()
    const size0 = await board(A(), (b) => b.undo.history.undoSize as number)
    const t0 = (await toasts(A())).length
    // 1. a stroke with the pen, unrounded points: the server rounds them (fix)
    await board(A(), (b, a) => b.port.viewport.set({ x: a.x - 50, y: a.y - 50, zoom: 1 }), at)
    await lc(A()).setTool('freedraw')
    const p0 = await screenOf(A(), { x: at.x + 10.123, y: at.y + 10.456 })
    await A().mouse.move(p0.x, p0.y)
    await A().mouse.down()
    for (let s = 1; s <= 12; s++) await A().mouse.move(p0.x + s * 7.37, p0.y + Math.sin(s) * 11.11)
    await A().mouse.up()
    await lc(A()).setTool('select')
    await waitSaved(A())
    // 2. an arrow bound to a note B deletes: the room nulls the binding (a repair)
    const target = await rect(A(), {})
    const arrowId = await lc(A()).create('arrow', {
      x: at.x + 300,
      y: at.y + 200,
      points: [
        [0, 0],
        [120, 0],
      ],
      endBinding: { elementId: target, fixedPoint: [0, 0.5], mode: 'orbit' },
    })
    await lc(B()).delete(target)
    await everywhere(r.browsers, arrowId)
    await allSaved(r.browsers)
    const size1 = await board(A(), (b) => b.undo.history.undoSize as number)
    // A's real actions since size0: the stroke, the target, the arrow (3); a fix never adds one
    expect(size1 - size0).toBeLessThanOrEqual(3)
    for (let k = 0; k < size1 - size0; k++) await undo(A())
    expect((await toasts(A())).slice(t0).filter((t) => /kept/.test(t))).toEqual([])
    await converge(r)
  }
})

test('U11: the life-version check: a redo never revives what someone deleted again', async () => {
  for (let i = 0; i < N; i++) {
    const x = await rect(A())
    await undo(A()) // A deletes X by an undo of its create
    await everywhere(r.browsers, x, (e) => e.isDeleted === true)
    await lc(B()).update(x, { isDeleted: false }) // B restores X
    await everywhere(r.browsers, x, (e) => e.isDeleted === false)
    await allSaved(r.browsers)
    await lc(C()).delete(x) // C deletes it again
    await everywhere(r.browsers, x, (e) => e.isDeleted === true)
    await allSaved(r.browsers)
    const before = await pushCount(A())
    await undo(A(), true) // A redoes
    await allSaved(r.browsers)
    for (const b of r.browsers) expect((await lc(b.page).get(x))?.isDeleted ?? true).toBe(true)
    void before
    await converge(r)
  }
})

void centre
