// The harness against a real stack (written on O3's branch before M1 against the tldraw sync; since wave 4
// part 2 the stack is the Excalidraw one). It checks the plumbing only:
// processes, sign-in, sharing, separate browser processes, forge sockets with the page's own ticket, the
// relay's latency, cut (held reconnects) and restore, and the test routes' 404 path. The board sockets
// here speak tldraw's protocol; the relay and the forge socket never look inside a frame beyond its type.
import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { closeAllBrowsers, harness } from '../harness.ts'
import { attachRelay, relayStats } from '../relay.ts'
import type { O3Stack } from '../stack.ts'

let stack: O3Stack

test.beforeAll(async () => {
  stack = await harness.startStack()
})
test.afterAll(async () => {
  await closeAllBrowsers()
  await stack?.stop()
})

/** Opens a board socket from inside the page (the page's own ticket, a non-forge session id). */
async function pageSocket(page: Page, boardId: string, tab: string) {
  return page.evaluate(
    async ({ boardId, tab }) => {
      const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/ticket`, { method: 'POST' })
      const { ticket } = (await res.json()) as { ticket: string }
      const url = `${location.origin.replace(/^http/, 'ws')}/connect/${boardId}?${new URLSearchParams({ sessionId: tab, ticket })}`
      const w = window as unknown as {
        __st?: Record<string, { ws: WebSocket; got: { at: number; data: string }[]; closed: number | null }>
      }
      w.__st ??= {}
      const ws = new WebSocket(url)
      const st = { ws, got: [] as { at: number; data: string }[], closed: null as number | null }
      w.__st[tab] = st
      ws.onmessage = (e) => st.got.push({ at: Date.now(), data: String(e.data) })
      ws.onclose = (e) => {
        st.closed = e.code
      }
      await new Promise<void>((r) => {
        ws.onopen = () => r()
        setTimeout(r, 5_000)
      })
      return ws.readyState
    },
    { boardId, tab },
  )
}

/**
 * Round trip through the relay on a fresh socket, ms: a tldraw `connect` with protocol version 1 is
 * refused by the server at once (4099 CLIENT_TOO_OLD), so the send goes up and the close comes down.
 */
async function rttMs(page: Page, boardId: string, tab: string): Promise<number> {
  await pageSocket(page, boardId, tab)
  return page.evaluate(async (tab) => {
    const st = (
      window as unknown as {
        __st: Record<string, { ws: WebSocket; got: { at: number; data: string }[]; closed: number | null }>
      }
    ).__st[tab]
    if (!st) throw new Error('no socket')
    const t0 = Date.now()
    st.ws.send(
      JSON.stringify({ type: 'connect', connectRequestId: 'o3', lastServerClock: 0, protocolVersion: 1 }),
    )
    for (;;) {
      if (st.closed !== null || st.got.length > 0) return Date.now() - t0
      if (Date.now() - t0 > 10_000) throw new Error('no answer')
      await new Promise((r) => setTimeout(r, 2))
    }
  }, tab)
}

test('stack, sharing and two separate browser processes', async () => {
  const a = await harness.launchBrowser(stack, harness.devUser('A'), { name: 'A' })
  const b = await harness.launchBrowser(stack, harness.devUser('B'), { name: 'B' })
  expect(a.browser).not.toBe(b.browser)
  expect(a.pid).not.toBeNull()
  expect(b.pid).not.toBeNull()
  expect(a.pid).not.toBe(b.pid)
  console.log(`O3-SELFTEST browser processes: A pid ${a.pid}, B pid ${b.pid}`)
  const { boardId } = await stack.createBoard({ owner: a.user, members: [{ user: b.user, role: 'viewer' }] })
  expect(boardId).toMatch(/^[A-Za-z0-9_-]+$/)
  // each page gets its own role's ticket through its own session cookie
  for (const [p, role] of [
    [a, 'owner'],
    [b, 'viewer'],
  ] as const) {
    await p.page.goto('/')
    const got = await p.page.evaluate(async (boardId) => {
      const r = await fetch(`/api/boards/${boardId}/ticket`, { method: 'POST' })
      return (await r.json()) as { role: string }
    }, boardId)
    expect(got.role).toBe(role)
  }
  // a forge socket opens with the page's own ticket and its own session id
  const forge = await harness.forgeSocket(a.page, boardId)
  expect(forge.role).toBe('owner')
  expect(forge.tab.startsWith('forge-')).toBe(true)
  await forge.close()
  const c = await forge.closed()
  expect(c.code).toBe(1000)
  await a.close()
  await b.close()
})

test('relay: latency is added each way, a cut closes and holds reconnects, restore lets them through', async () => {
  const a = await harness.launchBrowser(stack, harness.devUser('A'), { name: 'A' })
  const { boardId } = await stack.createBoard({ owner: a.user })
  await a.page.goto('/')
  await attachRelay(a.page) // idempotent: launchBrowser attached it already
  expect(await pageSocket(a.page, boardId, 'relay1')).toBe(1)
  expect(relayStats(a.page).connects).toBe(1)

  const base: number[] = []
  for (let i = 0; i < 5; i++) base.push(await rttMs(a.page, boardId, `base${i}`))
  const hooks = harness.testHooks(stack)
  const off = await hooks.withLatency(a.page, 300)
  const slow: number[] = []
  for (let i = 0; i < 5; i++) slow.push(await rttMs(a.page, boardId, `slow${i}`))
  await off()
  const after = await rttMs(a.page, boardId, 'after')
  const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0
  test.info().annotations.push({
    type: 'relay latency',
    description: `round trip median ${med(base)} ms; with 300 ms: ${med(slow)} ms; after removal ${after} ms`,
  })
  console.log(
    `O3-SELFTEST relay round trip median: ${med(base)} ms; with 300 ms latency: ${med(slow)} ms; after removal: ${after} ms`,
  )
  expect(med(slow) - med(base)).toBeGreaterThanOrEqual(290)
  expect(med(slow) - med(base)).toBeLessThan(400)
  expect(after).toBeLessThan(med(slow))

  // cut: the live socket closes (1012), a reconnect is accepted and held, what it sends is recorded
  await hooks.cutSocket(a.page)
  await expect
    .poll(() =>
      a.page.evaluate(
        () => (window as unknown as { __st: Record<string, { closed: number | null }> }).__st.relay1?.closed,
      ),
    )
    .toBe(1012)
  expect(await pageSocket(a.page, boardId, 'relay2')).toBe(1) // "open" from the page's side, but held
  await a.page.evaluate(() =>
    (window as unknown as { __st: Record<string, { ws: WebSocket }> }).__st.relay2?.ws.send(
      JSON.stringify({ type: 'push', seq: 1 }),
    ),
  )
  await expect.poll(() => relayStats(a.page).framesWhileCut.map((f) => f.type)).toEqual(['push'])
  expect(relayStats(a.page)).toMatchObject({ heldConnects: 1, held: 1, live: 0 })
  // restore with release: false keeps the held socket held (D5); a new socket goes through
  await hooks.restoreSocket(a.page, { release: false })
  expect(relayStats(a.page).held).toBe(1)
  expect(await pageSocket(a.page, boardId, 'relay3')).toBe(1)
  expect(await rttMs(a.page, boardId, 'relay4')).toBeLessThan(250)
  // restore (default) closes the held one, so the page would reconnect now
  await hooks.cutSocket(a.page, { mode: 'refuse' })
  await hooks.restoreSocket(a.page)
  await expect
    .poll(() =>
      a.page.evaluate(
        () => (window as unknown as { __st: Record<string, { closed: number | null }> }).__st.relay2?.closed,
      ),
    )
    .toBe(1012)
  expect(relayStats(a.page).held).toBe(0)
  await a.close()
})

test('the server hooks answer 404 until a room registers them; without the flag they are no-ops', async () => {
  const a = harness.devUser('A')
  const { boardId } = await stack.createBoard({ owner: a })
  await expect(harness.readSnapshot(stack, boardId)).rejects.toThrow(/404/)
  await expect(harness.testHooks(stack).leaseGrant(boardId, { delayMs: 10 })).rejects.toThrow(/HTTP 404/)
  await expect(harness.testHooks(stack).failNextCommits(boardId, 1)).rejects.toThrow(/HTTP 404/)
  const noHooks = { ...stack, testHooks: false }
  await harness.testHooks(noHooks).leaseGrant(boardId, { hold: true }) // no call, no throw
  // and sync ran with backups off and the requested engine
  expect(stack.syncLogs()).not.toMatch(/R2_|offsite backups are on/i)
})
