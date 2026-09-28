// POST /internal/boards/:bid/place-notes (private brainstorming): the layout, the validation, and the
// endpoint on a real server with real TLSyncClients over WebSocket (what the API calls at reveal).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { NodeSqliteWrapper, SQLiteSyncStorage } from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'
import { afterEach, describe, expect, it } from 'vitest'
import { createSyncServer } from '../../src/app.ts'
import {
  estimateGrowY,
  FRAME_PAD,
  indicesAbove,
  layoutGrid,
  NOTE_SIZE,
  type PlaceNotesRequest,
  parsePlaceRequest,
  placeNotes,
} from '../../src/http/place-notes.ts'
import { emptyBoardSnapshot } from '../../src/snapshot.ts'
import { noteShape, PAGE_ID, plainText, type ShapeRecord } from '../harness/records.ts'
import { NodeSyncClient } from '../harness/sync-client.ts'
import { callInternal, errorCode } from '../harness/tickets.ts'
import { waitFor } from '../harness/wait.ts'
import { startServer, type TestServer, testConfig } from './helpers.ts'

const BOARD = 'b-placenotes'
const SESSION = 'pbs_AAAAAAAAAAAAAAAAAAAA'
const ALICE = 'usr_aliceAAAAAAAAAAAA'
const BOB = 'usr_bobBBBBBBBBBBBBBBB'
const noteId = (n: number) => `pnt_${String(n).padStart(4, '0')}AAAAAAAAAAAAAAAA`

let servers: TestServer[] = []
let clients: NodeSyncClient[] = []
afterEach(async () => {
  for (const c of clients) c.dispose()
  await Promise.all(servers.map((s) => s.stop()))
  servers = []
  clients = []
})

function frameShape(id: string, over: { x?: number; y?: number; w?: number; h?: number } = {}): ShapeRecord {
  const rec = {
    id: `shape:${id}`,
    typeName: 'shape',
    type: 'frame',
    x: over.x ?? 1000,
    y: over.y ?? 500,
    rotation: 0,
    index: 'a1',
    parentId: PAGE_ID,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { w: over.w ?? 1000, h: over.h ?? 600, name: 'Private ideas', color: 'black' },
  }
  draftroomSchema.types.shape.validate(rec)
  return rec as unknown as ShapeRecord
}

function request(over: Partial<PlaceNotesRequest> = {}): PlaceNotesRequest {
  return {
    sessionId: SESSION,
    anonymous: false,
    frame: { id: 'shape:frame1', pageId: PAGE_ID, x: 1000, y: 500, w: 1000, h: 600, name: 'Private ideas' },
    notes: [
      { id: noteId(1), text: 'Alice one', color: 'yellow', authorId: ALICE },
      { id: noteId(2), text: 'Alice two', color: 'blue', authorId: ALICE },
      { id: noteId(3), text: 'Bob one', color: 'green', authorId: BOB },
    ],
    authors: [
      { id: ALICE, name: 'Alice Park', color: '#3355ff' },
      { id: BOB, name: 'Bob Chen', color: '#ff5533' },
    ],
    ...over,
  }
}

const anonymousRequest = (): PlaceNotesRequest =>
  request({
    anonymous: true,
    authors: [],
    notes: request().notes.map((n) => ({ ...n, authorId: null })),
  })

async function setup(board = BOARD) {
  const t = await startServer()
  servers.push(t)
  const connect = async (user: string) => {
    const c = new NodeSyncClient({ wsUrl: t.wsUrl, boardId: board, user })
    clients.push(c)
    await c.waitForSynced()
    return c
  }
  return { t, connect }
}

const place = (t: { url: string }, body: unknown, board = BOARD) =>
  callInternal(t.url, 'POST', `/internal/boards/${board}/place-notes`, { body })

const notesOf = (c: NodeSyncClient) =>
  c.shapes().filter((s) => s.type === 'note' && (s.meta as { drPrivateNote?: unknown }).drPrivateNote)

