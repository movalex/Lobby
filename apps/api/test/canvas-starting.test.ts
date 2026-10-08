// K6-1 (wave K): an api that starts while it cannot reach its sync server (a deploy: 8 of 68 tickets in
// the 10-07 window got 409 NEW_CANVAS, a ~30 s reconnect stall) does not know which canvas sync runs, and
// says so: 503 CANVAS_STARTING with Retry-After, never R0's "made on the new canvas". The engine is asked
// at start-up and again until sync answers; the first request after sync is back gets its ticket. A board
// made meanwhile waits for the answer: this build never writes new_canvas = false on a guess. A sync that
// answers 404 (R0's, the rollback case) is an answer: tldraw, R0's refusals intact.
//
// Real HTTP: the api's own sync client (createHttpSyncInternalClient) against a port where nothing listens
// (sync down: connection refused), then a server on that port that answers GET /internal/canvas.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CANVAS_STARTING_ERROR, CANVAS_STARTING_RETRY_AFTER_S, NEW_CANVAS_ERROR } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHttpSyncInternalClient } from '../src/sync-internal.ts'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  INTERNAL_SECRET,
  type TestApi,
} from './helpers.ts'

/** A free port on 127.0.0.1 (listened on once, then closed: nothing answers there now). */
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const { port } = s.address() as AddressInfo
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

/** A sync stand-in on `port` answering GET /internal/canvas: excalidraw (this build) or 404 (R0's sync). */
async function syncOn(port: number, engine: 'excalidraw' | 'r0-404'): Promise<Server> {
  const s = createServer((req, res) => {
    if (req.url === '/internal/canvas' && engine === 'excalidraw')
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"engine":"excalidraw"}')
    else res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
  })
  await new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()))
  return s
}
const closeServer = (s: Server | null) =>
  s ? new Promise<void>((r) => s.close(() => r())) : Promise.resolve()

const boards = (api: TestApi) => api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM boards')
const newCanvasOf = (api: TestApi, id: string) =>
  api.db.one<{ new_canvas: boolean }>('SELECT new_canvas FROM boards WHERE id = $1', [id])

let port: number
let server: Server | null = null
let first: TestApi
let fresh: Board
interface Board {
  /** made on the new canvas (new_canvas = true) */
  made: string
  /** converted before the cut-over (new_canvas = false) */
  converted: string
}
const apis: TestApi[] = []

/** An api (over the first one's database, once there is one) whose sync is the HTTP client to `port`. */
async function apiOnPort(): Promise<TestApi> {
  const api = await createTestApi({
    ...(apis.length ? { db: first.db } : {}),
    deps: {
      syncInternal: createHttpSyncInternalClient({
        baseUrl: `http://127.0.0.1:${port}`,
        secret: INTERNAL_SECRET,
      }),
    },
  })
  apis.push(api)
  return api
}

beforeEach(async () => {
  port = await freePort()
  // the api before the deploy: its sync answered (this build), so it made a new-canvas board
  server = await syncOn(port, 'excalidraw')
  first = await apiOnPort()
  await first.login('alice') // owns Dev Studio
  const bob = await first.login('bob')
  const made = await createBoard(bob, DEV_STUDIO, 'Made on the new canvas')
  const converted = await createBoard(bob, DEV_STUDIO, 'Converted')
  await first.db.query('UPDATE boards SET new_canvas = false WHERE id = $1', [converted])
  expect((await newCanvasOf(first, made)).new_canvas).toBe(true)
  fresh = { made, converted }
  await closeServer(server)
  server = null
  // the deploy's api talks to another port, where no server ever answered: nothing pooled from the one above
  // (fetch keeps connections per origin across clients in one process)
  port = await freePort()
})
afterEach(async () => {
  await closeServer(server)
  server = null
  for (const api of apis.splice(0).reverse()) await api.close()
})

const ticket = (c: Client, id: string) => c.req('POST', `/api/boards/${id}/ticket`)

