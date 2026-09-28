// AssetVersionMeta built from Postgres rows (packages/db 0007_assets). The JSON is the same shape and
// key order the api wrote to meta.json before milestone 3, so the web client does not change.

import type { Queryable } from '@draftroom/db'
import type {
  AssetKind,
  AssetStatus,
  AssetVersionMeta,
  DerivativeRecord,
  DerivativeRole,
  ProbeFacts,
} from '@draftroom/dev-assets'

export interface VersionRow {
  id: string
  asset_id: string
  workspace_id: string
  board_id: string
  name: string
  declared_mime_type: string
  mime_type: string
  kind: AssetKind
  size_bytes: number
  sha256: string
  uploaded_by: string
  status: AssetStatus
  attempts: number
  error_code: string | null
  error_message: string | null
  probe: unknown
  created_at: Date
  updated_at: Date
}

export interface DerivativeRow {
  id: string
  version_id: string
  position: number
  role: DerivativeRole
  page: number | null
  width: number
  height: number
  mime_type: 'image/webp' | 'image/png'
  bytes: number
  blob_key: string
}

/** bigint columns as float8: PGlite and node-postgres map int8 differently (exact up to 2^53). */
export const VERSION_COLUMNS = `v.id, v.asset_id, v.workspace_id, v.board_id, v.name, v.declared_mime_type,
  v.mime_type, v.kind, v.size_bytes::float8 AS size_bytes, v.sha256, v.uploaded_by, v.status, v.attempts,
  v.error_code, v.error_message, v.probe, v.created_at, v.updated_at`

export const DERIVATIVE_COLUMNS = `d.id, d.version_id, d.position, d.role, d.page, d.width, d.height, d.mime_type,
  d.bytes::float8 AS bytes, d.blob_key`

export const EMPTY_PROBE: ProbeFacts = {
  width: null,
  height: null,
  pageCount: null,
  durationMs: null,
  videoCodec: null,
  audioCodec: null,
}

/** The stored probe as ProbeFacts: exactly its six keys, in order, missing ones null. */
export function probeFacts(raw: unknown): ProbeFacts {
  const src = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return {
    width: num(src.width),
    height: num(src.height),
    pageCount: num(src.pageCount),
    durationMs: num(src.durationMs),
    videoCodec: str(src.videoCodec),
    audioCodec: str(src.audioCodec),
  }
}

export function derivativeRecord(d: DerivativeRow): DerivativeRecord {
  return {
    id: d.id,
    role: d.role,
    page: d.page,
    width: d.width,
    height: d.height,
    mimeType: d.mime_type,
    bytes: Number(d.bytes),
    // meta.json named the file inside derivatives/; the blob key ends with the same basename
    file: d.blob_key.slice(d.blob_key.lastIndexOf('/') + 1),
  }
}

export function toMeta(v: VersionRow, derivatives: readonly DerivativeRow[]): AssetVersionMeta {
  return {
    schemaVersion: 1,
    assetId: v.asset_id,
    versionId: v.id,
    boardId: v.board_id,
    name: v.name,
    declaredMimeType: v.declared_mime_type,
    mimeType: v.mime_type,
    kind: v.kind,
    sizeBytes: Number(v.size_bytes),
    sha256: v.sha256,
    uploadedBy: v.uploaded_by,
    createdAt: v.created_at.toISOString(),
    updatedAt: v.updated_at.toISOString(),
    status: v.status,
    attempts: v.attempts,
    error: v.error_code && v.error_message ? { code: v.error_code, message: v.error_message } : null,
    probe: probeFacts(v.probe),
    derivatives: derivatives.map(derivativeRecord),
  }
}

export interface StoredVersion {
  row: VersionRow
  derivatives: DerivativeRow[]
  meta: AssetVersionMeta
}

/** One version by (asset, version) with its published derivatives, or null. Ids must be validated. */
export async function loadVersion(
  q: Queryable,
  assetId: string,
  versionId: string,
): Promise<StoredVersion | null> {
  const row = await q.maybeOne<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM asset_versions v WHERE v.id = $1 AND v.asset_id = $2`,
    [versionId, assetId],
  )
  if (!row) return null
  const derivatives = (
    await q.query<DerivativeRow>(
      `SELECT ${DERIVATIVE_COLUMNS} FROM asset_derivatives d WHERE d.version_id = $1 ORDER BY d.position`,
      [versionId],
    )
  ).rows
  return { row, derivatives, meta: toMeta(row, derivatives) }
}

/** Version rows (no derivatives) for many refs in one query; refs that do not exist are absent. */
export async function loadVersionRows(
  q: Queryable,
  refs: readonly { assetId: string; versionId: string }[],
): Promise<Map<string, VersionRow>> {
  const out = new Map<string, VersionRow>()
  for (let i = 0; i < refs.length; i += 500) {
    const part = refs.slice(i, i + 500)
    const rows = await q.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM asset_versions v WHERE v.id = ANY($1::text[])`,
      [part.map((r) => r.versionId)],
    )
    const wanted = new Set(part.map((r) => `${r.assetId}/${r.versionId}`))
    for (const r of rows.rows) {
      const k = `${r.asset_id}/${r.id}`
      if (wanted.has(k)) out.set(k, r)
    }
  }
  return out
}
