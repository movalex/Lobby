// CONTRACTS_REV 12 stale-client pairs in browsers (wave L, W6; the plan's shared contract 4, a hard gate for the
// sync deploy). bob's board socket is routed so that it meets a rev-11 room: the room's `contracts` frame says 11,
// and a presence message rev 11's strict parse would refuse closes the socket 4099 INVALID_MESSAGE, as a rev-11
// room does. That tab is both pairs:
//  (b) a rev-12 web in a rev-11 room: everything it sends is a rev-11 message (`f` yes, `t` and `trail` never),
//      also with the laser in hand, so its socket is never closed;
//  (a) a socket that never sent `t`, which is what a rev-11 web's is: the real rev-12 room never sends it `t` or
//      `trail` (every presence frame it gets has only rev-11 keys) while alice sweeps her laser.
// Cursors and follow keep working both ways.
import type { Page } from '@playwright/test'
import { CONNECT_URL } from '../spike-b/support/relay.ts'
import { expect, setViewport, test, viewport } from '../tests/support/canvas.ts'
import { colorOf, follow, laserStroke, openTab, pickLaser, sidOf, watchLaser } from './l6-kit.ts'

const IN11 = new Set(['type', 'pointer', 'button', 'sel', 'view', 'idle', 'editing', 'drag', 'f'])
const PEER11 = new Set(['sid', 'pointer', 'button', 'sel', 'view', 'idle', 'editing', 'f'])
const OUT11 = new Set(['type', 'peers', 'off', 'drags', 'followers'])
const VIEW11 = new Set(['x', 'y', 'w', 'h', 'z'])

const extraKeys = (o: Record<string, unknown>, allowed: ReadonlySet<string>) =>
  Object.keys(o).filter((k) => !allowed.has(k))
const viewExtra = (v: unknown) =>
  v && typeof v === 'object' ? extraKeys(v as Record<string, unknown>, VIEW11) : []

interface Rev11Room {
  /** presence messages the tab sent that a rev-11 room refuses */
  readonly refused: string[]
  /** presence messages the tab sent */
  readonly sent: Record<string, unknown>[]
  /** presence frames the room sent the tab, with the keys a rev-11 parse refuses (empty when none) */
  readonly frames: { frame: Record<string, unknown>; extra: string[] }[]
  closed: number | null
}

/** Routes `page`'s board socket through a rev-11 room's eyes (install before the board opens). */
async function rev11Room(page: Page): Promise<Rev11Room> {
  const log: Rev11Room = { refused: [], sent: [], frames: [], closed: null }
  await page.routeWebSocket(CONNECT_URL, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => {
      if (typeof m === 'string' && m.startsWith('{"type":"presence"')) {
        const msg = JSON.parse(m) as Record<string, unknown>
        log.sent.push(msg)
        if (extraKeys(msg, IN11).length || viewExtra(msg.view).length) {
          log.refused.push(m)
          log.closed = 4099
          ws.close({ code: 4099, reason: 'INVALID_MESSAGE' })
          server.close()
          return
        }
      }
      server.send(m)
    })
    server.onMessage((m) => {
      if (typeof m === 'string' && m.startsWith('{"type":"contracts"')) {
        ws.send(JSON.stringify({ type: 'contracts', rev: 11 }))
        return
      }
      if (typeof m === 'string' && m.startsWith('{"type":"presence"')) {
        const frame = JSON.parse(m) as Record<string, unknown>
        const extra = [...extraKeys(frame, OUT11)]
        for (const p of (frame.peers as Record<string, unknown>[]) ?? [])
          extra.push(...extraKeys(p, PEER11), ...viewExtra(p.view))
        log.frames.push({ frame, extra })
      }
      ws.send(m)
    })
    ws.onClose(() => server.close())
    server.onClose(() => ws.close())
  })
  return log
}

const peersOf = (room: Rev11Room, sid: string) =>
  room.frames.flatMap((f) => (f.frame.peers as Record<string, unknown>[]).filter((p) => p.sid === sid))

test('rev-12 web in a rev-11 room, and a rev-11 reader in the rev-12 room: no laser field either way; cursors and follow work', async ({
  browser,
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  let room: Rev11Room | null = null
  const x = await openTab(browser, board, users, 'bob', {
    role: 'editor',
    beforeOpen: async (page) => {
      room = await rev11Room(page)
    },
  })
  const r = room as unknown as Rev11Room
  try {
    const asid = (await sidOf(a.page)) as string
    const xsid = (await sidOf(x.page)) as string
    await expect.poll(() => r.sent.length).toBeGreaterThan(0)

    await test.step('bob follows alice: her view reaches him (rev-10/11 presence)', async () => {
      await setViewport(a.page, { x: 1500, y: 700, zoom: 1 })
      await follow(x.page, asid)
      await expect.poll(() => r.sent.some((m) => m.f === asid)).toBe(true)
      const off = async () => {
        const [av, xv] = await Promise.all([viewport(a.page), viewport(x.page)])
        return Math.round(
          Math.max(
            Math.abs(av.x + av.width / 2 - (xv.x + xv.width / 2)),
            Math.abs(av.y + av.height / 2 - (xv.y + xv.height / 2)),
          ),
        )
      }
      await expect.poll(off, { message: 'bob follows alice' }).toBeLessThanOrEqual(3)
    })

    await test.step('alice sweeps her laser: bob gets her cursor moves and never a laser field', async () => {
      await pickLaser(a.page)
      const watch = await watchLaser(x.page, a.id, 1)
      await laserStroke(a.page)
      await expect.poll(() => peersOf(r, asid).length).toBeGreaterThan(3)
      await a.page.waitForTimeout(400)
      for (const f of r.frames) expect(f.extra, JSON.stringify(f.frame)).toEqual([])
      for (const p of peersOf(r, asid)) {
        expect(p).not.toHaveProperty('t')
        expect(p).not.toHaveProperty('trail')
      }
      // her pointer moved for him (cursors work)
      expect(new Set(peersOf(r, asid).map((p) => JSON.stringify(p.pointer))).size).toBeGreaterThan(2)
      // and his page drew no laser (it never got one)
      expect((await watch.read()).maxPoints).toBe(0)
      await watch.stop()
    })

    await test.step('bob picks the laser too: his tab sends only rev-11 messages (no t), so his socket stays', async () => {
      await setViewport(x.page, { x: 0, y: 0, zoom: 1 })
      await pickLaser(x.page)
      const sentBefore = r.sent.length
      const watch = await watchLaser(a.page, x.id, 1)
      await laserStroke(x.page, { steps: 15 })
      await expect.poll(() => r.sent.length).toBeGreaterThan(sentBefore + 3)
      expect(r.refused).toEqual([])
      expect(r.closed).toBeNull()
      for (const m of r.sent) {
        expect(m).not.toHaveProperty('t')
        expect(m).not.toHaveProperty('trail')
      }
      // alice sees bob's cursor and no laser from him
      await expect(a.page.locator(`[data-testid="cursor"][data-uid="${x.id}"]`)).toBeVisible()
      expect((await watch.read()).maxPoints).toBe(0)
      await watch.stop()
    })

    // both tabs still on their first sessions, the rev-11 socket never closed
    expect(await sidOf(x.page)).toBe(xsid)
    await expect(x.page.getByTestId('conn-status')).not.toHaveAttribute('data-state', /offline|error/)
    expect(await colorOf(a.page, x.id)).toBeTruthy()
  } finally {
    await x.context.close()
  }
})
