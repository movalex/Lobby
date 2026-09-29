// B5 R1 (docs/EXCALIDRAW-MIGRATION.md §8.3): a viewer's raw socket (its own ticket) sends a create, a
// patch, a delete, a `doc` write, a `lease.acquire` and a presence message with a `drag` of 5 live ids.
// Pass: READ_ONLY per op and a lease deny; the socket stays open; the snapshot is unchanged; the editor sees
// no element change and no drag preview (the read-only drag is dropped, §2.7). Presence flows for every
// read-only role: the viewer's, a commenter's and a limited guest's cursors, moved over the canvas with no
// tool selected, reach the editor within 200 ms p95. Owner: O1.
//
// TIMING-GATED (§8.6.4): the 200 ms p95 part runs only in the lead's quiet window; outside it the latency is
// recorded and not asserted (SPIKE_B_QUIET=1 asserts it).

import { expect, test } from '@playwright/test'
import type {} from '../../../apps/web/src/canvas/test-facade.types.ts' // window.lobbyCanvas
import { harness } from '../support/harness.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'
import { codes, forge, rectEl } from './b6-forge-kit.ts'

let stack: SpikeBStack
let E: BrowserProcess
let V: BrowserProcess
let C: BrowserProcess
let boardId: string

test.beforeAll(async () => {
  stack = await harness.startStack()
  const ue = harness.devUser('r1-editor')
  const uv = harness.devUser('r1-viewer')
  const uc = harness.devUser('r1-commenter')
  ;({ boardId } = await stack.createBoard({
    owner: ue,
    members: [
      { user: uv, role: 'viewer' },
      { user: uc, role: 'commenter' },
    ],
  }))
  E = await harness.launchBrowser(stack, ue, { name: 'editor' })
  V = await harness.launchBrowser(stack, uv, { name: 'viewer' })
  C = await harness.launchBrowser(stack, uc, { name: 'commenter' })
  for (const p of [E, V, C]) await p.openBoard(boardId)
})
test.afterAll(async () => {
  for (const p of [E, V, C]) await p?.close()
  await stack?.stop()
})

test('R1: forged writes from a viewer are READ_ONLY; its drag never reaches the editor', async () => {
  const ids = await E.page.evaluate(() =>
    [0, 1, 2, 3, 4].map(
      (i) => window.lobbyCanvas?.create('rectangle', { x: i * 120, y: 0, width: 100, height: 80 }) ?? '',
    ),
  )
  await expect.poll(() => E.page.evaluate(() => window.lobbyCanvas?.saveState().state)).toBe('saved')
  const pushLog = await harness.recordPushes(E.page)
  const before = await harness.readSnapshot(stack, boardId)
  const target = before.elements.find((e) => e.id === ids[0]) as { version: number }
  const editorSide = await forge(E.page, boardId) // watches what the editor is sent
  const v = await forge(V.page, boardId)
  expect(v.welcome.readonly).toBe(true)
  const ack = await v.push(
    [
      { k: 'c', el: rectEl('r1-forged') },
      { k: 'p', id: ids[0], pv: target.version, g: { pos: { x: 999, y: 999 } } },
      { k: 'p', id: ids[1], pv: target.version, g: { life: { isDeleted: true } } },
    ],
    { doc: { set: { 'tagDef:forged': { name: 'forged', color: 'red' } } } },
  )
  expect(codes(ack)).toEqual(['READ_ONLY', 'READ_ONLY', 'READ_ONLY'])
  expect(ack.docDenied).toMatchObject({ code: 'READ_ONLY' })
  await v.send({ type: 'lease.acquire', req: 1, id: ids[0] as string })
  expect((await v.socket.next('lease.deny')).id).toBe(ids[0])
  await v.send({
    type: 'presence',
    pointer: { x: 10, y: 10 },
    button: 'down',
    sel: [],
    view: null,
    idle: false,
    editing: null,
    drag: { d: 1, ids: ids as string[], dx: 40, dy: 40 },
  })
  await E.page.waitForTimeout(500)
  const drags = (await editorSide.socket.messages()).flatMap((m) =>
    m.type === 'presence' ? (m.drags ?? []) : [],
  )
  expect(drags).toEqual([])
  const after = await harness.readSnapshot(stack, boardId)
  expect(after.hash).toBe(before.hash)
  expect(await pushLog.count()).toBe(0) // the editor pushed nothing in reaction
  // the viewer's socket is still open
  await v.send({ type: 'ping', n: 1 })
  await v.socket.next('pong')
})

/** 20 real pointer moves over `p`'s canvas (no tool selected); ms until the editor's socket gets each one. */
async function presenceLatency(p: BrowserProcess): Promise<number[]> {
  const editorSide = await forge(E.page, boardId)
  const uid = (await forge(p.page, boardId)).welcome.you.uid // the page's user (its own session id is its tab's)
  const box = await p.page.locator('canvas').last().boundingBox()
  if (!box) throw new Error('no canvas')
  const out: number[] = []
  for (let i = 0; i < 20; i++) {
    const seenBefore = (await editorSide.socket.messages()).length
    const t0 = Date.now()
    await p.page.mouse.move(box.x + 50 + i * 7, box.y + 60 + (i % 5) * 9)
    await expect
      .poll(async () =>
        (await editorSide.socket.messages())
          .slice(seenBefore)
          .some(
            (m) =>
              m.type === 'presence' &&
              m.peers.some(
                (q) => q.sid.startsWith(`${uid}:`) && !q.sid.includes(':forge-') && q.pointer !== null,
              ),
          ),
      )
      .toBe(true)
    out.push(Date.now() - t0)
    await p.page.waitForTimeout(60)
  }
  await editorSide.socket.close()
  return out
}
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] ?? Number.NaN

test('R1: presence of the viewer and the commenter reaches the editor (p95 ≤ 200 ms in the quiet window)', async () => {
  const summary: Record<string, number> = {}
  for (const p of [V, C]) summary[p.name] = p95(await presenceLatency(p))
  test.info().annotations.push({ type: 'R1-presence-p95-ms', description: JSON.stringify(summary) })
  console.log('[evidence] R1-presence-p95-ms', JSON.stringify(summary))
  if (process.env.SPIKE_B_QUIET === '1')
    for (const v of Object.values(summary)) expect(v).toBeLessThanOrEqual(200)
})

test("R1: a limited guest's presence reaches the editor (p95 ≤ 200 ms in the quiet window)", async () => {
  let G: BrowserProcess | null = null
  try {
    G = await harness.launchBrowser(stack, harness.devUser('r1-guest'), { name: 'guest', guest: true })
  } catch (e) {
    // the harness signs guests in through O5's A3 flow; until it can, this part is NOT RUN (never a pass)
    test.skip(
      /not available/.test(String((e as Error)?.message)),
      `guest sign-in unavailable: ${(e as Error)?.message}`,
    )
    throw e
  }
  try {
    await G.openBoard(boardId)
    const ms = p95(await presenceLatency(G))
    test.info().annotations.push({ type: 'R1-presence-p95-ms', description: JSON.stringify({ guest: ms }) })
    console.log('[evidence] R1-presence-p95-ms', JSON.stringify({ guest: ms }))
    if (process.env.SPIKE_B_QUIET === '1') expect(ms).toBeLessThanOrEqual(200)
  } finally {
    await G.close()
  }
})
