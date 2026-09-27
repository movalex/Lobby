// Shared pieces of the history API tests: a controllable in-memory stand-in for the sync server
// (snapshot / seed / recently deleted), plain tldraw records, and real file uploads.
import { draftroomSchema } from '@draftroom/canvas-schema'
import type { AssetVersionMeta } from '@draftroom/dev-assets'
import type { EventHub } from '../../../src/events/hub.ts'
import { type RoomSnapshotJson, SyncSeedConflict, SyncUnavailable } from '../../../src/sync-internal.ts'
import type { Client, TestApi } from '../../helpers.ts'

export type Rec = Record<string, unknown> & { id: string; typeName: string }

export interface FakeSync {
  boards: Map<string, RoomSnapshotJson>
  seeds: { boardId: string; snapshot: RoomSnapshotJson }[]
  snapshots: string[]
  deletedCalls: { op: 'list' | 'restore'; boardId: string; ids?: string[] }[]
  /** Next `n` seeds answer 409 (the id already has canvas data). */
  conflicts: number
  unavailable: boolean
  deletedList: unknown
  restoreResult: unknown
  setBoard(boardId: string, records: Rec[]): void
  records(boardId: string): Rec[]
  snapshot(boardId: string): Promise<RoomSnapshotJson>
  seed(boardId: string, snapshot: RoomSnapshotJson): Promise<{ records: number }>
  listDeleted(boardId: string, limit?: number): Promise<unknown>
  restoreDeleted(boardId: string, ids: string[]): Promise<unknown>
}

export const SCHEMA = draftroomSchema.serialize()

export function createFakeSync(): FakeSync {
  const fake: FakeSync = {
    boards: new Map(),
    seeds: [],
    snapshots: [],
    deletedCalls: [],
    conflicts: 0,
    unavailable: false,
    deletedList: { entries: [], total: 0, limit: 2000 },
    restoreResult: { restored: [], skipped: [], bindings: 0, reparented: 0 },
    setBoard(boardId, records) {
      fake.boards.set(boardId, {
        documentClock: 42,
        tombstoneHistoryStartsAtClock: 0,
        tombstones: {},
        schema: SCHEMA,
        documents: records.map((state) => ({ state, lastChangedClock: 42 })),
      })
    },
    records(boardId) {
      return (fake.boards.get(boardId)?.documents ?? []).map((d) => d.state as Rec)
    },
    async snapshot(boardId) {
      if (fake.unavailable) throw new SyncUnavailable('sync unreachable: test')
      fake.snapshots.push(boardId)
      const snap = fake.boards.get(boardId)
      // like the real server: a board without storage looks like a fresh empty board
      return snap
        ? structuredClone(snap)
        : {
            documentClock: 0,
            schema: SCHEMA,
            documents: baseRecords().map((state) => ({ state, lastChangedClock: 0 })),
          }
    },
    async seed(boardId, snapshot) {
      if (fake.unavailable) throw new SyncUnavailable('sync unreachable: test')
      fake.seeds.push({ boardId, snapshot: structuredClone(snapshot) })
      if (fake.conflicts > 0) {
        fake.conflicts--
        throw new SyncSeedConflict()
      }
      if (fake.boards.has(boardId)) throw new SyncSeedConflict()
      fake.boards.set(boardId, { ...structuredClone(snapshot), documentClock: 0 })
      return { records: snapshot.documents.length }
    },
    async listDeleted(boardId) {
      if (fake.unavailable) throw new SyncUnavailable('sync unreachable: test')
      fake.deletedCalls.push({ op: 'list', boardId })
      return structuredClone(fake.deletedList)
    },
    async restoreDeleted(boardId, ids) {
      if (fake.unavailable) throw new SyncUnavailable('sync unreachable: test')
      fake.deletedCalls.push({ op: 'restore', boardId, ids })
      return structuredClone(fake.restoreResult)
    },
  }
  return fake
}

// ---- records (plain JSON, valid for draftroomSchema) ---------------------------------------------------

export const PAGE = 'page:page'

export function baseRecords(): Rec[] {
  return [
    { id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta: {} },
    { id: PAGE, typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
  ]
}

const shapeBase = (id: string, type: string, index: string, x = 0, y = 0) => ({
  id: `shape:${id}`,
  typeName: 'shape',
  type,
  x,
  y,
  rotation: 0,
  index,
  parentId: PAGE,
  isLocked: false,
  opacity: 1,
  meta: {},
})

export function noteRec(id: string, text: string, index = 'a1'): Rec {
  return {
    ...shapeBase(id, 'note', index),
    props: {
      color: 'yellow',
      labelColor: 'black',
      size: 'm',
      font: 'draw',
      fontSizeAdjustment: 1,
      align: 'middle',
      verticalAlign: 'middle',
      growY: 0,
      url: '',
      richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
      scale: 1,
      textLastEditedBy: null,
    },
  }
}

export function imageAssetRec(id: string, assetId: string, versionId: string): Rec {
  return {
    id: `asset:${id}`,
    typeName: 'asset',
    type: 'image',
    props: {
      w: 640,
      h: 480,
      name: 'photo.png',
      isAnimated: false,
      mimeType: 'image/png',
      src: `/files/${assetId}/${versionId}/original`,
      fileSize: 68,
    },
    meta: { assetId, versionId },
  }
}

export function imageRec(id: string, assetRecordId: string, index = 'a2'): Rec {
  return {
    ...shapeBase(id, 'image', index, 300, 0),
    props: {
      w: 320,
      h: 240,
      assetId: `asset:${assetRecordId}`,
      playing: true,
      url: '',
      crop: null,
      flipX: false,
      flipY: false,
      altText: '',
    },
  }
}

export function fileCardRec(id: string, assetId: string, versionId: string, index = 'a3'): Rec {
  return {
    ...shapeBase(id, 'dr-file-card', index, 0, 400),
    props: {
      w: 240,
      h: 160,
      assetId,
      versionId,
      kind: 'other',
      name: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: 5,
      status: 'ready',
      pageCount: null,
      durationMs: null,
      posterDerivativeId: null,
    },
  }
}

/** Validates like the sync server does before seeding (so fixtures cannot silently drift). */
export function assertValid(records: Rec[]) {
  for (const r of records)
    (draftroomSchema.types as Record<string, { validate(x: unknown): unknown }>)[r.typeName]?.validate(r)
}

// ---- files -------------------------------------------------------------------------------------------

// A 1x1 PNG (bytes are only stored and hashed in these tests; no worker runs).
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
)

export async function upload(
  api: TestApi,
  c: Client,
  boardId: string,
  name = 'photo.png',
): Promise<AssetVersionMeta> {
  const res = await api.app.inject({
    method: 'POST',
    url: `/api/boards/${boardId}/assets`,
    payload: PNG,
    headers: {
      origin: 'http://127.0.0.1:5173',
      'content-type': 'image/png',
      'x-file-name': encodeURIComponent(name),
      cookie: c.cookie,
    },
  })
  if (res.statusCode !== 201) throw new Error(`upload failed ${res.statusCode} ${res.body}`)
  return res.json() as AssetVersionMeta
}

export async function fileStatus(c: Client, meta: { assetId: string; versionId: string }, boardId: string) {
  const res = await c.req('GET', `/files/${meta.assetId}/${meta.versionId}/original?board=${boardId}`)
  return res.statusCode
}

/** Collects events published for a board (the hub the app was built with). */
export function recordEvents(events: EventHub, boardId: string) {
  const got: { type: string; data: unknown }[] = []
  events.subscribe(boardId, (e) => got.push({ type: e.type, data: e.data }))
  return got
}
