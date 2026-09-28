// GET /api/boards/:bid/deleted and POST /api/boards/:bid/deleted/restore (both edit): the API's
// permission checks in front of the sync server's "Recently deleted". Listing needs edit since
// docs/SECURITY-REVIEW-2026-09-27.md authz-001: a deleted note's label is its text, and viewers or
// review-link guests must not read notes deleted before the board was shared with them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventHub } from '../../../src/events/hub.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { createFakeSync, type FakeSync, recordEvents } from './helpers.ts'

let api: TestApi
let sync: FakeSync
let events: EventHub
let bob: Client
let carol: Client
let boardId: string

const ENTRY = {
  shapeId: 'shape:n1',
  type: 'note',
  label: 'Buy milk',
  deletedAt: '2026-09-27T00:00:00.000Z',
  deletedBy: { id: 'usr_x', name: 'X' },
  childCount: 0,
}

beforeEach(async () => {
  sync = createFakeSync()
  events = new EventHub()
  api = await createTestApi({ deps: { syncInternal: sync, events } })
  await api.login('owner')
  bob = await api.login('bob')
  carol = await api.login('carol')
  boardId = await createBoard(bob, DEV_STUDIO, 'Board')
  sync.deletedList = { entries: [ENTRY], total: 1, limit: 2000 }
  sync.restoreResult = { restored: ['shape:n1'], skipped: [], bindings: 1, reparented: 0 }
})
afterEach(() => api.close())

const list = (c: Client, bid = boardId) => c.req('GET', `/api/boards/${bid}/deleted`)
const restore = (c: Client, ids: unknown = ['shape:n1'], bid = boardId) =>
  c.req('POST', `/api/boards/${bid}/deleted/restore`, { ids })
const grant = (role: string) => bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role })

describe('recently deleted through the API', () => {
  it('lists for editors (the sync answer, checked against the contract)', async () => {
    await grant('editor')
    const res = await list(carol)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ entries: [ENTRY], total: 1, limit: 2000 })
    expect(sync.deletedCalls).toEqual([{ op: 'list', boardId }])
  })

  it('R17: an empty text box (tldraw removes one by itself when its editing ends) is not listed', async () => {
    const at = '2026-09-27T00:01:00.000Z'
    const text = (id: string, label: string, childCount = 0) => ({
      ...ENTRY,
      shapeId: `shape:${id}`,
      type: 'text',
      label,
      deletedAt: at,
      childCount,
    })
    const emptyNote = { ...ENTRY, shapeId: 'shape:n2', label: '' }
    sync.deletedList = {
      entries: [text('t1', ''), text('t2', '  \n '), text('t3', 'Agenda'), emptyNote, ENTRY],
      total: 5,
      limit: 2000,
    }
    const res = await list(bob)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ entries: [text('t3', 'Agenda'), emptyNote, ENTRY], total: 3, limit: 2000 })
    // Only on the page it was sent: the total of a capped list goes down by what was left out.
    sync.deletedList = { entries: [text('t1', ''), ENTRY], total: 40, limit: 2 }
    expect((await list(bob)).json()).toMatchObject({ entries: [ENTRY], total: 39, limit: 2 })
  })

  it('authz-001: viewers, commenters and review-link guests get 403 and never reach the sync server', async () => {
    for (const role of ['viewer', 'commenter']) {
      await grant(role)
      const res = await list(carol)
      expect(res.statusCode, role).toBe(403)
      expect(res.json().error.code).toBe('FORBIDDEN')
    }
    // Someone who redeemed a view-only review link (the board is private: the link is their access).
    const link = await bob.req('POST', `/api/boards/${boardId}/review-links`, { role: 'viewer' })
    expect(link.statusCode).toBe(201)
    const token = (link.json() as { url: string }).url.split('/').pop() ?? ''
    const client = await api.login('client')
    expect((await client.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
    expect((await client.req('GET', `/api/boards/${boardId}`)).statusCode).toBe(200)
    expect((await list(client)).statusCode).toBe(403)
    expect(sync.deletedCalls).toEqual([])
  })

  it('restores for editors and tells the board; the ids reach the sync server as sent', async () => {
    const got = recordEvents(events, boardId)
    const res = await restore(bob, ['shape:n1', 'shape:frame'])
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ restored: ['shape:n1'], skipped: [], bindings: 1, reparented: 0 })
    expect(sync.deletedCalls).toEqual([{ op: 'restore', boardId, ids: ['shape:n1', 'shape:frame'] }])
    expect(got).toEqual([{ type: 'history.deleted', data: { restored: 1 } }])
  })

  it('restore needs edit: viewers/commenters 403, archived boards 403, outsiders and trashed boards 404', async () => {
    for (const role of ['viewer', 'commenter']) {
      await grant(role)
      expect((await restore(carol)).statusCode, role).toBe(403)
    }
    const outsider = await api.login('dave')
    expect((await restore(outsider)).statusCode).toBe(404)
    expect((await list(outsider)).statusCode).toBe(404)
    expect((await api.anon('GET', `/api/boards/${boardId}/deleted`)).statusCode).toBe(401)
    await bob.req('POST', `/api/boards/${boardId}/archive`)
    expect((await restore(bob)).statusCode).toBe(403)
    // Archived boards are read-only for everyone: the list needs edit, like restore.
    expect((await list(bob)).statusCode).toBe(403)
    await bob.req('POST', `/api/boards/${boardId}/trash`)
    expect((await list(bob)).statusCode).toBe(404)
    expect(sync.deletedCalls.filter((c) => c.op === 'restore')).toHaveLength(0)
  })

  it('validates ids before calling the sync server', async () => {
    for (const ids of [[], ['n1'], 'shape:n1', Array(501).fill('shape:a'), [42]]) {
      expect((await restore(bob, ids)).statusCode, JSON.stringify(ids).slice(0, 40)).toBe(400)
    }
    expect(sync.deletedCalls).toHaveLength(0)
  })

  it('503 when the sync server is down or answers something malformed', async () => {
    sync.unavailable = true
    expect((await list(bob)).statusCode).toBe(503)
    expect((await restore(bob)).statusCode).toBe(503)
    sync.unavailable = false
    sync.deletedList = { entries: [{ shapeId: 'not-a-shape' }], total: 1, limit: 1 }
    const res = await list(bob)
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('SYNC_UNAVAILABLE')
  })
})
