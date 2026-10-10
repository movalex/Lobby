/**
 * Wave M, W6, against the REAL sync server process (apps/sync/test/harness/element-stack.ts, read-only here: the
 * real `apps/sync/src/server.ts`, whose sources are byte-identical to the deployed 4e4a549's), with the headless
 * client, which runs the browser's engine core:
 *
 *  - M6-3: a warm open from a stale cached copy resumes as a catch-up (its hello names the copy's clock and
 *    epoch; no snapshot frame comes; the welcome is not a reset), and its map hashes equal to the room's test
 *    snapshot; it pushes nothing;
 *  - M6-5: after the room closes every socket 4000 RECONNECT at once (a COMMIT failure reopens the board file,
 *    the same close a restart sends), 20 clients come back spread over at least 2 s, not in one burst, and all
 *    converge.
 */
import { hashElements } from '@draftroom/canvas-schema/hash'
import { describe, expect, it } from 'vitest'
import { elementTicket } from '../../../../../sync/test/harness/element-client.ts'
import { newBoardId, useElementStacks } from '../../../../../sync/test/harness/element-stack.ts'
import { rect } from '../../../../../sync/test/harness/elements.ts'
import { TicketWebSocket } from '../../../../../sync/test/harness/tickets.ts'
import { cacheRecordOf } from '../adapter/snapshot-cache.ts'
import type { WebSocketLike } from '../transport/socket.ts'
import type { SceneElement } from '../types.ts'
import { bump, createLobbyHeadlessClient, type LobbyHeadlessClient } from './index.ts'

const h = useElementStacks()

const until = async (pred: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** A small seeded generator (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('the board cache against the real sync server', () => {
  it('M6-3: a warm open from a stale copy is a catch-up (no snapshot frame) and hashes equal to the room', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.headless({ boardId: b, user: 'alice' })
    a.edit((m) => {
      m.set('r1', rect('r1', { index: 'a0' }) as unknown as SceneElement)
      m.set('r2', rect('r2', { x: 200, index: 'a1' }) as unknown as SceneElement)
      m.set('r3', rect('r3', { x: 400, index: 'a2' }) as unknown as SceneElement)
    })
    a.core.flush()
    await a.saved(20_000)
    const content = a.core.cacheContent()
    if (!content) throw new Error('nothing to cache')
    const record = cacheRecordOf(b, 'alice', content, Date.now())
    if (!record) throw new Error('over budget')
    expect(record.exact).toBe(true)
    expect(record.hash).toBe(await hashElements((await st.snapshot(b)).elements))
    await a.close()

    // bob changes the board while alice's page is closed: a move, a delete, a create
    const bob = await st.headless({ boardId: b, user: 'bob' })
    bob.edit((m) => {
      m.set('r1', bump(m.get('r1') as SceneElement, { x: 999 }))
      m.set('r2', bump(m.get('r2') as SceneElement, { isDeleted: true }))
      m.set('r4', rect('r4', { x: 600, index: 'a3' }) as unknown as SceneElement)
    })
    bob.core.flush()
    await bob.saved(20_000)

    const a2 = await st.headless({ boardId: b, user: 'alice', tab: 'hl-alice-2', connect: false })
    expect(a2.core.startFromCache(record, { resume: true })).toBe(true)
    expect(a2.scene.get('r1')?.x).toBe(0)
    await a2.connect()
    await st.converged(b, [a2, bob])
    const frames = a2.received()
    expect(frames.filter((f) => f.type === 'snapshot'), 'no snapshot frame').toHaveLength(0)
    const welcome = frames.find((f) => f.type === 'welcome') as { reset: boolean; catchUp: unknown[] } | undefined
    expect(welcome?.reset).toBe(false)
    expect(welcome?.catchUp.length).toBe(3)
    expect(a2.core.resumeOutcome).toBe('catch-up')
    expect(a2.scene.get('r1')?.x).toBe(999)
    expect(a2.scene.get('r2')?.isDeleted).toBe(true)
    expect(a2.core.pushLog()).toEqual([])
    // a cold open of the same board gets the snapshot: the control
    const c = await st.headless({ boardId: b, user: 'carol' })
    expect(c.received().some((f) => f.type === 'snapshot')).toBe(true)
    expect(await c.hash()).toBe(await a2.hash())
  }, 90_000)

  it('M6-5: 20 clients come back over at least 2 s after the room closes them all 4000 RECONNECT, and converge', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const opened: { at: number; tab: string }[] = []
    const Timed = function (this: unknown, url: string) {
      opened.push({ at: performance.now(), tab: new URL(url).searchParams.get('sessionId') ?? '' })
      return new TicketWebSocket(url)
    } as unknown as new (url: string) => WebSocketLike
    const clients: LobbyHeadlessClient[] = []
    for (let i = 0; i < 20; i++) {
      const user = `u${i}`
      const c = createLobbyHeadlessClient({
        syncUrl: st.server.wsUrl,
        boardId: b,
        tab: `t${i}`,
        ticket: elementTicket(b, user),
        refreshTicket: async () => elementTicket(b, user),
        WebSocketImpl: Timed,
        random: seeded(2000 + i),
      })
      clients.push(c)
    }
    await Promise.all(clients.map((c) => c.connect()))
    const first = clients[0] as LobbyHeadlessClient
    first.edit((m) => m.set('r1', rect('r1', { index: 'a0' }) as unknown as SceneElement))
    first.core.flush()
    await first.saved(20_000)
    await until(() => clients.every((c) => c.scene.has('r1')), 10_000, 'everyone has r1')
    const before = opened.length
    // the room's next COMMIT fails: it reopens its board file and closes every session 4000 RECONNECT
    await st.failCommit(b, 1)
    let closedAt = 0
    const off = first.core.on((e) => {
      if (e.kind === 'transport' && e.state === 'closed' && closedAt === 0) closedAt = performance.now()
    })
    first.edit((m) => m.set('r2', rect('r2', { x: 200, index: 'a1' }) as unknown as SceneElement))
    first.core.flush()
    await until(() => opened.length >= before + 20, 15_000, 'every client reconnected')
    off()
    const back = opened.slice(before).map((o) => o.at - closedAt)
    const spread = Math.max(...back) - Math.min(...back)
    expect(spread, `reconnects over ${Math.round(spread)} ms`).toBeGreaterThanOrEqual(2000)
    const sorted = [...back].sort((x, y) => x - y)
    let densest = 0
    for (let i = 0; i < sorted.length; i++) {
      let j = i
      while (j + 1 < sorted.length && (sorted[j + 1] as number) - (sorted[i] as number) <= 100) j++
      densest = Math.max(densest, j - i + 1)
    }
    expect(densest, 'the most reconnects inside one 100 ms window').toBeLessThanOrEqual(5)
    // the client with the change not yet acknowledged was among the first back (0-0.5 s)
    const firstBack = opened.slice(before).find((o) => o.tab === 't0')
    expect((firstBack?.at ?? Number.POSITIVE_INFINITY) - closedAt).toBeLessThanOrEqual(1000)
    await first.saved(20_000)
    await st.converged(b, clients.map((c) => Object.assign(c, { hash: () => hashElements(c.core.elements().values()) })), 20_000)
    expect((await st.stored(b, 'r2'))?.type).toBe('rectangle')
    await Promise.all(clients.map((c) => c.close().catch(() => {})))
  }, 120_000)
})
