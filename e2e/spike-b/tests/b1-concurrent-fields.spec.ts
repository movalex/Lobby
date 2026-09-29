// B1 (docs/EXCALIDRAW-MIGRATION.md §8.3): concurrent edits to different fields of the same note both
// survive. Three SEPARATE Chromium processes (A, B, C), each a different dev user, on one board of a real
// stack; the simultaneous actions are released together (the facade writes armed in their pages for one
// instant, runTogether; the pointer-up of a real drag and A's write by one barrier, releaseTogether); a
// repetition whose release spread is over 20 ms is not counted and is repeated. After every repetition:
// every map (tombstones included) hashes equal to the test snapshot and the invariant checker finds
// nothing (closeWindow), and the receiving-only browser's pushes go to B10's evidence.
//
//   B1.1 A, B     A recolours N while B drags N            → A's colour and B's position everywhere
//   B1.2 A, B, C  A tags N #x, B adds a +1, C moves N      → all three kept
//   B1.3 A, B, C  A changes N's font size, B its fill, C groups N with M → all three kept
//   B1.4 A, B     A deletes N while B moves N              → N deleted everywhere (delete wins, both orders)
//
// 20 repetitions per case (SPIKE_B1_REPS), 3 runs (SPIKE_B_RUN=1..3, each a fresh build). Timing-gated:
// runs only in the lead's quiet window (§8.6.4). Needs M1 (O1's room, O2's board page) and, for B1.2, the
// tag and +1 keys (custom-data.ts) accepted by O1's room; the tag's `tagDef:x` doc key is written once by
// a forged session (setup, not the action under test).
import { expect, test } from '@playwright/test'
import type { O3BrowserProcess } from '../support/browsers.ts'
import {
  allSaved,
  centreOf,
  closeWindow,
  everywhere,
  openWindow,
  unlessHorizonMoved,
  writeEvidence,
} from '../support/checks.ts'
import {
  canvasOf,
  closeAllBrowsers,
  forgeSession,
  harness,
  releaseTogether,
  runTogether,
  writePushEvidence,
} from '../support/harness.ts'
import type { O3Stack } from '../support/stack.ts'

const REPS = Number(process.env.SPIKE_B1_REPS ?? 20)
const MAX_SPREAD_MS = 20
test.describe.configure({ mode: 'serial' })
test.setTimeout(30 * 60_000)

let stack: O3Stack
let A: O3BrowserProcess
let B: O3BrowserProcess
let C: O3BrowserProcess
let boardId: string
let slot = 0

test.beforeAll(async () => {
  stack = await harness.startStack()
  A = await harness.launchBrowser(stack, harness.devUser('A'), { name: 'A' })
  B = await harness.launchBrowser(stack, harness.devUser('B'), { name: 'B' })
  C = await harness.launchBrowser(stack, harness.devUser('C'), { name: 'C' })
  ;({ boardId } = await stack.createBoard({
    owner: A.user,
    members: [
      { user: B.user, role: 'editor' },
      { user: C.user, role: 'editor' },
    ],
    title: 'B1',
  }))
  for (const b of [A, B, C]) await b.openBoard(boardId)
  // setup for B1.2: the board's tag list gets `x` (a doc key the tag chip reads); a raw push, not the action under test
  const { socket, welcome } = await forgeSession(A.page, boardId)
  await socket.send({
    type: 'push',
    seq: 1,
    base: welcome.clock,
    ops: [],
    doc: { set: { 'tagDef:x': { name: 'x', color: 'blue' } } },
  })
  const ack = await socket.next('ack')
  expect(ack.docDenied, 'tagDef:x accepted').toBeUndefined()
  await socket.close()
})

test.afterAll(async () => {
  await closeAllBrowsers()
  await stack?.stop()
})

/** A fresh note on its own spot, seen by all three and saved. */
async function newNote(text = ''): Promise<string> {
  const n = slot++
  const id = await canvasOf(A.page).create('note', {
    x: (n % 20) * 400,
    y: Math.floor(n / 20) * 400,
    ...(text ? { text } : {}),
  })
  await everywhere([A, B, C], id)
  await allSaved([A, B, C])
  return id
}

type Rep = { rep: number; tries: number; spreadMs: number; ok: boolean; note?: string }

