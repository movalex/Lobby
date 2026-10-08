// K6-3: an accepted thumbnail upload or removal is announced on the board's event stream as a content-free
// hint (THUMBNAIL_UPDATED_EVENT: the new version, or null), after it commits, so the other editors' clients
// skip theirs. A refused upload (429 inside the per-board window, 403, 400) announces nothing, and the
// api's per-board window is unchanged: one accepted upload or removal per THUMBNAIL_MIN_INTERVAL_MS.
import {
  THUMBNAIL_MIN_INTERVAL_MS,
  THUMBNAIL_UPDATED_EVENT,
  ThumbnailUpdatedEvent,
  ThumbnailUploaded,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DeliveredEvent, EventHub } from '../../../src/events/hub.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { png } from './images.ts'

let api: TestApi
let events: EventHub
let bob: Client
let carol: Client
let board: string
let heard: DeliveredEvent[]

beforeEach(async () => {
  events = new EventHub()
  api = await createTestApi({ deps: { events } })
  await api.login('alice')
  bob = await api.login('bob')
  carol = await api.login('carol')
  board = await createBoard(bob, DEV_STUDIO, 'Thumbnail events')
  heard = []
  events.subscribe(board, (e) => heard.push(e))
})
afterEach(() => api.close())

const put = (c: Client) =>
  c.req('PUT', `/api/boards/${board}/thumbnail`, png(48, 30), { 'content-type': 'image/png' })
const thumbnailEvents = () => heard.filter((e) => e.type === THUMBNAIL_UPDATED_EVENT)

describe('K6-3: thumbnail.updated on the board event stream', () => {
  it('an accepted upload announces its version; a removal announces null; nothing else is in it', async () => {
    const res = await put(bob)
    expect(res.statusCode, res.body).toBe(200)
    const { version } = ThumbnailUploaded.parse(res.json()).thumbnail
    expect(thumbnailEvents().map((e) => e.data)).toEqual([{ version }])
    expect(ThumbnailUpdatedEvent.strict().safeParse(thumbnailEvents()[0]?.data).success).toBe(true)
    // the version is not content: anyone on the board can read it anyway (GET /thumbnail/meta)
    api.clock.advance(THUMBNAIL_MIN_INTERVAL_MS)
    const removed = await bob.req('DELETE', `/api/boards/${board}/thumbnail`)
    expect(removed.statusCode).toBe(204)
    expect(thumbnailEvents().map((e) => e.data)).toEqual([{ version }, { version: null }])
    // a removal with nothing stored is no change: no event
    api.clock.advance(THUMBNAIL_MIN_INTERVAL_MS)
    expect((await bob.req('DELETE', `/api/boards/${board}/thumbnail`)).statusCode).toBe(204)
    expect(thumbnailEvents()).toHaveLength(2)
  })

  it(`refused uploads announce nothing, and the per-board window is unchanged (${THUMBNAIL_MIN_INTERVAL_MS / 1000} s)`, async () => {
    expect(THUMBNAIL_MIN_INTERVAL_MS).toBe(30_000)
    await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'editor' })
    expect((await put(bob)).statusCode).toBe(200)
    const inside = await put(carol) // another editor inside the board's window
    expect(inside.statusCode).toBe(429)
    expect(Number(inside.headers['retry-after'])).toBeGreaterThan(0)
    api.clock.advance(THUMBNAIL_MIN_INTERVAL_MS - 1_000)
    expect((await put(carol)).statusCode).toBe(429)
    const bad = await carol.req('PUT', `/api/boards/${board}/thumbnail`, Buffer.from('not an image'), {
      'content-type': 'image/png',
    })
    expect([400, 429]).toContain(bad.statusCode)
    expect(thumbnailEvents()).toHaveLength(1)
    api.clock.advance(1_000)
    expect((await put(carol)).statusCode).toBe(200)
    expect(thumbnailEvents()).toHaveLength(2)
  })
})
