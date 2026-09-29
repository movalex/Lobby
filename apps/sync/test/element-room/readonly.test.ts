// §6.2 `readonly` and `access`, and the server half of B5 R1 and R4, through the real server process: a
// viewer's (and a commenter's) forged frames are refused op by op with READ_ONLY, its lease request is
// denied, nothing is stored, its socket stays open and its presence flows, but its drag is dropped. A
// downgrade closes 4000 and the reconnect is read-only; a revocation closes 4099 FORBIDDEN.

import { hashElements } from '@draftroom/canvas-schema/hash'
import { describe, expect, it } from 'vitest'
import { rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()

describe('read-only roles (B5 R1)', () => {
  for (const role of ['viewer', 'commenter'] as const)
    it(`${role}: create, patch, delete, doc write READ_ONLY; lease denied; presence flows; drag dropped`, async () => {
      const st = await h.stack()
      const b = newBoardId()
      const ed = await st.client({ boardId: b, user: 'editor' })
      await ed.create([rect('r1'), rect('r2'), rect('r3'), rect('r4'), rect('r5')])
      const before = await hashElements((await st.snapshot(b)).elements)
      const v = await st.client({ boardId: b, user: 'viewer', role })
      expect(v.welcome?.readonly).toBe(true)
      const pv = v.confirmed.get('r1')?.version
      const ack = await v.push(
        [
          { k: 'c', el: rect('v1') },
          { k: 'p', id: 'r1', pv, g: { pos: { x: 500, y: 500 } } },
          { k: 'p', id: 'r2', pv, g: { life: { isDeleted: true } } },
        ],
        { doc: { set: { 'tagDef:x': { name: 'x', color: 'red' } } } },
      )
      expect(ack.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['READ_ONLY', 'READ_ONLY', 'READ_ONLY'])
      expect(ack.docDenied).toEqual({ keys: ['tagDef:x'], code: 'READ_ONLY' })
      expect((await v.acquire('r1')).type).toBe('lease.deny')
      // presence flows to the editor; the viewer's drag of 5 live ids does not
      v.presence({
        pointer: { x: 42, y: 43 },
        drag: { d: 1, ids: ['r1', 'r2', 'r3', 'r4', 'r5'], dx: 10, dy: 10 },
      })
      await ed.until(
        () =>
          ed
            .of('presence')
            .some((p) => p.peers.some((x) => x.sid.startsWith('viewer:') && x.pointer?.x === 42)),
        'viewer cursor',
      )
      await new Promise((r) => setTimeout(r, 300))
      expect(ed.of('presence').flatMap((p) => p.drags ?? [])).toEqual([])
      expect(v.closeCode).toBeNull()
      expect(await hashElements((await st.snapshot(b)).elements)).toBe(before)
    })

  it('a limited guest editor is not read-only, but cannot lock', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const g = await st.client({ boardId: b, user: 'guest1', guest: true })
    expect(g.welcome?.you.guest).toBe(true)
    await g.create([rect('r1')])
    const ack = await g.push([
      { k: 'p', id: 'r1', pv: g.confirmed.get('r1')?.version, g: { meta: { locked: true } } },
    ])
    expect(ack.r[0]).toMatchObject({ ok: false, code: 'LOCKED' })
    const d = await g.push(
      [{ k: 'p', id: 'r1', pv: g.confirmed.get('r1')?.version, g: { style: { strokeColor: '#ff0000' } } }],
      {
        doc: { set: { 'tagDef:y': { name: 'y', color: 'blue' } } },
      },
    )
    expect(d.r[0]).toMatchObject({ ok: true })
    expect(d.docDenied).toEqual({ keys: ['tagDef:y'], code: 'READ_ONLY' })
  })
})

describe('access changes (B5 R4)', () => {
  it('a downgrade closes 4000 RECONNECT and the reconnect is read-only; a revocation closes 4099 FORBIDDEN', async () => {
    const st = await h.stack({ env: { ACCESS_RECHECK_MS: '200' } })
    const b = newBoardId()
    st.api.setRole(b, 'alice', 'editor')
    st.api.setRole(b, 'bob', 'editor')
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    await a.create([rect('r1')])
    st.api.setRole(b, 'alice', 'viewer')
    expect(await a.untilClosed(10_000)).toMatchObject({ code: 4000, reason: 'RECONNECT' })
    const a2 = await st.client({ boardId: b, user: 'alice', role: 'viewer' })
    const queued = await a2.push([
      { k: 'p', id: 'r1', pv: a2.confirmed.get('r1')?.version, g: { pos: { x: 9, y: 9 } } },
    ])
    expect(queued.r[0]).toMatchObject({ ok: false, code: 'READ_ONLY' })
    st.api.setRole(b, 'bob', null)
    expect(await bob.untilClosed(10_000)).toMatchObject({ code: 4099, reason: 'FORBIDDEN' })
  })
})
