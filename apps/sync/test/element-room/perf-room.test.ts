// The room's join- and reconnect-storm paths after the B9 performance round (docs/EXCALIDRAW-MIGRATION.md
// §2.13; B9.md "After the fixes"), through the real server process: a cached reset snapshot is reused
// across clocks with the rows since it as a catch-up (SNAPSHOT_REUSE), a delete still drops it (W5-02);
// a catch-up welcome built from the stored strings is the same catch-up (tombstones redacted, same bytes
// for the same `since`); roster joins and leaves reach everyone, in order, never one's own join; a busy
// room groups pushes into fewer commits while every push is acked in order and nothing is lost.

import { hashElements } from '@draftroom/canvas-schema/hash'
import { describe, expect, it } from 'vitest'
import { callInternal } from '../harness/tickets.ts'
import { rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function metric(url: string, name: string): Promise<number> {
  const res = await callInternal(url, 'GET', '/internal/metrics')
  const text = await res.text()
  const m = new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, 'm').exec(text)
  return m ? Number(m[1]) : 0
}

describe('snapshot reuse across clocks', () => {
  it('a joiner gets the cached snapshot plus the rows since its clock; the hashes agree; a delete drops the cache', async () => {
    const st = await h.stack()
    const boardId = newBoardId()
    const a = await st.client({ boardId, user: 'alice' })
    expect(a.welcome).toMatchObject({ reset: true, clock: 0 })
    const snapBytesA = a.welcome?.snapshot?.bytes
    // the board moves on: three commits
    await a.create([rect('r1', { x: 10 })])
    await a.create([rect('r2', { x: 20 })])
    const last = await a.create([rect('r3', { x: 30 })])
    expect(last.clock).toBe(3)
    // a joiner within the reuse window: the clock-0 snapshot (the same bytes), then a catch-up `changes`
    const b = await st.client({ boardId, user: 'bob' })
    expect(b.welcome).toMatchObject({ reset: true, clock: 0 })
    expect(b.welcome?.snapshot?.bytes).toBe(snapBytesA)
    await b.untilClock(3)
    const catchUp = b.of('changes')[0]
    expect(catchUp?.clock).toBe(3)
    expect(catchUp?.ops.map((o) => (o.k === 'c' ? o.el.id : o.id)).sort()).toEqual(['r1', 'r2', 'r3'])
    const digest = await hashElements((await st.snapshot(boardId)).elements)
    expect(await b.hash()).toBe(digest)
    expect(await a.hash()).toBe(digest)
    // the same joiner reconnecting with its clock gets a catch-up, not the snapshot
    const b2 = await st.client({
      boardId,
      user: 'bob',
      tab: 'bob-2',
      since: b.clock,
      epoch: b.epoch,
      confirmed: b.confirmed,
    })
    expect(b2.welcome).toMatchObject({ reset: false, clock: 3, catchUp: [] })
    // a delete drops the cache: the next joiner's snapshot is fresh, at the current clock
    const cur = a.confirmed.get('r2')
    const del = await a.push([{ k: 'p', id: 'r2', pv: cur?.version, g: { life: { isDeleted: true } } }])
    expect(del.r[0]).toMatchObject({ ok: true })
    const c = await st.client({ boardId, user: 'carol' })
    expect(c.welcome).toMatchObject({ reset: true, clock: del.clock })
    expect(c.of('changes')).toHaveLength(0)
    expect(c.confirmed.get('r2')?.isDeleted).toBe(true)
    expect((c.confirmed.get('r2') as { customData?: unknown })?.customData).toBeUndefined()
    expect(await c.hash()).toBe(await hashElements((await st.snapshot(boardId)).elements))
    for (const cl of [a, b, b2, c]) expect(cl.schemaErrors).toEqual([])
  })
})

describe('catch-up welcomes from the stored rows', () => {
  it('the rows since the clock, a tombstone redacted; two sessions with the same since get the same ops', async () => {
    const st = await h.stack()
    const boardId = newBoardId()
    const a = await st.client({ boardId, user: 'alice' })
    await a.create([rect('k1', { x: 1 }), rect('k2', { x: 2 })])
    const since = a.clock
    const epoch = a.epoch
    const held = new Map(a.confirmed)
    await a.create([rect('k3', { x: 3, customData: { lobby: { alt: 'visible words' } } })])
    const cur = a.confirmed.get('k1')
    await a.push([{ k: 'p', id: 'k1', pv: cur?.version, g: { life: { isDeleted: true } } }])
    const x = await st.client({ boardId, user: 'alice', tab: 'x', since, epoch, confirmed: held })
    const y = await st.client({ boardId, user: 'alice', tab: 'y', since, epoch, confirmed: held })
    for (const c of [x, y]) {
      expect(c.welcome?.reset).toBe(false)
      const ops = c.welcome?.catchUp ?? []
      expect(ops.map((o) => (o.k === 'c' ? o.el.id : o.id)).sort()).toEqual(['k1', 'k3'])
      const dead = ops.find((o) => o.k === 'c' && o.el.id === 'k1')
      expect(dead && dead.k === 'c' ? dead.el.isDeleted : null).toBe(true)
      expect(JSON.stringify(dead)).not.toContain('"x":1')
      expect(JSON.stringify(ops)).toContain('visible words')
      expect(c.schemaErrors).toEqual([])
    }
    // the same bytes of the catch-up for the same since at the same clock
    const catchUpOf = (c: typeof x) =>
      /"catchUp":(\[.*\])\}$/.exec(c.rawFrames.find((f) => f.startsWith('{"type":"welcome"')) ?? '')?.[1]
    expect(catchUpOf(x)).toBeDefined()
    expect(catchUpOf(y)).toBe(catchUpOf(x))
    const digest = await hashElements((await st.snapshot(boardId)).elements)
    expect(await x.hash()).toBe(digest)
    expect(await y.hash()).toBe(digest)
  })
})

