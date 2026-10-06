// Wave J (J6b): two browser checks the backlog listed as covered in Node only (docs/BACKLOG.md RCPT-2, DRAG-1),
// on spike B's board page (the engine core, the browser socket, IndexedDB; the same core as Lobby's board
// page), separate Chromium processes on a real stack (O1's room: COMMIT before ack, push receipts).
//
//  RCPT-2  A push that landed, whose ack was lost, with someone writing after it: A moves X; the relay drops
//          every frame the server sends A (its ack, the room's changes); B moves X twice; A's socket is cut and
//          restored. A's reconnect asks its receipts (CONTRACTS_REV 11): the push landed, so A does not send it
//          again, and the later write stands. The Node twin is apps/sync/test/element-room/receipt-gap.test.ts's
//          last case and apps/web/src/canvas/sync/core/receipts.test.ts.
//  DRAG-1  A drag held on an element the server moved and someone created over: A drags Y with the mouse and
//          holds it; meanwhile B (a raw socket of B's page) sends Y to the back and creates Z on the key Y had.
//          A drops. The create stays the server's (A never pushes Z, no `echo_suspect`), A's drop pushes only
//          the move, and Y ends at the back on the server's key. The Node twin is
//          apps/web/src/canvas/sync/core/inflight-key-echo.test.ts's last case (D2).
//
// Run: SPIKE_B_PORT_BASE=7540 pnpm --filter @draftroom/e2e spike-b j6-receipts-drag
import { expect, test } from '@playwright/test'
import type { O3BrowserProcess } from '../support/browsers.ts'
import { allSaved, centreOf, everywhere } from '../support/checks.ts'
import { canvasOf, closeAllBrowsers, forgeSession, harness, waitElement } from '../support/harness.ts'
import { cut, dropDown, restore } from '../support/relay.ts'
import type { O3Stack } from '../support/stack.ts'

test.describe.configure({ mode: 'serial' })
test.setTimeout(10 * 60_000)

let stack: O3Stack
let A: O3BrowserProcess
let B: O3BrowserProcess
let boardId: string

test.beforeAll(async () => {
  stack = await harness.startStack()
  A = await harness.launchBrowser(stack, harness.devUser('A'), { name: 'A' })
  B = await harness.launchBrowser(stack, harness.devUser('B'), { name: 'B' })
  ;({ boardId } = await stack.createBoard({
    owner: A.user,
    members: [{ user: B.user, role: 'editor' }],
    title: 'J6 receipts and drag',
  }))
  for (const b of [A, B]) await b.openBoard(boardId)
})

test.afterAll(async () => {
  await closeAllBrowsers()
  await stack?.stop()
})

type Stored = { id: string; x: number; index: string; version: number; isDeleted: boolean }
const stored = async (id: string): Promise<Stored> => {
  const snap = await harness.readSnapshot(stack, boardId)
  const el = snap.elements.find((e) => e.id === id) as unknown as Stored | undefined
  if (!el) throw new Error(`${id} is not on the server`)
  return el
}

/** The engine core's `echo_suspect` events of page `p` from now on (the ids it re-keyed in place). */
async function watchEchoes(p: O3BrowserProcess): Promise<() => Promise<string[][]>> {
  await p.page.evaluate(() => {
    const w = window as unknown as {
      __j6Echo?: string[][]
      __lobbyBoard?: { core?: { on(l: (e: { kind: string; ids?: readonly string[] }) => void): () => void } }
    }
    w.__j6Echo = []
    w.__lobbyBoard?.core?.on((e) => {
      if (e.kind === 'echo_suspect') w.__j6Echo?.push([...(e.ids ?? [])])
    })
  })
  return () => p.page.evaluate(() => [...((window as unknown as { __j6Echo?: string[][] }).__j6Echo ?? [])])
}

test('RCPT-2: a push that landed with its ack lost is not sent again over the writes made after it', async () => {
  const a = canvasOf(A.page)
  const b = canvasOf(B.page)
  const X = await a.create('rectangle', { x: 0, y: 0, width: 160, height: 100 })
  await everywhere([A, B], X)
  await allSaved([A, B])
  const aPushes = await harness.recordPushes(A.page)
  // from here the room's answers to A are lost: its ack, and the changes frames
  dropDown(A.page, true)
  await a.update(X, { x: 111 })
  // it landed: B sees it
  await waitElement(B.page, X, (el) => (el as { x?: number } | null)?.x === 111)
  expect((await aPushes.byElement(X)).length, 'A pushed its move once').toBe(1)
  // B writes after it, twice
  for (const x of [222, 333]) {
    await b.update(X, { x })
    await allSaved([B])
  }
  expect((await stored(X)).x).toBe(333)
  const dropped = dropDown(A.page, false)
  expect(dropped, 'the ack of the move never reached A').toContain('ack')
  // A's socket goes down (the page sees a server restart) and comes back: hello, the catch-up, its receipts
  await cut(A.page)
  await restore(A.page)
  await allSaved([A], 60_000)
  // the later write stands, everywhere; A never sent its move again
  await waitElement(A.page, X, (el) => (el as { x?: number } | null)?.x === 333)
  expect((await stored(X)).x, 'the later write stands').toBe(333)
  expect((await aPushes.byElement(X)).length, 'nothing sent again').toBe(1)
  const report = await harness.converged(stack, boardId, [A, B])
  expect(report.ok, JSON.stringify(report.hashes)).toBe(true)
})