describe('layout', () => {
  it('fills rows inside the frame, keeps author groups together and grows the frame to hold them', () => {
    const items = [
      { id: 'a1', height: 200, group: 'a' },
      { id: 'a2', height: 200, group: 'a' },
      { id: 'b1', height: 260, group: 'b' },
      { id: 'b2', height: 200, group: 'b' },
      { id: 'b3', height: 200, group: 'b' },
      { id: 'c1', height: 200, group: 'c' },
    ]
    // 1000 wide: (1000 - 80 + 24) / 224 = 4 columns.
    const out = layoutGrid({ frameW: 1000, frameH: 300, contentBottom: null, items })
    const pos = (id: string) => out.positions.get(id)
    expect(pos('a1')).toEqual({ x: FRAME_PAD, y: FRAME_PAD })
    expect(pos('a2')).toEqual({ x: FRAME_PAD + 224, y: FRAME_PAD })
    // b's three notes do not fit in the two cells left: a new row
    expect(pos('b1')).toEqual({ x: FRAME_PAD, y: FRAME_PAD + 200 + 24 })
    expect(pos('b3')?.x).toBe(FRAME_PAD + 2 * 224)
    // c fits in the last cell of b's row; that row is as tall as its tallest note
    expect(pos('c1')).toEqual({ x: FRAME_PAD + 3 * 224, y: FRAME_PAD + 224 })
    expect(out.frameW).toBe(1000)
    expect(out.frameH).toBe(FRAME_PAD + 224 + 260 + FRAME_PAD)
    // every note is inside the frame
    for (const [id, p] of out.positions) {
      const h = items.find((i) => i.id === id)?.height ?? 0
      expect(p.x + NOTE_SIZE).toBeLessThanOrEqual(out.frameW)
      expect(p.y + h).toBeLessThanOrEqual(out.frameH)
    }
  })

  it('widens a narrow frame for many notes and starts below what the frame already holds', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, height: 200, group: null }))
    const out = layoutGrid({ frameW: 300, frameH: 300, contentBottom: 250, items })
    // ceil(sqrt(20)) = 5 columns instead of 1
    const xs = new Set([...out.positions.values()].map((p) => p.x))
    expect(xs.size).toBe(5)
    expect(out.frameW).toBe(2 * FRAME_PAD + 5 * 224 - 24)
    expect(Math.min(...[...out.positions.values()].map((p) => p.y))).toBe(250 + 48)
  })

  it('estimates growY on the tall side, and none for short text', () => {
    expect(estimateGrowY('Short idea')).toBe(0)
    const long = 'word '.repeat(100).trim()
    expect(estimateGrowY(long)).toBeGreaterThan(400)
    expect(estimateGrowY('x'.repeat(500))).toBeGreaterThan(estimateGrowY('x'.repeat(100)))
  })

  it('makes index keys above a sibling, in order, valid for the schema', () => {
    const keys = indicesAbove('a5', 1000)
    expect(new Set(keys).size).toBe(1000)
    expect([...keys].sort()).toEqual(keys)
    expect(keys.every((k) => k > 'a5' && !k.endsWith('0'))).toBe(true)
    for (const k of [keys[0], keys[999], indicesAbove(null, 1)[0]]) {
      const n = { ...noteShape('k', 'x'), index: k }
      expect(() => draftroomSchema.types.shape.validate(n)).not.toThrow()
    }
  })
})

describe('the storage transaction', () => {
  it('writes nothing when one record is refused, and the storage stays usable', () => {
    const db = new DatabaseSync(':memory:')
    try {
      const storage = new SQLiteSyncStorage<TLRecord>({
        sql: new NodeSqliteWrapper(db),
        snapshot: emptyBoardSnapshot(draftroomSchema),
      })
      const keys = () => storage.transaction((txn) => [...txn.keys()]).result
      const before = keys()
      // A request that skipped parsePlaceRequest: the last note's colour is not a tldraw colour.
      const bad = {
        ...parsePlaceRequest(request()),
        notes: [
          ...parsePlaceRequest(request()).notes,
          { id: noteId(9), text: 'x', color: 'magenta', authorId: ALICE },
        ],
      }
      expect(() => placeNotes({ storage, schema: draftroomSchema, input: bad })).toThrow(/not a valid record/)
      expect(keys()).toEqual(before) // not the frame, not the first three notes, not a user record
      const ok = placeNotes({ storage, schema: draftroomSchema, input: parsePlaceRequest(request()) })
      expect(ok).toMatchObject({ frameId: 'shape:frame1', frameCreated: true, existing: [] })
      expect(ok.placed).toHaveLength(3)
      expect(keys()).toEqual(
        expect.arrayContaining(['shape:frame1', `user:${ALICE}`, `user:${BOB}`, ...ok.placed]),
      )
    } finally {
      db.close()
    }
  })
})

