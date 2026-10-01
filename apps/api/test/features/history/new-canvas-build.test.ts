// Bridge release R0's contracts on the new canvas (docs/DEPLOY.md "Bridge release R0", migration 0022;
// wave 5, 2A): when this api's sync runs the Excalidraw engine (GET /internal/canvas, canvas-engine.ts),
//   - every board it creates (new, duplicate, restore as new, import) gets `boards.new_canvas = true`;
//     converted boards (made before) keep false;
//   - every checkpoint body made on it is stored with `body_version = 2`; "unchanged" compares with the
//     newest checkpoint of the same body version;
//   - R0's refusals of such boards and checkpoints do not apply (tickets, checkpoints, duplicate,
//     export, preview, restore), and no answer carries R0's `newCanvas` marks.
// With a tldraw sync (the fake without `engine`, or R0's sync answering 404) nothing is marked, as before
// (new-canvas.test.ts keeps R0's refusals). Failed on f336ae4: boards were created with new_canvas false
// and checkpoints with body_version 1, and a board marked new_canvas got 409 on its ticket.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkpointSettings } from '../../../src/features/history/checkpoints.ts'
import { checkpointServices } from '../../../src/features/history/index.ts'
import { createHttpSyncInternalClient, type RoomSnapshotJson } from '../../../src/sync-internal.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { createFakeSync, type FakeSync } from './helpers.ts'

let api: TestApi
let sync: FakeSync & { engine?: () => Promise<'tldraw' | 'excalidraw'> }
let bob: Client
const saved = { ...checkpointSettings }

/** The Excalidraw sync's snapshot answer for a board with one rectangle. */
const lobbyBoard = (clock: number, words = 'hello') =>
  ({
    format: 'lobby-elements',
    schema: 1,
    clock,
    elements: [{ id: 'r1', type: 'rectangle', isDeleted: false, label: words }],
    doc: {},
  }) as unknown as RoomSnapshotJson

beforeEach(async () => {
  Object.assign(checkpointSettings, { tickMs: 0, pruneEveryMs: 0 })
  sync = createFakeSync()
  sync.engine = async () => 'excalidraw'
  // the Excalidraw sync answers its boards as elements
  const snapshot = sync.snapshot
  sync.snapshot = async (id) => (sync.boards.has(id) ? snapshot(id) : lobbyBoard(1))
  api = await createTestApi({ deps: { syncInternal: sync } })
  await api.login('alice') // owns Dev Studio
  bob = await api.login('bob')
})
afterEach(async () => {
  Object.assign(checkpointSettings, saved)
  await api.close()
})

const row = (id: string) =>
  api.db.one<{ new_canvas: boolean }>('SELECT new_canvas FROM boards WHERE id = $1', [id])
const bodyVersion = (id: string) =>
  api.db.one<{ body_version: number }>('SELECT body_version FROM board_snapshots WHERE id = $1', [id])

describe('on the new canvas, the api marks what it makes and refuses none of it', () => {
  it('a new board is new_canvas, carries no R0 mark, and gets its ticket', async () => {
    const id = await createBoard(bob, DEV_STUDIO, 'Fresh')
    expect((await row(id)).new_canvas).toBe(true)
    const one = await bob.req('GET', `/api/boards/${id}`)
    expect(one.statusCode, one.body).toBe(200)
    expect(JSON.stringify(one.json())).not.toContain('newCanvas')
    const listed = await bob.req('GET', `/api/workspaces/${DEV_STUDIO}/boards`)
    expect(JSON.stringify(listed.json())).not.toContain('newCanvas')
    const ticket = await bob.req('POST', `/api/boards/${id}/ticket`)
    expect(ticket.statusCode, ticket.body).toBe(200)
  })

  it('checkpoints made on it are body_version 2, listed without a mark, previewed, restored, duplicated and exported', async () => {
    const id = await createBoard(bob, DEV_STUDIO, 'Pitch')
    const made = await bob.req('POST', `/api/boards/${id}/snapshots`, { name: 'Draft' })
    expect(made.statusCode, made.body).toBe(201)
    const sid = made.json().id as string
    expect(made.json()).not.toHaveProperty('newCanvas')
    expect(Number((await bodyVersion(sid)).body_version)).toBe(2)
    const listed = await bob.req('GET', `/api/boards/${id}/snapshots`)
    expect(JSON.stringify(listed.json())).not.toContain('newCanvas')
    const preview = await bob.req('GET', `/api/snapshots/${sid}/content`)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ format: 'lobby-elements' })
    const restored = await bob.req('POST', `/api/snapshots/${sid}/restore-as-new`, {})
    expect(restored.statusCode, restored.body).toBe(201)
    const restoredId = (restored.json() as { board: { id: string } }).board.id
    expect((await row(restoredId)).new_canvas).toBe(true)
    expect(JSON.stringify(restored.json())).not.toContain('newCanvas')
    const dup = await bob.req('POST', `/api/boards/${id}/duplicate`, {})
    expect(dup.statusCode, dup.body).toBe(201)
    expect((await row((dup.json() as { board: { id: string } }).board.id)).new_canvas).toBe(true)
    const exported = await bob.req('GET', `/api/boards/${id}/export`)
    expect(exported.statusCode, exported.body).toBe(200)
  })

  it('automatic checkpoints save v2 bodies and see an unchanged board as unchanged', async () => {
    const id = await createBoard(bob, DEV_STUDIO, 'Auto')
    sync.snapshot = async () => lobbyBoard(5)
    const service = checkpointServices.get(api.app)
    if (!service) throw new Error('no checkpoint service')
    const first = await service.capture(id, 'hourly')
    expect(first.status).toBe('saved')
    const sid = (first as { checkpoint: { id: string } }).checkpoint.id
    expect(Number((await bodyVersion(sid)).body_version)).toBe(2)
    expect((await service.capture(id, 'hourly')).status).toBe('unchanged')
    sync.snapshot = async () => lobbyBoard(6, 'changed')
    expect((await service.capture(id, 'hourly')).status).toBe('saved')
  })

  it('a converted board (made before, new_canvas false) keeps false', async () => {
    sync.engine = undefined
    const id = await createBoard(bob, DEV_STUDIO, 'Before the move')
    expect((await row(id)).new_canvas).toBe(false)
  })
})

describe('the sync engine probe', () => {
  it('reads GET /internal/canvas; R0’s sync (404) is tldraw', async () => {
    let answer: { status: number; body: string } = { status: 200, body: '{"engine":"excalidraw"}' }
    const seen: string[] = []
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers['x-draftroom-internal'] ? 'secret' : 'none'}`)
      res.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const client = createHttpSyncInternalClient({ baseUrl: url, secret: 'test-internal-secret' })
      expect(await client.engine?.()).toBe('excalidraw')
      answer = { status: 404, body: '{}' }
      expect(await client.engine?.()).toBe('tldraw')
      answer = { status: 200, body: '{"engine":"tldraw"}' }
      expect(await client.engine?.()).toBe('tldraw')
      answer = { status: 500, body: '{}' }
      await expect(client.engine?.()).rejects.toThrow()
      expect(seen[0]).toBe('GET /internal/canvas secret')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