test('DRAG-1: a drag held on an element moved to the back and created over: the create stays, the drop pushes only the move', async () => {
  const a = canvasOf(A.page)
  // filled: a transparent rectangle is hit on its outline only, and the drag starts at the centre
  const fill = { backgroundColor: '#ffec99', fillStyle: 'solid' }
  const S = await a.create('rectangle', { x: 400, y: 0, width: 200, height: 120, ...fill })
  const Y = await a.create('rectangle', { x: 700, y: 0, width: 200, height: 120, ...fill })
  await everywhere([A, B], Y)
  await allSaved([A, B])
  const s0 = await stored(S)
  const y0 = await stored(Y)
  // the key below S that "send to back" gives (Excalidraw's keys: the first integer key is a0, Zz is below it)
  const back = 'Zz'
  expect(back < s0.index && s0.index < y0.index, `${back} < ${s0.index} < ${y0.index}`).toBe(true)
  const echoes = await watchEchoes(A)
  const aPushes = await harness.recordPushes(A.page)
  const bPushes = await harness.recordPushes(B.page)
  // A drags Y with the mouse and holds it (the gesture holds its copy)
  await a.fit([S, Y])
  const c = await centreOf(A, Y)
  await A.page.mouse.move(c.x, c.y)
  await A.page.mouse.down()
  for (let s = 1; s <= 6; s++) await A.page.mouse.move(c.x + s * 10, c.y + s * 4)
  // B, on a raw socket of its own page: Y to the back, then a create on the key Y had
  const { socket, welcome } = await forgeSession(B.page, boardId)
  await socket.send({
    type: 'push',
    seq: 1,
    base: welcome.clock,
    ops: [{ k: 'p', id: Y, pv: y0.version, g: { z: { index: back } } }],
  })
  const moved = await socket.next('ack')
  expect(moved.r[0], 'Y to the back').toMatchObject({ ok: true })
  const snap = await harness.readSnapshot(stack, boardId)
  const yNow = snap.elements.find((e) => e.id === Y) as unknown as Record<string, unknown>
  const Z = `j6z${Date.now().toString(36)}`
  const { customData, ...rest } = yNow
  const lobby = (customData as { lobby?: unknown } | undefined)?.lobby
  const z = {
    ...rest,
    id: Z,
    index: y0.index,
    x: 1_200,
    y: 400,
    version: 1,
    versionNonce: 22,
    boundElements: null,
    groupIds: [],
    ...(lobby ? { customData: { lobby } } : {}),
  }
  await socket.send({ type: 'push', seq: 2, base: moved.clock, ops: [{ k: 'c', el: z as never }] })
  const created = await socket.next('ack')
  expect(created.r[0], 'Z created on the key Y had').toMatchObject({ ok: true })
  await socket.close()
  // the server's copy of Z as created (the room stamps its author: its version is the server's)
  const z0 = await stored(Z)
  expect(z0.index).toBe(y0.index)
  await waitElement(A.page, Z, (el) => !!el && !(el as { isDeleted?: boolean }).isDeleted)
  // A goes on dragging, then drops
  for (let s = 7; s <= 12; s++) await A.page.mouse.move(c.x + s * 10, c.y + s * 4)
  await A.page.mouse.up()
  await allSaved([A, B])
  // the create is the server's, untouched; nobody's page pushed anything of it, no echo
  const zStored = await stored(Z)
  const diag = JSON.stringify({
    z: zStored,
    aZ: await aPushes.byElement(Z),
    bZ: await bPushes.byElement(Z),
    aY: await aPushes.byElement(Y),
    echoes: await echoes(),
  })
  expect.soft(await aPushes.byElement(Z), `A never wrote Z: ${diag}`).toEqual([])
  expect.soft(await bPushes.byElement(Z), `B's page never wrote Z: ${diag}`).toEqual([])
  expect.soft(await echoes(), `no echo (an element re-keyed in place): ${diag}`).toEqual([])
  expect(zStored, diag).toEqual(z0)
  // the drop pushed only the move; Y is at the back, on the server's key, where A dropped it
  const yOps = await aPushes.byElement(Y)
  expect(yOps.length, 'the drop pushed Y').toBeGreaterThan(0)
  for (const op of yOps) {
    expect(op.k, 'a patch').toBe('p')
    expect(Object.keys((op as { g?: Record<string, unknown> }).g ?? {}), 'only the move').toEqual(['pos'])
  }
  const yStored = await stored(Y)
  expect(yStored.index, 'Y at the back').toBe(back)
  expect(yStored.x, 'Y moved').toBeGreaterThan(y0.x)
  const report = await harness.converged(stack, boardId, [A, B])
  expect(report.ok, JSON.stringify(report.hashes)).toBe(true)
})
