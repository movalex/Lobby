// L5-1 run of show: a frame's planned minutes (`customData.lobby.present.mins`, wave L) survive a board's
// archive: export writes them, import keeps them next to the slide order (a duplicate drops only the index),
// and an archive with minutes the schema refuses (0, 241, 1.5) is refused whole, as for any other element.
import type { LobbyElementsSnapshot } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type LobbySeed,
  type RoomSnapshotJson,
  type SyncInternalClient,
  SyncSeedConflict,
} from '../../../src/sync-internal.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'

// biome-ignore lint/suspicious/noExplicitAny: elements are JSON, read field by field
type El = Record<string, any> & { id: string; type: string }

/** A sync on the Excalidraw engine: lobby-elements snapshots, seeds recorded. */
class LobbySync implements SyncInternalClient {
  boards = new Map<string, LobbyElementsSnapshot>()
  seeds: { boardId: string; body: LobbySeed }[] = []
  async engine() {
    return 'excalidraw' as const
  }
  setBoard(boardId: string, elements: El[]) {
    this.boards.set(boardId, { format: 'lobby-elements', schema: 1, clock: 7, elements, doc: {} })
  }
  async snapshot(boardId: string) {
    return structuredClone(
      this.boards.get(boardId) ?? {
        format: 'lobby-elements' as const,
        schema: 1,
        clock: 0,
        elements: [],
        doc: {},
      },
    )
  }
  async seed(boardId: string, body: LobbySeed | RoomSnapshotJson) {
    this.seeds.push({ boardId, body: structuredClone(body) as LobbySeed })
    if (this.boards.has(boardId)) throw new SyncSeedConflict()
    const lobby = body as LobbySeed
    this.setBoard(boardId, lobby.elements as El[])
    return { records: lobby.elements.length }
  }
}

const frame = (id: string, name: string, index: string, present: Record<string, unknown>): El => ({
  id,
  type: 'frame',
  name,
  x: index === 'a0' ? 0 : 1000,
  y: 0,
  width: 800,
  height: 450,
  angle: 0,
  strokeColor: '#bbb',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roundness: null,
  roughness: 0,
  opacity: 100,
  seed: 1,
  version: 3,
  versionNonce: 9,
  index,
  isDeleted: false,
  groupIds: [],
  frameId: null,
  boundElements: null,
  updated: 1,
  created: 1,
  link: null,
  locked: false,
  customData: { lobby: { present } },
})

let api: TestApi
let sync: LobbySync
let bob: Client
let boardId: string

beforeEach(async () => {
  sync = new LobbySync()
  api = await createTestApi({ deps: { syncInternal: sync } })
  await api.login('owner')
  bob = await api.login('bob')
  boardId = await createBoard(bob, DEV_STUDIO, 'Retro')
  sync.setBoard(boardId, [
    frame('F1', 'Warm-up', 'a0', { index: 0, mins: 7 }),
    frame('F2', 'Ideas', 'a1', { index: 1, skip: true, mins: 240 }),
  ])
})
afterEach(() => api.close())

const presentOf = (els: El[], name: string) =>
  els.find((e) => e.type === 'frame' && e.name === name)?.customData?.lobby?.present

describe('a frame’s planned minutes in the board archive', () => {
  it('are in the exported archive, next to the slide order and the skip mark', async () => {
    const res = await bob.req('GET', `/api/boards/${boardId}/export`)
    expect(res.statusCode, res.body).toBe(200)
    const archive = res.json() as { elements: El[] }
    expect(presentOf(archive.elements, 'Warm-up')).toEqual({ index: 0, mins: 7 })
    expect(presentOf(archive.elements, 'Ideas')).toEqual({ index: 1, skip: true, mins: 240 })
  })

  it('an export then an import keeps the minutes (and the order and skip), on fresh ids', async () => {
    const archive = (await bob.req('GET', `/api/boards/${boardId}/export`)).json()
    const res = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards/import?title=Copy`, archive)
    expect(res.statusCode, res.body).toBe(201)
    const seed = sync.seeds.at(-1)?.body as { elements: El[] }
    expect(seed.elements.map((e) => e.id)).not.toContain('F1')
    expect(presentOf(seed.elements, 'Warm-up')).toEqual({ index: 0, mins: 7 })
    expect(presentOf(seed.elements, 'Ideas')).toEqual({ index: 1, skip: true, mins: 240 })
  })

  it('a duplicate of the board keeps the minutes too (only the slide index is dropped on a copy of one frame)', async () => {
    const res = await bob.req('POST', `/api/boards/${boardId}/duplicate`, {})
    expect(res.statusCode, res.body).toBe(201)
    const seed = sync.seeds.at(-1)?.body as { elements: El[] }
    expect(presentOf(seed.elements, 'Warm-up')?.mins).toBe(7)
    expect(presentOf(seed.elements, 'Ideas')?.mins).toBe(240)
  })

  it('an archive with minutes the schema refuses is refused whole (nothing is imported)', async () => {
    const archive = (await bob.req('GET', `/api/boards/${boardId}/export`)).json() as { elements: El[] }
    const seeds = sync.seeds.length
    for (const mins of [0, 241, 1.5, '5', -1]) {
      const bad = structuredClone(archive)
      const f = bad.elements.find((e) => e.name === 'Warm-up') as El
      f.customData.lobby.present.mins = mins
      const res = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards/import`, bad)
      expect(res.statusCode, `mins ${String(mins)}: ${res.body}`).toBe(400)
      expect(res.json().error.code).toBe('INVALID_ARCHIVE')
    }
    expect(sync.seeds).toHaveLength(seeds)
  })
})
