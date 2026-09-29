// §6.2 `conflicts`, `tags-merge` and `attribution` (spike subset), through the real server process:
// same group, last writer wins; different groups, both kept; edit against delete, delete wins in either
// order; customData per key (+1s, tags); boundElements by id; authorship from the ticket.

import { hashElements } from '@draftroom/canvas-schema/hash'
import { describe, expect, it } from 'vitest'
import type { RawClient } from './support/client.ts'
import { rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const pv = (c: RawClient, id: string) => c.confirmed.get(id)?.version ?? 1

async function two() {
  const st = await h.stack()
  const b = newBoardId()
  const a = await st.client({ boardId: b, user: 'alice' })
  const bob = await st.client({ boardId: b, user: 'bob' })
  await a.create([rect('r1')])
  await bob.untilClock(a.clock)
  return { st, b, a, bob }
}
const stored = async (st: Awaited<ReturnType<typeof two>>['st'], b: string, id: string) =>
  (await st.snapshot(b)).elements.find((e) => e.id === id) as Record<string, unknown>

describe('conflicts', () => {
  it('same group: the later write wins, whole (x and y together)', async () => {
    const { st, b, a, bob } = await two()
    const [pa, pb, ba, bb] = [pv(a, 'r1'), pv(bob, 'r1'), a.clock, bob.clock]
    await a.push([{ k: 'p', id: 'r1', pv: pa, g: { pos: { x: 10, y: 11 } } }], { base: ba })
    await bob.push([{ k: 'p', id: 'r1', pv: pb, g: { pos: { x: 20, y: 21 } } }], { base: bb })
    expect(await stored(st, b, 'r1')).toMatchObject({ x: 20, y: 21 })
  })

  it('different groups: both kept', async () => {
    const { st, b, a, bob } = await two()
    const [pa, pb] = [pv(a, 'r1'), pv(bob, 'r1')]
    await a.push([{ k: 'p', id: 'r1', pv: pa, g: { style: { backgroundColor: '#ffc9c9' } } }])
    await bob.push([{ k: 'p', id: 'r1', pv: pb, g: { pos: { x: 300, y: 300 } } }])
    expect(await stored(st, b, 'r1')).toMatchObject({ backgroundColor: '#ffc9c9', x: 300, y: 300 })
    expect(await a.hash()).toBe(await hashElements((await st.snapshot(b)).elements))
  })

  for (const order of ['delete-then-move', 'move-then-delete'] as const)
    it(`edit against delete: delete wins (${order})`, async () => {
      const { st, b, a, bob } = await two()
      const [pa, pb] = [pv(a, 'r1'), pv(bob, 'r1')]
      const del = () => a.push([{ k: 'p', id: 'r1', pv: pa, g: { life: { isDeleted: true } } }])
      const move = () => bob.push([{ k: 'p', id: 'r1', pv: pb, g: { pos: { x: 5, y: 5 } } }])
      if (order === 'delete-then-move') {
        await del()
        await move()
      } else {
        await move()
        await del()
      }
      expect(await stored(st, b, 'r1')).toMatchObject({ isDeleted: true })
      // only an explicit false revives
      await a.untilClock(bob.clock)
      const revive = await a.push([{ k: 'p', id: 'r1', pv: pv(a, 'r1'), g: { life: { isDeleted: false } } }])
      expect(revive.r[0]).toMatchObject({ ok: true })
      expect(await stored(st, b, 'r1')).toMatchObject({ isDeleted: false })
    })

  it('customData per key: both +1s and both tags are kept, and each undo removes only its own', async () => {
    const { st, b, a, bob } = await two()
    const tags = {
      set: { 'tagDef:x': { name: 'x', color: 'red' }, 'tagDef:y': { name: 'y', color: 'blue' } },
    }
    await a.push(
      [
        {
          k: 'p',
          id: 'r1',
          pv: pv(a, 'r1'),
          c: { 'plusOne:alice': true, 'tag:x': { name: 'x', color: 'red' } },
        },
      ],
      {
        doc: tags,
      },
    )
    await bob.push([
      {
        k: 'p',
        id: 'r1',
        pv: pv(bob, 'r1'),
        c: { 'plusOne:bob': true, 'tag:y': { name: 'y', color: 'blue' } },
      },
    ])
    expect((await stored(st, b, 'r1')).customData).toMatchObject({
      lobby: {
        'plusOne:alice': true,
        'plusOne:bob': true,
        'tag:x': expect.anything(),
        'tag:y': expect.anything(),
      },
    })
    await a.untilClock(bob.clock)
    await a.push([{ k: 'p', id: 'r1', pv: pv(a, 'r1'), c: { 'plusOne:alice': null, 'tag:x': null } }])
    const lobby = ((await stored(st, b, 'r1')).customData as { lobby: Record<string, unknown> }).lobby
    expect(Object.keys(lobby).sort()).toEqual(['plusOne:bob', 'tag:y'])
  })

  it('authorship comes from the ticket: createdBy and, for text, lastEditedBy', async () => {
    const { st, b, a, bob } = await two()
    await bob.create([
      {
        ...rect('t0'),
        type: 'text',
        fontSize: 20,
        fontFamily: 5,
        baseFontSize: null,
        text: 'x',
        originalText: 'x',
        textAlign: 'left',
        verticalAlign: 'top',
        containerId: null,
        autoResize: true,
        lineHeight: 1.25,
      },
    ])
    await a.untilClock(bob.clock)
    await a.push([{ k: 'p', id: 't0', pv: pv(a, 't0'), g: { text: { originalText: 'edited' } } }])
    const t = await stored(st, b, 't0')
    const ls = (t.customData as { lobbyServer: Record<string, { uid: string }> }).lobbyServer
    expect(ls.createdBy?.uid).toBe('bob')
    expect(ls.lastEditedBy?.uid).toBe('alice')
    expect(
      ((await stored(st, b, 'r1')).customData as { lobbyServer: { createdBy: { uid: string } } }).lobbyServer
        .createdBy.uid,
    ).toBe('alice')
  })
})