describe('request validation', () => {
  it('accepts a well-formed request and refuses anything else whole', () => {
    expect(parsePlaceRequest(request()).notes).toHaveLength(3)
    expect(parsePlaceRequest(anonymousRequest()).notes.every((n) => n.authorId === null)).toBe(true)
    const bad: unknown[] = [
      null,
      { ...request(), sessionId: 'vot_AAAAAAAAAAAAAAAA' },
      { ...request(), notes: [] },
      {
        ...request(),
        notes: Array.from({ length: 1001 }, (_, i) => ({ ...request().notes[0], id: noteId(i) })),
      },
      { ...request(), notes: [{ ...request().notes[0], text: '' }] },
      { ...request(), notes: [{ ...request().notes[0], text: 'x'.repeat(501) }] },
      { ...request(), notes: [{ ...request().notes[0], text: 'bell\u0007' }] },
      { ...request(), notes: [{ ...request().notes[0], color: 'magenta' }] },
      { ...request(), notes: [{ ...request().notes[0], id: 'shape:x' }] },
      { ...request(), notes: [request().notes[0], request().notes[0]] },
      { ...request(), notes: [{ ...request().notes[0], authorId: 'usr_someoneelse0000' }] },
      { ...anonymousRequest(), authors: request().authors },
      { ...anonymousRequest(), notes: [{ ...request().notes[0] }] },
      { ...request(), frame: { ...request().frame, id: 'frame1' } },
      { ...request(), frame: { ...request().frame, w: 0 } },
      { ...request(), frame: { ...request().frame, x: Number.NaN } },
      { ...request(), authors: [{ ...request().authors[0], color: 'red' }] },
    ]
    for (const b of bad) expect(() => parsePlaceRequest(b), JSON.stringify(b)?.slice(0, 80)).toThrow()
    // 500 characters counted as code points (an emoji is one)
    expect(
      parsePlaceRequest({ ...request(), notes: [{ ...request().notes[0], text: '🎉'.repeat(500) }] }),
    ).toBeTruthy()
  })
})

