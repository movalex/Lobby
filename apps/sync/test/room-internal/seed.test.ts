// POST /internal/boards/:bid/seed on the Excalidraw engine (wave 2F, room-internal/seed.ts), against the
// REAL sync server process: a new board from elements or from tldraw records, never over an existing one,
// validated before the file exists, and read back by a client exactly as stored.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isValidIndexKey } from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { CONNECT_REV_PARAM, CONTRACTS_REV } from '@draftroom/canvas-schema/protocol'
import { reactionKey } from '@draftroom/canvas-schema/reactions'
import { draftroomSchema } from '@draftroom/tldraw-import/schema'
import { describe, expect, it } from 'vitest'
import { remapElements } from '../../../../packages/board-ops/src/elements/remap.ts'
import { frame, label, note, rect, text } from '../element-room/support/elements.ts'
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

  it('wave N (decided in N2-4): stores no reaction key from seeded content (not on a note, not under anyone)', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const tag = { 'tag:urgent': { name: 'Urgent', color: 'red' } }
    const mixed = note('M', {
      customData: { lobby: { ...tag, 'react:up:usr_someoneelse': true, 'react:heart:usr_other': true } },
    })
    const only = note('O', { customData: { lobby: { 'react:clap:usr_someoneelse': true } } })
    const onRect = rect('R', { customData: { lobby: { 'react:party:usr_x': true } } })
    const res = await seed(st, b, [mixed, only, onRect])
    expect(res.status).toBe(201)
    const snap = await st.snapshot(b)
    const byId = new Map(snap.elements.map((e) => [e.id, e]))
    expect(byId.get('M')?.customData).toEqual({ lobby: tag })
    for (const id of ['O', 'R']) expect(byId.get(id)?.customData).toBeUndefined()
    expect(JSON.stringify(snap.elements)).not.toContain('react:')
    // a malformed key of the class is a reaction key too (the prefix decides the class): dropped, not refused
    const b2 = newBoardId()
    const odd = note('Q', { customData: { lobby: { 'react:nope:usr_x': true, 'react:up:': 'yes' } } })
    expect((await seed(st, b2, [odd])).status).toBe(201)
    expect((await st.snapshot(b2)).elements[0]?.customData).toBeUndefined()
  })

  it('wave T: keeps the planning keys; card:who only when assignee-refs for the TARGET board names it (WAVE-T-CONTRACTS §3.3)', async () => {
    const st = await h.stack()
    const tag = { 'tag:urgent': { name: 'Urgent', color: 'red' } }
    const card = (id: string, who: string, x = 0) =>
      note(id, {
        x,
        customData: { lobby: { ...tag, 'card:status': 'doing', 'card:who': who, 'card:due': '2026-10-30' } },
      })
    const head = text('H', {
      y: 900,
      text: 'Spot',
      originalText: 'Spot',
      customData: { lobby: { 'sb:head': { aspect: '16:9' } } },
    })
    const panel = frame('P', {
      y: 1000,
      customData: { lobby: { 'sb:of': 'H', 'sb:pos': 'a0', 'sb:dur': 2000 } },
    })
    const timeline = { start: '2026-10-01', end: '2026-12-31', scale: 'week', lanes: 'none' }
    const wall = frame('K', { x: 1000, y: 1000, customData: { lobby: { timeline } } })
    const content = () => [card('C1', 'usr_member'), card('C2', 'usr_outsider', 300), head, panel, wall]
    const lobbyOf = async (b: string) =>
      new Map(
        (await st.snapshot(b)).elements.map((e) => [e.id, e.customData?.lobby as Record<string, unknown>]),
      )
    const kept = { ...tag, 'card:status': 'doing', 'card:due': '2026-10-30' }

    // a new board (the api seeds before its board row exists: assignee-refs answers 404): no assignee kept
    const b1 = newBoardId()
    expect((await seed(st, b1, content())).status).toBe(201)
    let got = await lobbyOf(b1)
    expect(got.get('C1')).toEqual(kept)
    expect(got.get('C2')).toEqual(kept)
    expect(got.get('H')).toEqual({ 'sb:head': { aspect: '16:9' } })
    expect(got.get('P')).toEqual({ 'sb:of': 'H', 'sb:pos': 'a0', 'sb:dur': 2000 })
    expect(got.get('K')).toEqual({ timeline })
    // a target the api knows: the one it names is kept, the other is not; one call for both uids
    const b2 = newBoardId()
    st.api.setAssignees(b2, ['usr_member'])
    expect((await seed(st, b2, content())).status).toBe(201)
    got = await lobbyOf(b2)
    expect(got.get('C1')).toEqual({ ...kept, 'card:who': 'usr_member' })
    expect(got.get('C2')).toEqual(kept)
    expect(st.api.assigneeCalls.filter((c) => c.boardId === b2)).toEqual([
      { boardId: b2, uids: ['usr_member', 'usr_outsider'] },
    ])
    // a new board whose row does not exist yet: the api names who will have access to it (`assignees`, decided in
    // the board's own transaction), and the seed keeps only those, asking assignee-refs nothing
    const b3 = newBoardId()
    const before = st.api.assigneeCalls.length
    const res3 = await call(st, 'POST', `/internal/boards/${b3}/seed`, {
      format: 'lobby-elements',
      elements: content(),
      doc: {},
      assignees: ['usr_member'],
    })
    expect(res3.status).toBe(201)
    got = await lobbyOf(b3)
    expect(got.get('C1')).toEqual({ ...kept, 'card:who': 'usr_member' })
    expect(got.get('C2')).toEqual(kept)
    expect(st.api.assigneeCalls.length).toBe(before)
    // a malformed list is refused before anything is written
    const bad3 = await call(st, 'POST', `/internal/boards/${newBoardId()}/seed`, {
      format: 'lobby-elements',
      elements: content(),
      doc: {},
      assignees: 'usr_member',
    })
    expect(bad3.status).toBe(400)
    // the element rules hold for seeded content too (a card key on a frame is refused, not stripped)
    const bad = frame('X', { customData: { lobby: { 'card:status': 'todo' } } })
    expect((await seed(st, newBoardId(), [bad])).status).toBe(400)
  })

  it('wave T: with DRAFTROOM_PLANNING off, seeded content carries no planning key (templates degrade to plain frames and notes)', async () => {
    const st = await h.stack({ env: { DRAFTROOM_PLANNING: 'off' } })
    const b = newBoardId()
    st.api.setAssignees(b, ['usr_member'])
    const tag = { 'tag:urgent': { name: 'Urgent', color: 'red' } }
    const card = note('C', {
      customData: {
        lobby: { ...tag, 'card:status': 'doing', 'card:who': 'usr_member', 'card:due': '2026-10-30' },
      },
    })
    // a panel key on a rectangle: stripped before the checks, not refused
    const panel = rect('P', { customData: { lobby: { 'sb:of': 'H', 'sb:pos': 'a0', 'sb:dur': 2000 } } })
    const res = await seed(st, b, [card, panel])
    expect(res.status).toBe(201)
    const snap = await st.snapshot(b)
    const byId = new Map(snap.elements.map((e) => [e.id, e]))
    expect(byId.get('C')?.customData).toEqual({ lobby: tag })
    expect(byId.get('P')?.customData).toBeUndefined()
    expect(JSON.stringify(snap.elements)).not.toMatch(/card:|sb:|kanban|timeline/)
    expect(st.api.assigneeCalls).toEqual([])
  })

  it('wave N: a duplicate of a reacted board (its live elements, kept ids or remapped by board-ops) carries no reaction', async () => {
    const st = await h.stack()
    const a = newBoardId()
    expect((await seed(st, a, sampleBoard())).status).toBe(201)
    const ann = await st.client({
      boardId: a,
      user: 'ann',
      query: { [CONNECT_REV_PARAM]: String(CONTRACTS_REV) },
    })
    const pv = (id: string) => ann.confirmed.get(id)?.version ?? 1
    const ack = await ann.push([
      { k: 'p', id: 'N1', pv: pv('N1'), c: { [reactionKey('up', 'ann')]: true } },
      { k: 'p', id: 'N2', pv: pv('N2'), c: { [reactionKey('heart', 'ann')]: true } },
    ])
    expect(ack.r.every((r) => r.ok)).toBe(true)
    const live = (await st.snapshot(a)).elements.filter((e) => !e.isDeleted)
    expect(JSON.stringify(live)).toContain('react:')
    // the api's duplicate (the live board as it is, kept ids) and a copy through board-ops (the registry's
    // duplicate rule: a reaction key is `strip`)
    const remapped = remapElements(live).elements
    expect(JSON.stringify(remapped)).not.toContain('react:')
    for (const content of [live, remapped]) {
      const b = newBoardId()
      expect((await seed(st, b, structuredClone(content) as never)).status).toBe(201)
      const snap = await st.snapshot(b)
      expect(snap.elements.length).toBe(content.length)
      expect(JSON.stringify(snap.elements)).not.toContain('react:')
    }
    // the original keeps them
    expect(JSON.stringify((await st.snapshot(a)).elements)).toContain(reactionKey('up', 'ann'))
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