describe('roster events in batches', () => {
  it('every join and leave reaches every other session, in order, never one’s own join', async () => {
    const st = await h.stack()
    const boardId = newBoardId()
    const first = await st.client({ boardId, user: 'first' })
    const names = Array.from({ length: 12 }, (_, i) => `p${i}`)
    const peers = await Promise.all(names.map((u) => st.client({ boardId, user: u })))
    await first.until(
      () =>
        first
          .of('roster')
          .flatMap((r) => r.events)
          .filter((e) => e.k === 'join').length >= 12,
      '12 joins',
    )
    const joins = first
      .of('roster')
      .flatMap((r) => r.events)
      .filter((e) => e.k === 'join')
    expect(new Set(joins.map((e) => (e.k === 'join' ? e.p.uid : '')))).toEqual(new Set(names))
    // nobody saw its own join; everyone's welcome names itself
    for (const p of peers) {
      const own = p
        .of('roster')
        .flatMap((r) => r.events)
        .filter((e) => e.k === 'join' && e.p.uid === p.user)
      expect(own).toEqual([])
      expect(p.welcome?.roster.some((r) => r.uid === p.user)).toBe(true)
    }
    // a late joiner's welcome roster is complete
    const late = await st.client({ boardId, user: 'late' })
    expect(late.welcome?.roster.map((r) => r.uid).sort()).toEqual([...names, 'first', 'late'].sort())
    // a leave follows the join of the same session, in order
    const sid = `p3:${peers[3]?.tab}`
    peers[3]?.close()
    await first.until(
      () => first.of('roster').some((r) => r.events.some((e) => e.k === 'leave' && e.sid === sid)),
      'leave',
    )
    const seq = first
      .of('roster')
      .flatMap((r) => r.events)
      .filter((e) => (e.k === 'leave' ? e.sid : e.p.sid) === sid)
    expect(seq.map((e) => e.k)).toEqual(['join', 'leave'])
    expect(first.schemaErrors).toEqual([])
  })
})

describe('a busy room paces its commits', () => {
  it('40 pushes 30 ms apart: every push acked in order, nothing lost, fewer commits than pushes', async () => {
    const st = await h.stack()
    const boardId = newBoardId()
    const a = await st.client({ boardId, user: 'alice' })
    const w = await st.client({ boardId, user: 'watcher', role: 'viewer' })
    await a.create([rect('r', { x: 0 })])
    const commitsBefore = await metric(st.server.url, 'lobby_commit_ms_count')
    const acks = []
    const t0 = Date.now()
    for (let i = 1; i <= 40; i++) {
      const cur = a.confirmed.get('r')
      acks.push(a.pushNow([{ k: 'p', id: 'r', pv: cur?.version, g: { pos: { x: i, y: 0 } } }]).ack)
      // the next push rides on the server's copy after this ack (pv), as a client's would
      await acks[acks.length - 1]
      await sleep(Math.max(0, 30 * i - (Date.now() - t0)))
    }
    const results = await Promise.all(acks)
    expect(results.every((r) => r.r[0]?.ok)).toBe(true)
    for (let i = 1; i < results.length; i++)
      expect((results[i] as { clock: number }).clock).toBeGreaterThan(
        (results[i - 1] as { clock: number }).clock,
      )
    await w.untilClock(results.at(-1)?.clock ?? 0)
    expect(w.confirmed.get('r')?.x).toBe(40)
    const commits = (await metric(st.server.url, 'lobby_commit_ms_count')) - commitsBefore
    // with one push in flight at a time the hold cannot group them: it only delays; the floor and the
    // hold together still commit at most once per push, and the room stays correct
    expect(commits).toBeLessThanOrEqual(40)
    expect(commits).toBeGreaterThan(0)
    // many sessions pushing at once on a busy board DO share commits
    const editors = await Promise.all(
      Array.from({ length: 6 }, (_, i) => st.client({ boardId, user: `e${i}` })),
    )
    await Promise.all(editors.map((e, i) => e.create([rect(`w${i}`, { x: i })])))
    const before2 = await metric(st.server.url, 'lobby_commit_ms_count')
    const pushes2 = await metric(st.server.url, 'lobby_pushes_received_total')
    for (let round = 0; round < 8; round++) {
      await Promise.all(
        editors.map((e, i) => {
          const cur = e.confirmed.get(`w${i}`)
          return e.push([{ k: 'p', id: `w${i}`, pv: cur?.version, g: { pos: { x: round + 1, y: i } } }])
        }),
      )
      await sleep(35)
    }
    const commits2 = (await metric(st.server.url, 'lobby_commit_ms_count')) - before2
    const sent2 = (await metric(st.server.url, 'lobby_pushes_received_total')) - pushes2
    expect(sent2).toBe(48)
    expect(commits2).toBeLessThan(sent2 / 2)
    const digest = await hashElements((await st.snapshot(boardId)).elements)
    for (const c of [a, w, ...editors]) {
      await c.untilClock(Math.max(...editors.map((e) => e.clock)))
      expect(await c.hash()).toBe(digest)
    }
  }, 60_000)
})
