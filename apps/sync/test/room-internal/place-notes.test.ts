// POST /internal/boards/:bid/place-notes on the Excalidraw engine (wave 2F, room-internal/place-notes.ts),
// against the REAL sync server process: server-made notes in the target frame, the server-only
// `privateNote` stamp, idempotent per draft, a re-made frame, and the tldraw route's request and answer.

import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { describe, expect, it } from 'vitest'
import { type El, frame, rect } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { call, seed } from './support.ts'

const h = useElementHarness()

const SESSION = 'pbs_AAAAAAAAAAAAAAAA'
const ANN = { id: 'usr_ANNANNANNANNANN', name: 'Ann', color: '#1971c2' }
const BOB = { id: 'usr_BOBBOBBOBBOBBOB', name: 'Bob', color: '#e03131' }
const pnt = (n: number) => `pnt_${String(n).padStart(12, '0')}`

type Placed = { placed: string[]; existing: string[]; frameId: string; frameCreated: boolean }

function request(o: { anonymous?: boolean; frameId?: string; notes?: number } = {}) {
  const anonymous = o.anonymous ?? false
  const notes = Array.from({ length: o.notes ?? 3 }, (_, i) => ({
    id: pnt(i + 1),
    text: `idea number ${i + 1}`,
    color: i % 2 ? 'blue' : 'yellow',
    authorId: anonymous ? null : i < 2 ? ANN.id : BOB.id,
  }))
  return {
    sessionId: SESSION,
    anonymous,
    frame: {
      id: o.frameId ?? 'shape:F',
      pageId: 'page:page',
      x: 0,
      y: 0,
      w: 800,
      h: 600,
      name: 'Brainstorm',
    },
    notes,
    authors: anonymous ? [] : [ANN, BOB],
  }
}

async function board(extra: El[] = []) {
  const st = await h.stack({ env: { IDLE_EVICT_MS: '200' } })
  const b = newBoardId()
  expect(
    (await seed(st, b, [frame('F', { width: 800, height: 600, name: 'Brainstorm' }), ...extra])).status,
  ).toBe(201)
  return { st, b }
}

const place = (st: Awaited<ReturnType<typeof board>>['st'], b: string, body: unknown) =>
  call<Placed>(st, 'POST', `/internal/boards/${b}/place-notes`, body)

describe('place-notes (Excalidraw engine)', () => {
  it('lays the notes out in the frame as server-made notes, stamped with the session and author', async () => {
    const { st, b } = await board([rect('beside', { x: 900, y: 0 })])
    const res = await place(st, b, request())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      placed: [pnt(1), pnt(2), pnt(3)].map((id) => `shape:${id}`),
      existing: [],
      frameId: 'shape:F',
      frameCreated: false,
    })
    const snap = await st.snapshot(b)
    expect(checkInvariants(snap.elements)).toEqual([])
    const byId = new Map(snap.elements.map((e) => [e.id, e as El]))
    for (const [i, author] of [ANN, ANN, BOB].entries()) {
      const n = byId.get(pnt(i + 1)) as El
      const l = byId.get(`${pnt(i + 1)}.t`) as El
      expect(n.type).toBe('stickynote')
      expect(n.frameId).toBe('F')
      expect(n.created).toBeNull()
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.x + n.width).toBeLessThanOrEqual(800)
      expect(n.customData.lobbyServer).toMatchObject({
        createdBy: { uid: author.id, name: author.name, guest: false },
        privateNote: { session: SESSION, author: author.id },
      })
      expect(l.containerId).toBe(n.id)
      expect(l.originalText).toBe(`idea number ${i + 1}`)
      expect(l.customData.lobbyServer.lastEditedBy).toMatchObject({ uid: author.id })
      expect(l.index > n.index).toBe(true)
    }
    expect(byId.get(pnt(2))?.backgroundColor).toBe('#a7b7f6') // Lobby's blue note fill
    // no two notes overlap
    const notes = [1, 2, 3].map((i) => byId.get(pnt(i)) as El)
    for (const a of notes)
      for (const c of notes)
        if (a !== c)
          expect(
            a.x + a.width <= c.x || c.x + c.width <= a.x || a.y + a.height <= c.y || c.y + c.height <= a.y,
          ).toBe(true)
  })

  it('is idempotent per draft: a retried reveal places nothing twice', async () => {
    const { st, b } = await board()
    expect((await place(st, b, request({ notes: 2 }))).status).toBe(200)
    const again = await place(st, b, request({ notes: 3 }))
    expect(again.body).toMatchObject({
      placed: [`shape:${pnt(3)}`],
      existing: [pnt(1), pnt(2)].map((id) => `shape:${id}`),
    })
    const snap = await st.snapshot(b)
    expect(snap.elements.filter((e) => e.type === 'stickynote')).toHaveLength(3)
  })

  it('names nobody in an anonymous session', async () => {
    const { st, b } = await board()
    expect((await place(st, b, request({ anonymous: true }))).status).toBe(200)
    const snap = await st.snapshot(b)
    for (const e of snap.elements.filter((x) => x.id.startsWith('pnt_')) as El[]) {
      expect(e.customData.lobbyServer.createdBy).toBeNull()
      expect(JSON.stringify(e)).not.toContain('usr_')
      if (e.type === 'stickynote') expect(e.customData.lobbyServer.privateNote).toEqual({ session: SESSION })
    }
  })

  it('grows the frame when its free space cannot hold the notes', async () => {
    const { st, b } = await board()
    const res = await place(st, b, request({ notes: 12 }))
    expect(res.status).toBe(200)
    const snap = await st.snapshot(b)
    const f = snap.elements.find((e) => e.id === 'F') as El
    expect(f.height).toBeGreaterThan(600)
    expect(f.width).toBe(800)
    for (const n of snap.elements.filter((e) => e.type === 'stickynote') as El[])
      expect(n.y + n.height).toBeLessThanOrEqual(f.y + f.height)
    expect(checkInvariants(snap.elements)).toEqual([])
  })

  it('makes the frame again where the session started when it was deleted, through the open room', async () => {
    const { st, b } = await board()
    const c = await st.client({ boardId: b, user: 'ann' })
    await c.push([
      { k: 'p', id: 'F', pv: c.confirmed.get('F')?.version ?? 1, g: { life: { isDeleted: true } } },
    ])
    // the room is open: the write goes through it (CR 2F-2, the room's serverWrite since spike B's part 3)
    const res = await place(st, b, request())
    c.close()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ frameId: 'shape:F', frameCreated: true })
    const snap = await st.snapshot(b)
    const f = snap.elements.find((e) => e.id === 'F') as El
    expect(f).toMatchObject({ isDeleted: false, type: 'frame', name: 'Brainstorm', x: 0, y: 0 })
    expect(checkInvariants(snap.elements)).toEqual([])
  })

  it('refuses a malformed request and a board with no file', async () => {
    const { st, b } = await board()
    expect((await place(st, b, { ...request(), sessionId: 'x' })).status).toBe(400)
    expect((await place(st, b, { ...request(), anonymous: true })).status).toBe(400) // authors named
    expect((await place(st, newBoardId(), request())).status).toBe(404)
  })
})
