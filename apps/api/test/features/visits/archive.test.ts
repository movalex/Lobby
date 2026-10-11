// Wave N, N4-1: the archive export, a duplicate and a checkpoint never carry a visit time or the table's rows (the owner's
// condition: nobody else ever sees who visited when). The Excalidraw archive is built from the board's elements and
// document only; this holds it there.
import { visitPath } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LobbySeed, RoomSnapshotJson, SyncInternalClient } from '../../../src/sync-internal.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'

class LobbySync implements SyncInternalClient {
  seeds: { boardId: string; body: RoomSnapshotJson | LobbySeed }[] = []
  async engine() {
    return 'excalidraw' as const
  }
  async snapshot(_boardId: string) {
    return {
      format: 'lobby-elements' as const,
      schema: 1 as const,
      clock: 3,
      elements: [
        {
          id: 'R1',
          type: 'rectangle',
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          angle: 0,
          strokeColor: '#1e1e1e',
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
          index: 'a1',
          isDeleted: false,
          groupIds: [],
          frameId: null,
          boundElements: null,
          updated: 1,
          created: 1,
          link: null,
          locked: false,
        },
      ],
      doc: {},
    }
  }
  async seed(boardId: string, body: RoomSnapshotJson | LobbySeed) {
    this.seeds.push({ boardId, body: structuredClone(body) })
    return { records: 1 }
  }
}

let api: TestApi
let bob: Client
let board: string
beforeEach(async () => {
  api = await createTestApi({ deps: { syncInternal: new LobbySync() } })
  await api.login('alice')
  bob = await api.login('bob')
  board = await createBoard(bob, DEV_STUDIO, 'Retro')
})
afterEach(() => api.close())

const visits = async () =>
  (await api.db.query<{ board_id: string; user_id: string; seen_at: Date }>('SELECT * FROM board_visits'))
    .rows

describe('visit times stay out of every copy of a board', () => {
  it('the archive export has no visit time and no visitor', async () => {
    const seen = (await bob.req('POST', visitPath(board))).json() as { seenAt: number }
    expect(await visits()).toHaveLength(1)
    const res = await bob.req('GET', `/api/boards/${board}/export`)
    expect(res.statusCode).toBe(200)
    const text = res.body
    expect(text).not.toContain(String(seen.seenAt))
    expect(text).not.toContain(new Date(seen.seenAt).toISOString())
    expect(text).not.toContain(bob.userId)
    expect(text).not.toMatch(/visit|seen_at|previousSeenAt|board_visits/i)
  })

  it('a duplicate, an import and a checkpoint start with no visits of their own', async () => {
    await bob.req('POST', visitPath(board))
    const dup = await bob.req('POST', `/api/boards/${board}/duplicate`, {})
    expect(dup.statusCode).toBe(201)
    const archive = (await bob.req('GET', `/api/boards/${board}/export`)).json()
    const imported = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards/import?title=Copy`, archive)
    expect(imported.statusCode).toBe(201)
    const saved = await bob.req('POST', `/api/boards/${board}/snapshots`, { name: 'v' })
    expect(saved.statusCode).toBe(201)
    const content = await bob.req('GET', `/api/snapshots/${saved.json().id}/content`)
    expect(content.body).not.toMatch(/visit|seen_at|previousSeenAt/i)
    const rows = await visits()
    expect(rows.map((r) => r.board_id)).toEqual([board]) // the original board's one row, nobody's copy
  })
})
