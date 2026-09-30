// board_snapshots rows as the history routes read them, the stored checkpoint body, and the content
// hash that keeps a checkpoint of unchanged content from being saved twice (0014_checkpoint_policy).

import { createHash } from 'node:crypto'
import {
  type BoardCheckpoint,
  type CheckpointReason,
  NEW_CANVAS_CHECKPOINT_MESSAGE,
  NEW_CANVAS_ERROR,
  type SnapshotKind,
} from '@draftroom/contracts'
import { liveElements, lobbySnapshotOf } from '../../canvas/lobby-elements.ts'
import { ApiError } from '../../errors.ts'
import type { BoardSnapshotJson, RoomSnapshotJson } from '../../sync-internal.ts'

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
  /** Bridge release R0 (migration 0022): 1 = a tldraw body (CheckpointBody); 2 = made on the new canvas. */
  body_version: number
}

/** Columns of a SnapshotRow: `FROM board_snapshots s LEFT JOIN users u ON u.id = s.created_by`. */
export const SNAPSHOT_COLUMNS = `s.id, s.workspace_id, s.board_id, s.name, s.kind, s.reason, s.created_by,
  u.name AS creator_name, s.created_at, s.document_clock::float8 AS document_clock, s.record_count,
  s.size_bytes::float8 AS size_bytes, s.storage_key, s.content_hash, s.body_version`

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
  // Bridge release R0: made on the new canvas (a v2 body): listed, never previewed or restored here.
  ...(isNewCanvasRow(r) ? { newCanvas: true as const } : {}),
})

/**
 * Bridge release R0: a checkpoint whose row says its body is not the tldraw build's (v2, the new canvas).
 * On main (R0, the tldraw build) such a row is listed and never previewed or restored. On this branch the
 * readers below read v1 and v2 bodies alike, and this branch's writer does not yet set `body_version`
 * (every row is 1), so the row check is dormant here; the Excalidraw build's switch to writing 2 must drop
 * these refusals for its own api (docs/research/excalidraw/WAVE-3.md §6, 2F).
 */
export const isNewCanvasRow = (r: Pick<SnapshotRow, 'body_version'>) =>
  r.body_version !== undefined && r.body_version !== null && Number(r.body_version) !== 1

/** 409 NEW_CANVAS: a checkpoint made on the new canvas cannot be previewed or restored by this build. */
export const newCanvasCheckpoint = () => new ApiError(409, NEW_CANVAS_ERROR, NEW_CANVAS_CHECKPOINT_MESSAGE)

/** The stored checkpoint body (object store), v1: tldraw records. */
export interface CheckpointBodyV1 {
  format: 'draftroom-checkpoint'
  version: 1
  boardId: string
  documentClock: number
  schema: unknown
  documents: { state: Record<string, unknown>; lastChangedClock: number }[]
}

/**
 * v2 (docs/EXCALIDRAW-MIGRATION.md §3.7, §5.5): a board of the Excalidraw engine, as its sync snapshot
 * gave it: the live elements and the board document at the lb `clock`.
 */
export interface CheckpointBodyV2 {
  format: 'lobby-checkpoint'
  version: 2
  boardId: string
  clock: number
  /** the element schema version (canvas-schema protocol.ts ELEMENT_SCHEMA_VERSION) */
  schema: number
  elements: Record<string, unknown>[]
  doc: Record<string, unknown>
}

export type CheckpointBody = CheckpointBodyV1 | CheckpointBodyV2

/** A stored body as the readers use it: v1 is never rewritten (§5.5), both are read. */
export type CheckpointContentOf =
  | { version: 1; schema: unknown; records: Record<string, unknown>[] }
  | { version: 2; schema: number; elements: Record<string, unknown>[]; doc: Record<string, unknown> }

/** Reads a stored body (JSON). Throws on a body of neither format. */
export function readCheckpointBody(raw: string): CheckpointContentOf {
  const body = JSON.parse(raw) as Partial<CheckpointBodyV1> & Partial<CheckpointBodyV2> & { format?: unknown }
  if (body.format === 'lobby-checkpoint' && body.version === 2)
    return {
      version: 2,
      schema: Number(body.schema) || 1,
      elements: Array.isArray(body.elements) ? body.elements : [],
      doc: body.doc && typeof body.doc === 'object' && !Array.isArray(body.doc) ? body.doc : {},
    }
  if (body.format === 'draftroom-checkpoint' || body.format === undefined)
    return {
      version: 1,
      schema: body.schema,
      records: (Array.isArray(body.documents) ? body.documents : []).map((d) => d.state),
    }
  throw new Error('unknown checkpoint body format')
}

/** A sync snapshot as the body stores it, with its document clock and the hash of its content. */
export function checkpointBodyOf(boardId: string, snap: BoardSnapshotJson) {
  const lobby = lobbySnapshotOf(snap)
  if (lobby) {
    const elements = liveElements(lobby.elements)
    const body: CheckpointBodyV2 = {
      format: 'lobby-checkpoint',
      version: 2,
      boardId,
      clock: lobby.clock,
      schema: lobby.schema,
      elements,
      doc: lobby.doc,
    }
    const json = JSON.stringify(body)
    return {
      body,
      json,
      documentClock: lobby.clock,
      recordCount: elements.length,
      sizeBytes: Buffer.byteLength(json),
      contentHash: elementsContentHash(elements, lobby.doc),
    }
  }
  const tl = snap as RoomSnapshotJson
  const documents = (Array.isArray(tl.documents) ? tl.documents : []).map((d) => ({
    state: d.state,
    lastChangedClock: Number(d.lastChangedClock ?? 0),
  }))
  const documentClock = Math.max(0, Math.floor(Number(tl.documentClock ?? 0)) || 0)
  const body: CheckpointBodyV1 = {
    format: 'draftroom-checkpoint',
    version: 1,
    boardId,
    documentClock,
    schema: tl.schema,
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

/**
 * sha256 of a v2 body's content: the live elements in id order, then the board document (a tag
 * definition or the start view is content too). Prefixed so it never equals a v1 hash: the first
 * checkpoint after a board's conversion is always saved (§5.5).
 */
export function elementsContentHash(
  elements: readonly Record<string, unknown>[],
  doc: Readonly<Record<string, unknown>>,
): string {
  const id = (r: Record<string, unknown>) => String(r.id ?? '')
  const sorted = [...elements].sort((a, b) => (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0))
  const hash = createHash('sha256')
  hash.update('lobby-checkpoint 2\n')
  for (const el of sorted) hash.update(`${stableJson(el)}\n`)
  hash.update(`doc ${stableJson(doc)}\n`)
  return hash.digest('hex')
}