/** Runs one repetition, repeating it (at most 3 tries) when the release spread is over 20 ms. */
async function rep(i: number, body: () => Promise<{ spreadMs: number }>): Promise<Rep> {
  for (let tries = 1; ; tries++) {
    const { spreadMs } = await unlessHorizonMoved(body)
    if (spreadMs <= MAX_SPREAD_MS) return { rep: i, tries, spreadMs, ok: true }
    if (tries >= 3)
      return { rep: i, tries, spreadMs, ok: false, note: `release spread ${spreadMs} ms > ${MAX_SPREAD_MS}` }
  }
}

test("B1.1: A recolours N while B drags N: A's colour and B's position survive", async () => {
  const testInfo = test.info()
  const reps: Rep[] = []
  for (let i = 0; i < REPS; i++) {
    reps.push(
      await rep(i, async () => {
        const N = await newNote()
        const w = await openWindow(stack, boardId)
        const cPushes = await harness.recordPushes(C.page)
        const before = await canvasOf(B.page).get(N)
        await canvasOf(B.page).fit([N])
        const c = await centreOf(B, N)
        await B.page.mouse.move(c.x, c.y)
        await B.page.mouse.down()
        for (let s = 1; s <= 10; s++) await B.page.mouse.move(c.x + s * 12, c.y + s * 6)
        const colour = i % 2 ? '#9fd4ff' : '#ff9f9f'
        const r = await releaseTogether([
          { name: 'A recolour', run: () => canvasOf(A.page).update(N, { backgroundColor: colour }) },
          { name: 'B pointer-up', run: () => B.page.mouse.up() },
        ])
        await allSaved([A, B, C])
        const report = await closeWindow(stack, boardId, [A, B, C], w)
        const stored = report.snapshot.elements.find((e) => e.id === N)
        expect(stored?.backgroundColor).toBe(colour)
        expect(stored?.x).not.toBe(before?.x)
        expect(stored?.x).toBe((await canvasOf(B.page).get(N))?.x)
        const ev = await writePushEvidence(testInfo, 'C', cPushes)
        expect(ev.ops, 'C (receiving only) pushes 0 ops').toBe(0)
        return { spreadMs: r.spreadMs }
      }),
    )
  }
  writeEvidence(testInfo, 'B1.1', { reps })
  expect(reps.filter((r) => !r.ok)).toEqual([])
})

test('B1.2: A tags N, B adds a +1, C moves N: all three kept', async () => {
  const testInfo = test.info()
  const bUid = (await canvasOf(B.page).session()).uid
  expect(bUid).toBeTruthy()
  const reps: Rep[] = []
  for (let i = 0; i < REPS; i++) {
    reps.push(
      await rep(i, async () => {
        const N = await newNote()
        const w = await openWindow(stack, boardId)
        const at = await canvasOf(C.page).get(N)
        const r = await runTogether<{ id: string; uid?: string; x?: number; y?: number }, void>([
          {
            name: 'A tag',
            page: A.page,
            arg: { id: N },
            fn: ({ id }) =>
              window.lobbyCanvas?.update(id, { customData: { 'tag:x': { name: 'x', color: 'blue' } } }),
          },
          {
            name: 'B +1',
            page: B.page,
            arg: { id: N, uid: bUid as string },
            fn: ({ id, uid }) => window.lobbyCanvas?.update(id, { customData: { [`plusOne:${uid}`]: true } }),
          },
          {
            name: 'C move',
            page: C.page,
            arg: { id: N, x: (at?.x as number) + 60, y: (at?.y as number) + 30 },
            fn: ({ id, x, y }) => window.lobbyCanvas?.update(id, { x, y }),
          },
        ])
        await allSaved([A, B, C])
        const report = await closeWindow(stack, boardId, [A, B, C], w)
        const stored = report.snapshot.elements.find((e) => e.id === N) as Record<string, unknown> & {
          customData?: { lobby?: Record<string, unknown> }
        }
        expect(stored.customData?.lobby?.['tag:x']).toEqual({ name: 'x', color: 'blue' })
        expect(stored.customData?.lobby?.[`plusOne:${bUid}`]).toBe(true)
        expect(stored.x).toBe((at?.x as number) + 60)
        return { spreadMs: r.spreadMs }
      }),
    )
  }
  writeEvidence(testInfo, 'B1.2', { reps })
  expect(reps.filter((r) => !r.ok)).toEqual([])
})

