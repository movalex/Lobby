// Shared pieces of the selective-restore api tests (wave L, L7-2; restore-elements.test.ts and its real-Postgres
// twin restore-elements.pg.test.ts): a sync double on the Excalidraw engine that serves lobby-elements snapshots
// (what the checkpoints are made from) and the internal restore-elements route, answering what a test sets.

import type { LobbyElementsSnapshot, RestoreElementsBody } from '@draftroom/contracts'
import { expect } from 'vitest'
import type { RestoreSyncAnswer } from '../../../src/features/history/restore-elements.ts'
import { type LobbySeed, type RoomSnapshotJson, SyncSeedConflict } from '../../../src/sync-internal.ts'
import { type Client, createBoard, DEV_STUDIO, type TestApi } from '../../helpers.ts'

// biome-ignore lint/suspicious/noExplicitAny: elements are JSON, read field by field
export type El = Record<string, any> & { id: string; type: string }

export const base = (id: string, type: string, o: Record<string, unknown> = {}): El => ({
  id,
  type,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
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
  ...o,
})
const label = (id: string, containerId: string, words: string, index: string): El =>
  base(id, 'text', {
    index,
    containerId,
    fontSize: 20,
    fontFamily: 6,
    baseFontSize: null,
    text: words,
    originalText: words,
    textAlign: 'center',
    verticalAlign: 'middle',
    autoResize: true,
    lineHeight: 1.25,
  })
/** A note with its label (`<id>.t`). */
export const noteWith = (id: string, words: string, index: string, o: Record<string, unknown> = {}): El[] => [
  base(id, 'stickynote', {
    baseHeight: 200,
    created: null,
    index,
    boundElements: [{ id: `${id}.t`, type: 'text' }],
    ...o,
  }),
  label(`${id}.t`, id, words, `${index}V`),
]

/** Three notes in a row and a box. */
export const board = (): El[] => [
  ...noteWith('n1', 'first', 'a1', { x: 0 }),
  ...noteWith('n2', 'second', 'a2', { x: 300 }),
  ...noteWith('n3', 'third', 'a3', { x: 600 }),
  base('box', 'rectangle', { index: 'a4', x: 0, y: 400 }),
]

export interface RestoreCall {
  boardId: string
  body: RestoreElementsBody
  /** snapshots taken before this call reached the sync (the checkpoint before it) */
  snapshotsBefore: number
}

/** A sync on the Excalidraw engine with the restore route. */
export class RestoreSync {
  boards = new Map<string, LobbyElementsSnapshot>()
  snapshots = 0
  calls: RestoreCall[] = []
  /** what the next restores answer (a status and a body); default: 200 with what was asked restored */
  answers: RestoreSyncAnswer[] = []
  /** how long each restore takes (to overlap two of them) */
  delayMs = 0
  inFlight = 0
  maxInFlight = 0
  async engine() {
    return 'excalidraw' as const
  }
  setBoard(boardId: string, elements: El[], clock = 7) {
    this.boards.set(boardId, { format: 'lobby-elements', schema: 1, clock, elements, doc: {} })
  }
  async snapshot(boardId: string) {
    this.snapshots++
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
  async seed(boardId: string, body: RoomSnapshotJson | LobbySeed) {
    if (this.boards.has(boardId)) throw new SyncSeedConflict()
    const lobby = body as LobbySeed
    this.setBoard(boardId, (lobby.elements ?? []) as El[], 1)
    return { records: (lobby.elements ?? []).length }
  }
  async restoreElements(boardId: string, body: RestoreElementsBody): Promise<RestoreSyncAnswer> {
    this.calls.push({ boardId, body: structuredClone(body), snapshotsBefore: this.snapshots })
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
      const set = this.answers.shift()
      if (set) return set
      // the default: the copies written into the board (its clock moves), what was asked restored
      const snap = this.boards.get(boardId)
      if (snap) {
        const byId = new Map(snap.elements.map((e) => [e.id as string, e]))
        for (const el of body.elements) byId.set(el.id, { ...el, version: 99 })
        this.setBoard(boardId, [...byId.values()] as El[], snap.clock + 1)
      }
      return {
        status: 200,
        body: { restored: body.elements.map((e) => e.id), skipped: [], clock: (snap?.clock ?? 0) + 1 },
      }
    } finally {
      this.inFlight--
    }
  }
}

export interface RestoreWorld {
  api: TestApi
  sync: RestoreSync
  bob: Client
  boardId: string
  /** a manual checkpoint of `board()` */
  checkpointId: string
}

/** bob's board holding `board()`, a manual checkpoint of it, then n1 and the box moved and n2 deleted. */
export async function restoreWorld(api: TestApi, sync: RestoreSync): Promise<RestoreWorld> {
  await api.login('owner')
  const bob = await api.login('bob')
  const boardId = await createBoard(bob, DEV_STUDIO, 'Retro')
  sync.setBoard(boardId, board())
  const saved = await bob.req('POST', `/api/boards/${boardId}/snapshots`, { name: 'After the workshop' })
  expect(saved.statusCode, saved.body).toBe(201)
  const now = board()
    .filter((e) => e.id !== 'n2' && e.id !== 'n2.t')
    .map((e) => (e.id === 'n1' || e.id === 'box' ? { ...e, x: e.x + 1000, version: 5 } : e))
  sync.setBoard(boardId, now, 9)
  return { api, sync, bob, boardId, checkpointId: (saved.json() as { id: string }).id }
}

export const restorePath = (boardId: string, snapshotId: string) =>
  `/api/boards/${boardId}/snapshots/${snapshotId}/restore-elements`

/** Two restores of one board at once: both get their own checkpoint first, and their writes never overlap. */
export async function twoRestoresAtOnce(w: RestoreWorld): Promise<void> {
  w.sync.delayMs = 60
  const [one, two] = await Promise.all([
    w.bob.req('POST', restorePath(w.boardId, w.checkpointId), { ids: ['n1'] }),
    w.bob.req('POST', restorePath(w.boardId, w.checkpointId), { ids: ['n2'] }),
  ])
  expect(one.statusCode, one.body).toBe(200)
  expect(two.statusCode, two.body).toBe(200)
  const a = one.json() as { checkpointId: string }
  const b = two.json() as { checkpointId: string }
  expect(a.checkpointId).not.toBe(b.checkpointId)
  expect(w.sync.maxInFlight).toBe(1)
  expect(w.sync.calls.map((c) => c.body.ids)).toEqual(expect.arrayContaining([['n1'], ['n2']]))
  // each write came after its own checkpoint read the board: the second one saw the first one's write
  expect(w.sync.calls[1]?.snapshotsBefore).toBeGreaterThan(w.sync.calls[0]?.snapshotsBefore ?? 0)
  const rows = await w.api.db.query<{ id: string; reason: string }>(
    "SELECT id, reason FROM board_snapshots WHERE board_id = $1 AND reason = 'before_restore'",
    [w.boardId],
  )
  expect(rows.rows.map((r) => r.id).sort()).toEqual([a.checkpointId, b.checkpointId].sort())
}
