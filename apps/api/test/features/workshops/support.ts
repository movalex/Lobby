// Shared setup for the workshops API tests: one board in Dev Studio with a person per role, a fake
// sync server whose snapshot is a mutable shape list, and a recorder for every published event.

import type { LightMyRequestResponse } from 'fastify'
import { type DeliveredEvent, EventHub } from '../../../src/events/hub.ts'
import type { RoomSnapshotJson, SyncInternalClient } from '../../../src/sync-internal.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'

export interface FakeShape {
  id: string
  type: string
  parentId: string
}

export class FakeSync implements SyncInternalClient {
  readonly boards = new Map<string, Map<string, FakeShape>>()
  snapshots = 0
  down = false

  add(boardId: string, ...shapes: FakeShape[]) {
    let m = this.boards.get(boardId)
    if (!m) {
      m = new Map()
      this.boards.set(boardId, m)
    }
    for (const s of shapes) m.set(s.id, s)
  }

  async snapshot(boardId: string): Promise<RoomSnapshotJson> {
    this.snapshots++
    if (this.down) throw new Error('sync down')
    const shapes = [...(this.boards.get(boardId)?.values() ?? [])]
    return {
      documents: [
        { state: { typeName: 'document', id: 'document:document' } },
        { state: { typeName: 'page', id: 'page:page' } },
        ...shapes.map((s) => ({ state: { typeName: 'shape', ...s, props: {} } })),
      ],
    }
  }

  async seed(): Promise<{ records: number }> {
    return { records: 0 }
  }
}

export interface World {
  api: TestApi
  /** The app clock (frozen; only moves when advanced). */
  clock: { advance(ms: number): void; now(): Date }
  sync: FakeSync
  hub: EventHub
  boardId: string
  /** Everything published for the board, in order. */
  events: DeliveredEvent[]
  owner: Client // Dev Studio owner (board owner through the workspace)
  editor: Client
  commenter: Client
  viewer: Client
  outsider: Client // Dev Studio member without access to the private board
  /** Every response body seen through `track`, per user id (for the privacy assertions). */
  seen: Map<string, string[]>
  track(c: Client): Client
}

const PAGE = 'page:page'
export const note = (id: string, parentId = PAGE): FakeShape => ({
  id: `shape:${id}`,
  type: 'note',
  parentId,
})

export async function setupWorld(): Promise<World> {
  const sync = new FakeSync()
  const hub = new EventHub()
  // A frozen clock (the helpers' clock follows real time, which would make ms-exact timer checks flaky).
  let t = Date.now()
  const clock = {
    advance: (ms: number) => {
      t += ms
    },
    now: () => new Date(t),
  }
  const api = await createTestApi({ deps: { events: hub, syncInternal: sync, now: clock.now } })
  const owner = await api.login('ada', 'Ada Owner')
  const editor = await api.login('ed', 'Ed Editor')
  const commenter = await api.login('cora', 'Cora Commenter')
  const viewer = await api.login('vic', 'Vic Viewer')
  const outsider = await api.login('otto', 'Otto Outsider')
  const boardId = await createBoard(owner, DEV_STUDIO, 'Workshop')
  for (const [c, role] of [
    [editor, 'editor'],
    [commenter, 'commenter'],
    [viewer, 'viewer'],
  ] as const) {
    const res = await owner.req('PUT', `/api/boards/${boardId}/members/${c.userId}`, { role })
    if (res.statusCode !== 200) throw new Error(`grant ${role} failed: ${res.statusCode} ${res.body}`)
  }
  const events: DeliveredEvent[] = []
  hub.subscribe(boardId, (e) => events.push(e))
  const seen = new Map<string, string[]>()
  const track = (c: Client): Client => ({
    ...c,
    req: async (...args) => {
      const res: LightMyRequestResponse = await c.req(...args)
      const list = seen.get(c.userId) ?? []
      list.push(res.body)
      seen.set(c.userId, list)
      return res
    },
  })
  return { api, clock, sync, hub, boardId, events, owner, editor, commenter, viewer, outsider, seen, track }
}

export const json = <T = Record<string, unknown>>(res: LightMyRequestResponse) => res.json() as T

export function expectStatus(res: LightMyRequestResponse, status: number) {
  if (res.statusCode !== status) throw new Error(`expected ${status}, got ${res.statusCode}: ${res.body}`)
}