test("B1.3: A changes N's font size, B its fill, C groups N with M: all three kept", async () => {
  const testInfo = test.info()
  const reps: Rep[] = []
  for (let i = 0; i < REPS; i++) {
    reps.push(
      await rep(i, async () => {
        const N = await newNote('B1.3')
        const M = await newNote('M')
        const n = await canvasOf(A.page).get(N)
        const m = await canvasOf(A.page).get(M)
        const labelOf = (el: typeof n) =>
          (el?.boundElements as { id: string; type: string }[] | null | undefined)?.find(
            (r) => r.type === 'text',
          )?.id ?? null
        const nLabel = labelOf(n)
        const mLabel = labelOf(m)
        expect(nLabel, 'the note has a label (create with text)').toBeTruthy()
        const g = `g-b13-${i}-${Date.now().toString(36)}`
        const w = await openWindow(stack, boardId)
        const r = await runTogether<{ ids: string[]; g?: string; label?: string }, void>([
          {
            name: 'A font size',
            page: A.page,
            arg: { ids: [], label: nLabel as string },
            fn: ({ label }) =>
              window.lobbyCanvas?.update(label as string, { fontSize: 28, baseFontSize: 28 }),
          },
          {
            name: 'B fill',
            page: B.page,
            arg: { ids: [N] },
            fn: ({ ids }) => window.lobbyCanvas?.update(ids[0] as string, { backgroundColor: '#b8e994' }),
          },
          {
            name: 'C group',
            page: C.page,
            arg: { ids: [N, nLabel, M, mLabel].filter((x): x is string => !!x), g },
            fn: ({ ids, g }) => {
              for (const id of ids) window.lobbyCanvas?.update(id, { groupIds: [g as string] })
            },
          },
        ])
        await allSaved([A, B, C])
        const report = await closeWindow(stack, boardId, [A, B, C], w)
        const get = (id: string) =>
          report.snapshot.elements.find((e) => e.id === id) as Record<string, unknown>
        expect(get(nLabel as string).baseFontSize ?? get(nLabel as string).fontSize).toBe(28)
        expect(get(N).backgroundColor).toBe('#b8e994')
        expect(get(N).groupIds).toEqual([g])
        expect(get(M).groupIds).toEqual([g])
        return { spreadMs: r.spreadMs }
      }),
    )
  }
  writeEvidence(testInfo, 'B1.3', { reps })
  expect(reps.filter((r) => !r.ok)).toEqual([])
})

test('B1.4: A deletes N while B moves N: N is deleted everywhere, in either order', async () => {
  const testInfo = test.info()
  const reps: Rep[] = []
  for (let i = 0; i < REPS; i++) {
    reps.push(
      await rep(i, async () => {
        const N = await newNote()
        const w = await openWindow(stack, boardId)
        const cPushes = await harness.recordPushes(C.page)
        const at = await canvasOf(B.page).get(N)
        // even reps: A's delete first; odd reps: B's move first (40 ms apart, released together)
        const [dA, dB] = i % 2 === 0 ? [0, 40] : [40, 0]
        const r = await runTogether<{ id: string; delay: number; x?: number }, void>([
          {
            name: 'A delete',
            page: A.page,
            arg: { id: N, delay: dA },
            fn: async ({ id, delay }) => {
              if (delay) await new Promise((res) => setTimeout(res, delay))
              window.lobbyCanvas?.delete(id)
            },
          },
          {
            name: 'B move',
            page: B.page,
            arg: { id: N, delay: dB, x: (at?.x as number) + 50 },
            fn: async ({ id, delay, x }) => {
              if (delay) await new Promise((res) => setTimeout(res, delay))
              window.lobbyCanvas?.update(id, { x })
            },
          },
        ])
        await allSaved([A, B, C])
        const report = await closeWindow(stack, boardId, [A, B, C], w)
        expect(report.snapshot.elements.find((e) => e.id === N)?.isDeleted).toBe(true)
        for (const b of [A, B, C])
          expect(
            await canvasOf(b.page)
              .get(N)
              .then((e) => e?.isDeleted ?? true),
          ).toBe(true)
        const ev = await writePushEvidence(testInfo, 'C', cPushes)
        expect(ev.ops, 'C (receiving only) pushes 0 ops').toBe(0)
        return { spreadMs: r.spreadMs }
      }),
    )
  }
  writeEvidence(testInfo, 'B1.4', { reps })
  expect(reps.filter((r) => !r.ok)).toEqual([])
})
