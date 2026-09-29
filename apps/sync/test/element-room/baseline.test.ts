// §6.2 `baseline` and `reconnect` (spike subset), through the real server process: hello/welcome (reset
// with the gzip snapshot, or a catch-up), a push acked after its `changes`, the SAME `changes` bytes to
// every session (the writer included), patches that reproduce the stored element, and the convergence
// hash of every client equal to the test snapshot's.

import { hashElements } from '@draftroom/canvas-schema/hash'
import { describe, expect, it } from 'vitest'
import { note, rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()

describe('baseline', () => {
  it('welcome, push, ack after changes, one serialization for everyone, hashes equal the snapshot', async () => {
    const st = await h.stack()
    const boardId = newBoardId()
    const a = await st.client({ boardId, user: 'alice' })
    expect(a.welcome).toMatchObject({
      reset: true,
      clock: 0,
      readonly: false,
      you: { uid: 'alice', role: 'editor' },
    })
    const b = await st.client({ boardId, user: 'bob' })
    expect(b.welcome?.roster.map((r) => r.uid).sort()).toEqual(['alice', 'bob'])

    const ack = await a.create([rect('r1', { x: 10, y: 20 }), note('n1', { x: 300 })])
    expect(ack.r).toHaveLength(2)
    expect(ack.r.every((r) => r.ok)).toBe(true)
    // the server keyed both (the builders send index null): fix carries the new index
    for (const r of ack.r)
      expect((r as { fix?: Record<string, unknown> }).fix?.index).toEqual(expect.any(String))
    // changes before the ack on the writer
    const ai = a.received.findIndex((m) => m.type === 'changes')
    const ak = a.received.findIndex((m) => m.type === 'ack')
    expect(ai).toBeGreaterThanOrEqual(0)
    expect(ai).toBeLessThan(ak)
    await b.untilClock(ack.clock)
    // the same bytes for both sessions
    const frameA = a.rawFrames.find((f) => f.startsWith('{"type":"changes"'))
    const frameB = b.rawFrames.find((f) => f.startsWith('{"type":"changes"'))
    expect(frameA).toBeDefined()
    expect(frameB).toBe(frameA)

    // B moves r1: a patch op reaches A and reproduces the stored element
    const cur = b.confirmed.get('r1')
    const move = await b.push([{ k: 'p', id: 'r1', pv: cur?.version, g: { pos: { x: 55, y: 66 } } }])
    expect(move.r[0]).toMatchObject({ ok: true })
    await a.untilClock(move.clock)
    const last = a.of('changes').at(-1)
    expect(last?.ops[0]).toMatchObject({ k: 'p', id: 'r1', g: { pos: { x: 55, y: 66 } } })
    const snap = await st.snapshot(boardId)
    const digest = await hashElements(snap.elements)
    expect(await a.hash()).toBe(digest)
    expect(await b.hash()).toBe(digest)
    expect(a.schemaErrors).toEqual([])
    expect(b.schemaErrors).toEqual([])

    // ping
    a.send({ type: 'ping', n: 7 })
    await a.until(() => a.of('pong').some((p) => p.n === 7), 'pong')
  })

  it('a reconnect with since and epoch gets a catch-up; another epoch or a since below the horizon a reset', async () => {
    const st = await h.stack()
    const boardId = newBoardId()
    const a = await st.client({ boardId, user: 'alice' })
    await a.create([rect('r1'), rect('r2')])
    const held = new Map(a.confirmed)
    const since = a.clock
    const epoch = a.epoch
    a.close()
    const b = await st.client({ boardId, user: 'bob' })
    await b.push([
      { k: 'p', id: 'r2', pv: b.confirmed.get('r2')?.version, g: { style: { strokeColor: '#e03131' } } },
    ])
    await b.create([rect('r3')])
    const a2 = await st.client({ boardId, user: 'alice', since, epoch, confirmed: held })
    expect(a2.welcome).toMatchObject({ reset: false, snapshot: null })
    expect(a2.welcome?.catchUp?.map((o) => (o.k === 'c' ? o.el.id : o.id)).sort()).toEqual(['r2', 'r3'])
    const snap = await st.snapshot(boardId)
    expect(await a2.hash()).toBe(await hashElements(snap.elements))
    const a3 = await st.client({ boardId, user: 'alice', tab: 'other', since, epoch: 'another-epoch' })
    expect(a3.welcome).toMatchObject({ reset: true })
    expect(await a3.hash()).toBe(await hashElements(snap.elements))
  })
})
