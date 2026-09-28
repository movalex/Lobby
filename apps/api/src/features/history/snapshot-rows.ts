// board_snapshots rows as the history routes read them, the stored checkpoint body, and the content
// hash that keeps a checkpoint of unchanged content from being saved twice (0014_checkpoint_policy).

import { createHash } from 'node:crypto'
import type { BoardCheckpoint, CheckpointReason, SnapshotKind } from '@draftroom/contracts'
import type { RoomSnapshotJson } from '../../sync-internal.ts'

export interface SnapshotRow {
  id: string
  workspace_id: string
  board_id: string
  name: string
  kind: SnapshotKind
  reason: CheckpointReason | null
  created_by: string | null
  creator_name: string | null
  created_at: Date
  document_clock: number
  record_count: number
  size_bytes: number
  storage_key: string
  content_hash: string | null
}

/** Columns of a SnapshotRow: `FROM board_snapshots s LEFT JOIN users u ON u.id = s.created_by`. */
export const SNAPSHOT_COLUMNS = `s.id, s.workspace_id, s.board_id, s.name, s.kind, s.reason, s.created_by,
  u.name AS creator_name, s.created_at, s.document_clock::float8 AS document_clock, s.record_count,
  s.size_bytes::float8 AS size_bytes, s.storage_key, s.content_hash`

export const SNAPSHOT_FROM = 'board_snapshots s LEFT JOIN users u ON u.id = s.created_by'

/** The API shape (a BoardSnapshot plus `reason`; older clients ignore the extra field). */
export const toCheckpoint = (r: SnapshotRow): BoardCheckpoint => ({
  id: r.id,
  boardId: r.board_id,
  name: r.name,
  kind: r.kind,
  reason: r.reason ?? null,
  createdBy: r.created_by ? { id: r.created_by, name: r.creator_name ?? '' } : null,
  createdAt: r.created_at.toISOString(),
  documentClock: Number(r.document_clock),
  recordCount: Number(r.record_count),
  sizeBytes: Number(r.size_bytes),
})

/** The stored checkpoint body (object store). */
export interface CheckpointBody {
  format: 'draftroom-checkpoint'
  version: 1
  boardId: string
  documentClock: number
  schema: unknown
  documents: { state: Record<string, unknown>; lastChangedClock: number }[]
}

/** A sync snapshot as the body stores it, with its document clock and the hash of its content. */
export function checkpointBodyOf(boardId: string, snap: RoomSnapshotJson) {
  const documents = (Array.isArray(snap.documents) ? snap.documents : []).map((d) => ({
    state: d.state,
    lastChangedClock: Number(d.lastChangedClock ?? 0),
  }))
  const documentClock = Math.max(0, Math.floor(Number(snap.documentClock ?? 0)) || 0)
  const body: CheckpointBody = {
    format: 'draftroom-checkpoint',
    version: 1,
    boardId,
    documentClock,
    schema: snap.schema,
    documents,
  }
  const json = JSON.stringify(body)
  return {
    body,
    json,
    documentClock,
    recordCount: documents.length,
    sizeBytes: Buffer.byteLength(json),
    contentHash: contentHash(documents.map((d) => d.state)),
  }
}

/** JSON with object keys sorted at every level, so equal records always serialize the same way. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key]
    if (v === undefined) continue
    parts.push(`${JSON.stringify(key)}:${stableJson(v)}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * sha256 of the board's records in id order. tldraw `user` records are left out: they hold the name
 * and color of whoever opened the board as an editor, which is not board content (opening a board must
 * not look like a change worth a checkpoint).
 */
export function contentHash(records: readonly Record<string, unknown>[]): string {
  const id = (r: Record<string, unknown>) => String(r.id ?? '')
  const content = records
    .filter((r) => r.typeName !== 'user')
    .sort((a, b) => (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0))
  const hash = createHash('sha256')
  for (const r of content) hash.update(`${stableJson(r)}\n`)
  return hash.digest('hex')
}
