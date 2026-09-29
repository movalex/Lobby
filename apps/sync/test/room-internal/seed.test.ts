// POST /internal/boards/:bid/seed on the Excalidraw engine (wave 2F, room-internal/seed.ts), against the
// REAL sync server process: a new board from elements or from tldraw records, never over an existing one,
// validated before the file exists, and read back by a client exactly as stored.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { isValidIndexKey } from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { describe, expect, it } from 'vitest'
import { label, note, rect } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { docRecord, pageRecord, note as tlNote } from '../migrate/tl-records.ts'
import { call, sampleBoard, seed } from './support.ts'

const h = useElementHarness()

describe('seed (Excalidraw engine)', () => {
  it('stores a lobby-elements board: fresh indices in the given order, labels after their containers', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const els = sampleBoard()
    const res = await seed(st, b, els, { startView: { x: 0, y: 0, w: 800, h: 600 } })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ boardId: b, records: els.length })
    const snap = await st.snapshot(b)
    expect(snap.elements.map((e) => e.id).sort()).toEqual(els.map((e) => e.id).sort())
    expect(snap.elements.every((e) => isValidIndexKey(e.index) && e.isDeleted === false)).toBe(true)
    expect(checkInvariants(snap.elements)).toEqual([])
    const byIndex = [...snap.elements].sort((a, c) => ((a.index ?? '') < (c.index ?? '') ? -1 : 1))
    const order = byIndex.map((e) => e.id)
    expect(order.indexOf('N1.t')).toBe(order.indexOf('N1') + 1)
    expect(order.indexOf('R.t')).toBe(order.indexOf('R') + 1)
    // a client opening the board gets exactly what was stored, with the doc
    const c = await st.client({ boardId: b, user: 'reader' })
    expect(c.welcome?.doc).toMatchObject({ startView: { x: 0, y: 0, w: 800, h: 600 } })
    expect(await c.hash()).toEqual(
      await (await import('@draftroom/canvas-schema/hash')).hashElements(snap.elements),
    )
  })

  it('never overwrites: a second seed, or a seed of an opened board, is 409', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect((await seed(st, b, sampleBoard())).status).toBe(201)
    const again = await seed(st, b, [rect('X')])
    expect(again.status).toBe(409)
    expect((await st.snapshot(b)).elements.some((e) => e.id === 'X')).toBe(false)
    const opened = newBoardId()
    const c = await st.client({ boardId: opened, user: 'early' })
    await c.create([rect('Y')])
    expect((await seed(st, opened, [rect('Z')])).status).toBe(409)
  })

  it('refuses invalid content before any file exists, so the id stays seedable', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const file = join(st.server.dataDir, 'rooms', `board-${b}.sqlite`)
    // an unknown key (the strict schema), a label without its container (the invariants), a bad doc key
    for (const bad of [
      { els: [{ ...rect('A'), bogus: 1 }], doc: {} },
      { els: [label('L', 'nobody')], doc: {} },
      { els: [rect('A')], doc: { nope: 1 } },
      { els: [rect('A'), rect('A')], doc: {} },
    ]) {
      const res = await seed(st, b, bad.els, bad.doc)
      expect(res.status).toBe(400)
      expect(existsSync(file)).toBe(false)
    }
    expect((await seed(st, b, [rect('A')])).status).toBe(201)
    expect(existsSync(file)).toBe(true)
  })

  it('drops tombstones and keeps customData.lobby and lobbyServer as given', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const server = {
      createdBy: { uid: 'u1', name: 'Ann', guest: false },
      createdAt: 5,
      lastEditedBy: null,
      lastEditedAt: 5,
    }
    const kept = note('K', {
      customData: { lobby: { 'tag:urgent': { name: 'Urgent', color: 'red' } }, lobbyServer: server },
    })
    const res = await seed(st, b, [kept, { ...rect('gone'), isDeleted: true }], {
      'tagDef:urgent': { name: 'Urgent', color: 'red' },
    })
    expect(res.status).toBe(201)
    expect(res.body.records).toBe(1)
    const snap = await st.snapshot(b)
    expect(snap.elements.map((e) => e.id)).toEqual(['K'])
    expect(snap.elements[0]?.customData).toEqual(kept.customData)
  })

  it('converts tldraw records (a v1 checkpoint, a v1 archive) with the board converter', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const records = [
      docRecord(),
      pageRecord('page:page', 'Page 1', 'a1'),
      tlNote('n1', 'page:page', 'a1', 100, 100, 'converted text'),
    ]
    const res = await call(st, 'POST', `/internal/boards/${b}/seed`, {
      snapshot: { schema: draftroomSchema.serialize(), documents: records.map((state) => ({ state })) },
    })
    expect(res.status).toBe(201)
    const snap = await st.snapshot(b)
    const noteEl = snap.elements.find((e) => e.id === 'n1')
    const labelEl = snap.elements.find((e) => e.type === 'text' && e.containerId === 'n1') as
      | { originalText: string }
      | undefined
    expect(noteEl?.type).toBe('stickynote')
    expect(labelEl?.originalText).toBe('converted text')
    const c = await st.client({ boardId: b, user: 'reader' })
    const doc = (c.welcome?.doc ?? {}) as { import?: { from: string } }
    expect(doc.import?.from).toBe('tldraw-5.4.2')
  })

  it('refuses tldraw records it cannot read, and a body of neither format', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const bad = await call(st, 'POST', `/internal/boards/${b}/seed`, {
      snapshot: {
        schema: { schemaVersion: 99, sequences: {} },
        documents: [{ state: { id: 'x', typeName: 'shape' } }],
      },
    })
    expect(bad.status).toBe(400)
    expect((await call(st, 'POST', `/internal/boards/${b}/seed`, { elements: [] })).status).toBe(400)
    expect((await call(st, 'POST', `/internal/boards/${b}/seed`, [])).status).toBe(400)
  })

  it('stays behind the internal secret', async () => {
    const st = await h.stack()
    const { callInternal } = await import('../harness/tickets.ts')
    const res = await callInternal(st.server.url, 'POST', `/internal/boards/${newBoardId()}/seed`, {
      body: { format: 'lobby-elements', elements: [], doc: {} },
      secret: null,
    })
    expect(res.status).toBe(401)
  })
})
