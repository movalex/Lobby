// B3 L1-L5 (docs/EXCALIDRAW-MIGRATION.md §8.3): the text lease blocks and releases visibly. Separate
// Chromium processes (A, B, C) on one board of a real stack (O1's room: the lease table, the FIFO).
// Owner O2; evidence docs/research/excalidraw/spike-b/B3.md.
//
//   L1  A opens the editor on N         → B and C show "A is typing" within 300 ms (p95 over 20)  [timing-gated]
//   L2  on N, which A holds, B tries every editor-open path (Enter; a double-click on N's body; a
//       double-click on N's label (P3b, guard); a printable key; a second click on N's label with N
//       selected (P5); a touch double-tap; a text-tool click on N; a plain double-click on an arrow whose
//       label A holds)                   → no editor stays open, no key lands; toast "A is typing in this
//                                          note"; B pushes 0 ops (8 paths x 20)
//   L3  A types, pauses 30 s, types again, closes → nothing lost: N's text on B and in the snapshot = A's
//   L4  A closes the editor             → the badge is gone on B and C within 1 s; B can now edit N
//   L5  A and B press Enter on the same UNLABELLED note at once → exactly one editor; one label; C sees one badge
//
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b b3-l1-l5   (SPIKE_B3_REPS, default 20)
import { expect, type Page, test } from '@playwright/test'
import { harness } from '../support/harness.ts'
import {
  allSaved,
  board,
  closeEditor,
  converge,
  type EditPath,
  editorState,
  everywhere,
  focusCanvas,
  labelText,
  lc,
  note,
  openEditor,
  pushCount,
  REPS,
  type Room,
  room,
  toasts,
  tryPath,
  waitEditor,
  waitSaved,
  wall,
} from './b3-kit.ts'

const N = REPS('B3', 20)
test.describe.configure({ mode: 'serial' })
test.setTimeout(60 * 60_000)

let r: Room
let slot = 0
const spot = () => {
  const n = slot++
  return { x: (n % 8) * 450, y: Math.floor(n / 8) * 450 }
}
const A = () => r.by.A?.page as Page
const B = () => r.by.B?.page as Page
const C = () => r.by.C?.page as Page

test.beforeAll(async () => {
  // B under touch emulation (L2's double-tap); mouse input still works there
  r = await room(['A', 'B', 'C'], { touch: ['B'] })
})
test.afterAll(async () => {
  await r?.close()
})

const badge = (page: Page, id: string) => page.locator(`[data-testid="typing-badge"][data-lease="${id}"]`)
const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] ?? Number.NaN
}

test('L1: "A is typing" on B and C within 300 ms (p95 over 20)', async () => {
  const lat: { b: number; c: number }[] = []
  for (let i = 0; i < N; i++) {
    const n = await note(A(), r.browsers, spot(), `L1 ${i}`)
    const tB = badge(B(), n.id)
      .waitFor({ state: 'attached', timeout: 10_000 })
      .then(() => wall())
    const tC = badge(C(), n.id)
      .waitFor({ state: 'attached', timeout: 10_000 })
      .then(() => wall())
    await lc(A()).select([n.id])
    await focusCanvas(A())
    const t0 = wall()
    await A().keyboard.press('Enter')
    const [b, c] = await Promise.all([tB, tC])
    lat.push({ b: b - t0, c: c - t0 })
    await waitEditor(A(), (e) => e.phase === 'open')
    await closeEditor(A())
  }
  const bs = lat.map((l) => l.b)
  const cs = lat.map((l) => l.c)
  console.log('B3-L1', JSON.stringify({ n: lat.length, p95B: p95(bs), p95C: p95(cs), lat }))
  expect(p95(bs)).toBeLessThanOrEqual(300)
  expect(p95(cs)).toBeLessThanOrEqual(300)
  await converge(r)
})

test('L2: every editor-open path on a note A holds: no editor on B, the toast, 0 ops', async () => {
  const at = spot()
  const n = await note(A(), r.browsers, at, 'held by A')
  // an arrow with a label, whose label A also holds (its lease id is the arrow)
  const arrowId = await lc(A()).create('arrow', {
    x: at.x,
    y: at.y + 300,
    points: [
      [0, 0],
      [260, 0],
    ],
  })
  await everywhere(r.browsers, arrowId)
  await allSaved(r.browsers)
  const rows: Record<string, unknown>[] = []
  const paths: EditPath[] = [
    'enter',
    'dbl-body',
    'dbl-label',
    'type',
    'p5',
    'double-tap',
    'text-tool',
    'arrow-dbl',
  ]
  for (const path of paths) {
    for (let i = 0; i < N; i++) {
      // A holds N (and the arrow for the arrow path), with its editor open
      const holdId = path === 'arrow-dbl' ? arrowId : n.id
      await board(A(), (b, id) => b.lease.acquire(id), holdId)
      await expect
        .poll(() =>
          lc(B())
            .leaseState()
            .then((s) => s.holders[holdId]?.name ?? null),
        )
        .not.toBeNull()
      const before = await pushCount(B())
      const t0 = (await toasts(B())).length
      await tryPath(B(), path, n, arrowId)
      await B().waitForTimeout(500)
      const e = await editorState(B())
      const after = await pushCount(B())
      const ts = (await toasts(B())).slice(t0)
      const text = await labelText(B(), n.label)
      const ok =
        e.textareas === 0 &&
        e.phase === 'idle' &&
        after === before &&
        ts.some((t) => /is typing in this note/.test(t)) &&
        text === 'held by A'
      rows.push({
        path,
        i,
        ok,
        phase: e.phase,
        textareas: e.textareas,
        ops: after - before,
        toasts: ts,
        text,
      })
      await board(A(), (b, id) => b.lease.release(id), holdId)
      await expect
        .poll(() =>
          lc(B())
            .leaseState()
            .then((s) => s.holders[holdId] ?? null),
        )
        .toBeNull()
      await focusCanvas(B())
      await B().keyboard.press('Escape')
    }
  }
  console.log('B3-L2', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok).slice(0, 10) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
  await converge(r)
})

