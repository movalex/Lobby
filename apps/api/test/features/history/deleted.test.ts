// GET /api/boards/:bid/deleted (view) and POST /api/boards/:bid/deleted/restore (edit): the API's
// permission checks in front of the sync server's "Recently deleted".
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
  it('lists for viewers (the sync answer, checked against the contract)', async () => {
    await grant('viewer')
    const res = await list(carol)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ entries: [ENTRY], total: 1, limit: 2000 })
    expect(sync.deletedCalls).toEqual([{ op: 'list', boardId }])
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
    expect((await list(bob)).statusCode).toBe(200)
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
