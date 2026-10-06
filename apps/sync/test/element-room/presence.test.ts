// §6.2 `presence` (spike subset), through the real server process: the roster is uncapped and comes
// from the tickets; cursors are capped at 40 per recipient; `sel` is dropped while a dot vote is open;
// the drag relay sends ids once per drag, then deltas, then an end, lists active drags in `welcome`, and
// drops a read-only session's drag (covered in readonly.test.ts).

import { describe, expect, it } from 'vitest'
import { callInternal } from '../harness/tickets.ts'
import { rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('presence', () => {
  it('the roster is uncapped, from the tickets: join and leave events', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const watcher = await st.client({ boardId: b, user: 'watcher' })
    const many = await Promise.all(
      Array.from({ length: 45 }, (_, i) => st.client({ boardId: b, user: `p${i}` })),
    )
    await watcher.until(
      () =>
        watcher
          .of('roster')
          .flatMap((r) => r.events)
          .filter((e) => e.k === 'join').length >= 45,
      'joins',
    )
    const late = await st.client({ boardId: b, user: 'late', guest: true })
    expect(late.welcome?.roster).toHaveLength(47)
    expect(late.welcome?.roster.find((r) => r.uid === 'late')).toMatchObject({
      guest: true,
      name: 'late-name',
    })
    many[0]?.close()
    await watcher.until(
      () =>
        watcher.of('roster').some((r) => r.events.some((e) => e.k === 'leave' && e.sid.startsWith('p0:'))),
      'leave',
    )
  })

  it('a joiner’s roster join reaches everyone before its first cursor, also when its join and the tick’s cursors go out in separate tasks (CAP-L1)', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const watcher = await st.client({ boardId: b, user: 'watcher' })
    // joiners that move at once, in waves (their joins and first cursors land in the same ticks)
    for (let wave = 0; wave < 4; wave++) {
      const joiners = await Promise.all(
        Array.from({ length: 12 }, (_, i) => st.client({ boardId: b, user: `w${wave}-${i}` })),
      )
      for (const j of joiners) j.presence({ pointer: { x: wave * 100, y: 5 } })
      await sleep(250)
    }
    await sleep(300)
    // in the watcher's own order of frames: no cursor of a session before that session's join
    const joined = new Set<string>()
    const early: string[] = []
    let cursors = 0
    for (const m of watcher.received) {
      if (m.type === 'roster') for (const e of m.events) if (e.k === 'join') joined.add(e.p.sid)
      if (m.type === 'presence')
        for (const p of m.peers) {
          cursors++
          if (!joined.has(p.sid)) early.push(p.sid)
        }
    }
    expect(joined.size).toBe(48)
    expect(cursors).toBeGreaterThan(0)
    expect(early).toEqual([])
  })

  it('at most 40 cursors per recipient (45 peers moving)', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const watcher = await st.client({ boardId: b, user: 'watcher' })
    const peers = await Promise.all(
      Array.from({ length: 45 }, (_, i) => st.client({ boardId: b, user: `m${i}` })),
    )
    for (let round = 0; round < 4; round++) {
      peers.forEach((p, i) => {
        p.presence({ pointer: { x: i * 10 + round, y: 5 } })
      })
      await sleep(150)
    }
    await sleep(300)
    const seen = new Set(watcher.of('presence').flatMap((f) => f.peers.map((p) => p.sid)))
    const off = new Set(watcher.of('presence').flatMap((f) => f.off ?? []))
    expect(seen.size).toBeGreaterThan(0)
    expect(off.size).toBe(0)
    expect(seen.size).toBe(40) // 45 moving peers, capped at 40, none of them the watcher
  })

  it('pointers are rounded; identity comes from the roster; sel is dropped while a vote is open', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    a.presence({ pointer: { x: 10.6, y: 20.2 }, sel: ['r1'] })
    await bob.until(
      () => bob.of('presence').some((f) => f.peers.some((p) => p.sid.startsWith('alice:'))),
      'alice',
    )
    const p1 = bob
      .of('presence')
      .flatMap((f) => f.peers)
      .find((p) => p.sid.startsWith('alice:'))
    expect(p1).toMatchObject({ pointer: { x: 11, y: 20 }, sel: ['r1'] })
    await callInternal(st.server.url, 'POST', `/internal/boards/${b}/workshop-state`, {
      body: { voteOpen: true, anonymous: true },
    })
    await a.until(() => a.of('workshop').some((w) => w.voteOpen), 'vote open')
    a.presence({ pointer: { x: 30, y: 30 }, sel: ['r1'] })
    await bob.until(
      () =>
        bob
          .of('presence')
          .some((f) => f.peers.some((p) => p.sid.startsWith('alice:') && p.pointer?.x === 30)),
      'moved',
    )
    const p2 = bob
      .of('presence')
      .flatMap((f) => f.peers)
      .filter((p) => p.sid.startsWith('alice:'))
      .at(-1)
    expect(p2?.sel).toBeNull()
  })

  it('drag relay: ids once, then deltas, then the end; active drags in a late welcome', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    await a.create([rect('r1'), rect('r2')])
    a.presence({ drag: { d: 1, ids: ['r1', 'r2'], dx: 0.04, dy: 0 } })
    await bob.until(() => bob.of('presence').some((f) => (f.drags ?? []).length > 0), 'drag start')
    for (let i = 1; i <= 3; i++) {
      await sleep(120)
      a.presence({ drag: { d: 1, dx: i * 10.26, dy: i } })
    }
    await bob.until(
      () =>
        bob
          .of('presence')
          .flatMap((f) => f.drags ?? [])
          .some((d) => 'dx' in d && d.dx === 30.8),
      'deltas',
    )
    const late = await st.client({ boardId: b, user: 'late' })
    expect(late.welcome?.drags).toEqual([
      { sid: expect.stringMatching(/^alice:/), d: 1, ids: ['r1', 'r2'], dx: 30.8, dy: 3 },
    ])
    a.presence({ drag: null })
    await bob.until(
      () =>
        bob
          .of('presence')
          .flatMap((f) => f.drags ?? [])
          .some((d) => 'end' in d),
      'end',
    )
    const drags = bob.of('presence').flatMap((f) => f.drags ?? [])
    const withIds = drags.filter((d) => 'ids' in d && d.ids)
    expect(withIds).toHaveLength(1)
    expect(withIds[0]).toMatchObject({ d: 1, ids: ['r1', 'r2'], dx: 0 })
    expect(
      drags
        .filter((d) => !('end' in d))
        .slice(1)
        .every((d) => !('ids' in d)),
    ).toBe(true)
    // the dragger never gets its own drag back
    expect(a.of('presence').flatMap((f) => f.drags ?? [])).toEqual([])
  })
})