describe('internal place-notes endpoint', () => {
  it('places every note inside the frame for every connected client, grouped by author, with authors', async () => {
    const { t, connect } = await setup()
    const alice = await connect(ALICE)
    const bob = await connect(BOB)
    alice.put(frameShape('frame1'))
    await alice.waitForAcked()
    await waitFor(() => bob.get('shape:frame1') !== undefined)

    const res = await place(t, request())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { placed: string[]; existing: string[]; frameId: string }
    expect(body).toMatchObject({ existing: [], frameId: 'shape:frame1', frameCreated: false })
    expect(body.placed.sort()).toEqual([1, 2, 3].map((n) => `shape:${noteId(n)}`).sort())

    for (const c of [alice, bob]) {
      await waitFor(() => notesOf(c).length === 3)
      const notes = notesOf(c)
      expect(notes.every((n) => n.parentId === 'shape:frame1')).toBe(true)
      const frame = c.get('shape:frame1') as ShapeRecord
      for (const n of notes) {
        expect(n.x).toBeGreaterThanOrEqual(0)
        expect(n.y).toBeGreaterThanOrEqual(0)
        expect(n.x + NOTE_SIZE).toBeLessThanOrEqual(Number(frame.props.w))
        expect(n.y + NOTE_SIZE + Number(n.props.growY)).toBeLessThanOrEqual(Number(frame.props.h))
      }
      const byId = new Map<string, ShapeRecord>(notes.map((n) => [n.id, n]))
      const a1 = byId.get(`shape:${noteId(1)}`) as ShapeRecord
      expect(plainText(a1.props.richText)).toBe('Alice one')
      expect(a1.props.color).toBe('yellow')
      expect(a1.props.textLastEditedBy).toBe(ALICE)
      expect(a1.meta).toEqual({ drPrivateNote: { session: SESSION, author: ALICE } })
      // the author's name for tldraw's note attribution
      expect(c.get(`user:${ALICE}`)).toMatchObject({ typeName: 'user', name: 'Alice Park' })
    }
    // Alice's two notes are side by side; Bob's is after them
    const n1 = alice.get(`shape:${noteId(1)}`) as ShapeRecord
    const n2 = alice.get(`shape:${noteId(2)}`) as ShapeRecord
    expect(n2.y).toBe(n1.y)
    expect(n2.x).toBeGreaterThan(n1.x)
  })

  it('is idempotent: a second (or concurrent) call places nothing twice', async () => {
    const { t, connect } = await setup()
    const alice = await connect(ALICE)
    alice.put(frameShape('frame1'))
    await alice.waitForAcked()
    const [a, b] = await Promise.all([place(t, request()), place(t, request())])
    const bodies = (await Promise.all([a.json(), b.json()])) as { placed: string[]; existing: string[] }[]
    expect(bodies.map((x) => x.placed.length).sort()).toEqual([0, 3])
    expect(bodies.map((x) => x.existing.length).sort()).toEqual([0, 3])
    const again = (await (await place(t, request())).json()) as { placed: string[]; existing: string[] }
    expect(again).toMatchObject({ placed: [], existing: expect.any(Array) })
    expect(again.existing).toHaveLength(3)
    await waitFor(() => notesOf(alice).length === 3)
    // a later retry never adds copies
    await new Promise((r) => setTimeout(r, 100))
    expect(notesOf(alice)).toHaveLength(3)
  })

  it('anonymous: no author in meta, no textLastEditedBy, no user records', async () => {
    const { t, connect } = await setup()
    const alice = await connect(ALICE)
    alice.put(frameShape('frame1'))
    await alice.waitForAcked()
    const res = await place(t, anonymousRequest())
    expect(res.status).toBe(200)
    await waitFor(() => notesOf(alice).length === 3)
    for (const n of notesOf(alice)) {
      expect(n.meta).toEqual({ drPrivateNote: { session: SESSION } })
      expect(n.props.textLastEditedBy).toBeNull()
      expect(JSON.stringify(n)).not.toContain('usr_')
    }
    expect(alice.get(`user:${ALICE}`)).toBeUndefined()
    expect(alice.get(`user:${BOB}`)).toBeUndefined()
  })

  it('recreates a frame that was deleted, where it was, and never overwrites a user record', async () => {
    const { t, connect } = await setup()
    const alice = await connect(ALICE)
    alice.put(frameShape('other', { x: 0, y: 0 }))
    alice.put({ ...noteShape('mine', 'already here'), id: 'shape:mine' } as ShapeRecord)
    await alice.waitForAcked()
    // Alice's own user record, as her ticket says (the only way the sync server lets her write it,
    // user-records.ts): placement must not replace it with the API's name and color for her.
    alice.store.put([
      {
        id: `user:${ALICE}`,
        typeName: 'user',
        name: ALICE,
        color: '#1971c2',
        imageUrl: '',
        meta: {},
      },
    ] as never)
    await alice.waitForAcked()
    const res = await place(t, request())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ frameId: 'shape:frame1', frameCreated: true })
    await waitFor(() => alice.get('shape:frame1') !== undefined && notesOf(alice).length === 3)
    const frame = alice.get('shape:frame1') as ShapeRecord
    expect(frame).toMatchObject({ type: 'frame', parentId: PAGE_ID, x: 1000, y: 500 })
    expect(frame.props.name).toBe('Private ideas')
    expect(alice.get(`user:${ALICE}`)).toMatchObject({ name: ALICE, color: '#1971c2' })
    expect(alice.get(`user:${BOB}`)).toMatchObject({ name: 'Bob Chen' })
  })

  it('starts below what the frame already holds and survives a server restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dr-sync-place-'))
    try {
      const start = async () => {
        const server = createSyncServer(testConfig(dataDir), { log: () => {} })
        const { port } = await server.listen()
        return { server, url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}` }
      }
      const first = await start()
      const alice = new NodeSyncClient({ wsUrl: first.wsUrl, boardId: BOARD, user: ALICE })
      clients.push(alice)
      await alice.waitForSynced()
      alice.put(frameShape('frame1'))
      alice.put({
        ...noteShape('inside', 'existing'),
        id: 'shape:inside',
        parentId: 'shape:frame1',
        y: 40,
      } as ShapeRecord)
      await alice.waitForAcked()
      expect((await place(first, request())).status).toBe(200)
      alice.dispose()
      await first.server.close()

      // The room was closed with the process; the notes are in its database.
      const second = await start()
      try {
        const bob = new NodeSyncClient({ wsUrl: second.wsUrl, boardId: BOARD, user: BOB })
        clients.push(bob)
        await bob.waitForSynced()
        const notes = notesOf(bob)
        expect(notes).toHaveLength(3)
        for (const n of notes) expect(n.y).toBeGreaterThanOrEqual(40 + NOTE_SIZE)
        // and a retry after the restart still places nothing twice
        const again = (await (await place(second, request())).json()) as { placed: string[] }
        expect(again.placed).toEqual([])
      } finally {
        await second.server.close()
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  it('opens a closed room, refuses a board without canvas, and checks secret and input', async () => {
    const { t, connect } = await setup()
    const alice = await connect(ALICE)
    alice.put(frameShape('frame1'))
    await alice.waitForAcked()
    alice.dispose()
    // idleEvictMs is 50 in tests: wait until the room is closed
    await waitFor(() => t.server.registry.roomIfOpen(BOARD) === null)
    expect((await place(t, request())).status).toBe(200)

    const none = await place(t, request(), 'b-neverseen0')
    expect(none.status).toBe(409)
    expect(await errorCode(none)).toBe('NO_CANVAS')
    expect(
      (
        await callInternal(t.url, 'POST', `/internal/boards/${BOARD}/place-notes`, {
          body: request(),
          secret: null,
        })
      ).status,
    ).toBe(401)
    const bad = await place(t, { ...request(), notes: [] })
    expect(bad.status).toBe(400)
    expect((await place(t, request(), 'NOT_OK')).status).toBe(400)
    expect((await callInternal(t.url, 'GET', `/internal/boards/${BOARD}/place-notes`)).status).toBe(405)
  })
})