describe('K6-1: the api started while its sync is down', () => {
  it('tickets: 503 CANVAS_STARTING with Retry-After for a new-canvas board (never 409 NEW_CANVAS); a converted board is not held up', async () => {
    const api = await apiOnPort() // the deploy: a new api, sync not reachable
    const bob = await api.login('bob')
    for (let i = 0; i < 3; i++) {
      const res = await ticket(bob, fresh.made)
      expect(res.statusCode, res.body).toBe(503)
      expect(res.json().error.code).toBe(CANVAS_STARTING_ERROR)
      expect(res.headers['retry-after']).toBe(String(CANVAS_STARTING_RETRY_AFTER_S))
      expect(res.json().error.code).not.toBe(NEW_CANVAS_ERROR)
      api.clock.advance(1_000)
    }
    // a board that does not depend on the engine gets its ticket at once
    expect((await ticket(bob, fresh.converted)).statusCode).toBe(200)
    // the dashboard still lists, with no R0 "New canvas" badge on this build's boards
    const listed = await bob.req('GET', `/api/workspaces/${DEV_STUDIO}/boards`)
    expect(listed.statusCode).toBe(200)
    expect(JSON.stringify(listed.json())).not.toContain('newCanvas')
    // no access is still no access (404), whatever the engine
    const stranger = await api.login('mallory')
    expect((await ticket(stranger, fresh.made)).statusCode).toBe(404)
  })

  it('sync coming up: the next ticket succeeds (within one probe)', async () => {
    const api = await apiOnPort()
    const bob = await api.login('bob')
    expect((await ticket(bob, fresh.made)).statusCode).toBe(503)
    server = await syncOn(port, 'excalidraw')
    api.clock.advance(1_000) // past the gap between two asks before the first answer
    const res = await ticket(bob, fresh.made)
    expect(res.statusCode, res.body).toBe(200)
    expect((await ticket(bob, fresh.made)).statusCode).toBe(200)
  })

  it('board creation waits for the answer: 503 while unknown, nothing written; then new_canvas = true (never false on this build)', async () => {
    const api = await apiOnPort()
    const bob = await api.login('bob')
    const before = (await boards(api)).n
    const refused = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, {
      title: 'During the deploy',
    })
    expect(refused.statusCode, refused.body).toBe(503)
    expect(refused.json().error.code).toBe(CANVAS_STARTING_ERROR)
    expect(refused.headers['retry-after']).toBe(String(CANVAS_STARTING_RETRY_AFTER_S))
    expect((await boards(api)).n).toBe(before)
    expect(
      (
        await api.db.one<{ n: number }>(
          "SELECT count(*)::int AS n FROM boards WHERE title = 'During the deploy'",
        )
      ).n,
    ).toBe(0)
    server = await syncOn(port, 'excalidraw')
    api.clock.advance(1_000)
    const id = await createBoard(bob, DEV_STUDIO, 'After the deploy')
    expect((await newCanvasOf(api, id)).new_canvas).toBe(true)
  })

  it('the start-up asks find sync without any request', async () => {
    const api = await apiOnPort()
    const bob = await api.login('bob')
    server = await syncOn(port, 'excalidraw')
    // no request needs the engine meanwhile: the api's own start-up asks (250 ms, 500 ms, 1 s, ...) do it
    await new Promise((r) => setTimeout(r, 2_500))
    expect((await ticket(bob, fresh.made)).statusCode).toBe(200)
  })
})

describe('K6-1: a sync that answers 404 (R0’s sync, the rollback case) is an answer', () => {
  it('reads as tldraw: R0’s refusals stand (409 NEW_CANVAS), its marks show, and a new board is not marked', async () => {
    server = await syncOn(port, 'r0-404')
    const api = await apiOnPort()
    const bob = await api.login('bob')
    const res = await ticket(bob, fresh.made)
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error.code).toBe(NEW_CANVAS_ERROR)
    expect((await ticket(bob, fresh.converted)).statusCode).toBe(200)
    const listed = await bob.req('GET', `/api/workspaces/${DEV_STUDIO}/boards`)
    const made = (listed.json() as { boards: { id: string; newCanvas?: boolean }[] }).boards.find(
      (b) => b.id === fresh.made,
    )
    expect(made?.newCanvas).toBe(true)
    const id = await createBoard(bob, DEV_STUDIO, 'On R0')
    expect((await newCanvasOf(api, id)).new_canvas).toBe(false)
  })
})