test('L3: a 30 s pause keeps the lease; nothing is lost', async () => {
  const reps = Math.min(N, Number(process.env.SPIKE_B3_L3_REPS ?? 3))
  for (let i = 0; i < reps; i++) {
    const n = await note(A(), r.browsers, spot(), 'x')
    await openEditor(A(), n.id)
    await A().keyboard.press('End')
    await A().keyboard.type(' before pause')
    await A().waitForTimeout(30_000)
    await A().keyboard.type(' after pause')
    const buffer = await editorState(A()).then((e) => e.value)
    await closeEditor(A())
    await allSaved(r.browsers)
    expect(await labelText(B(), n.label)).toBe(buffer)
    const snap = await harness.readSnapshot(r.stack, r.boardId)
    expect(
      (snap.elements.find((e) => e.id === n.label) as { originalText?: string } | undefined)?.originalText,
    ).toBe(buffer)
    await converge(r)
  }
})

test('L4: the badge goes within 1 s of the close; B can then edit', async () => {
  const lat: number[] = []
  for (let i = 0; i < N; i++) {
    const n = await note(A(), r.browsers, spot(), `L4 ${i}`)
    await openEditor(A(), n.id)
    await badge(B(), n.id).waitFor({ state: 'attached' })
    await badge(C(), n.id).waitFor({ state: 'attached' })
    const goneB = badge(B(), n.id)
      .waitFor({ state: 'detached', timeout: 10_000 })
      .then(() => wall())
    const goneC = badge(C(), n.id)
      .waitFor({ state: 'detached', timeout: 10_000 })
      .then(() => wall())
    const t0 = wall()
    await A().keyboard.press('Escape')
    const [b, c] = await Promise.all([goneB, goneC])
    lat.push(Math.max(b, c) - t0)
    await openEditor(B(), n.id)
    await B().keyboard.press('End')
    await B().keyboard.type('!')
    await closeEditor(B())
    await expect.poll(() => labelText(A(), n.label)).toBe(`L4 ${i}!`)
  }
  console.log('B3-L4', JSON.stringify({ n: lat.length, max: Math.max(...lat), lat }))
  expect(Math.max(...lat)).toBeLessThanOrEqual(1000)
  await converge(r)
})

test('L5: A and B press Enter on one unlabelled note at once: one editor, one label, one badge on C', async () => {
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < N; i++) {
    const n = await note(A(), r.browsers, spot()) // no text: no label
    for (const p of [A(), B()]) {
      await lc(p).select([n.id])
      await focusCanvas(p)
    }
    const barrier = harness.createBarrier(2)
    await Promise.all(
      [A(), B()].map(async (p) => {
        await barrier.arrive()
        await p.keyboard.press('Enter')
      }),
    )
    await A().waitForTimeout(800)
    const ea = await editorState(A())
    const eb = await editorState(B())
    const open = [ea, eb].filter((e) => e.phase === 'open').length
    const cBadges = await badge(C(), n.id).count()
    const writer = ea.phase === 'open' ? A() : B()
    await writer.keyboard.type('one')
    await closeEditor(writer)
    await allSaved(r.browsers)
    const snap = await harness.readSnapshot(r.stack, r.boardId)
    const labels = snap.elements.filter(
      (e) => (e as { containerId?: string }).containerId === n.id && !e.isDeleted,
    )
    const container = snap.elements.find((e) => e.id === n.id) as {
      boundElements?: { type: string }[] | null
    }
    const texts = (container?.boundElements ?? []).filter((b) => b.type === 'text').length
    rows.push({ i, open, cBadges, labels: labels.length, texts })
    await converge(r)
  }
  console.log('B3-L5', JSON.stringify(rows))
  expect(rows.filter((x) => x.open !== 1 || x.cBadges !== 1 || x.labels !== 1 || x.texts !== 1)).toEqual([])
})

void waitSaved
