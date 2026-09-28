// Which uploaded files a new board made from existing content may show (board_asset_links).
//
// A record can name ANY asset id (a forged push only needs a string), so a file is carried over only
// when the SOURCE could already show it: for a copy, the source board owns the version or holds a link
// to it; for an import, the caller can view some board of the workspace that shows it.

import type { Queryable } from '@draftroom/db'
import { isId } from '@draftroom/dev-assets'
import { can } from '@draftroom/permissions'
import { loadBoardAccess } from '../../access.ts'
import { loadVersionRows, type VersionRow } from '../../files/meta.ts'
import { boardsShowingAsset, isAssetLinked } from '../../files-auth.ts'
import type { ArchiveAssetRef } from './board-ops.ts'

export interface FileRef {
  assetId: string
  versionId: string
}

const STABLE_FILE_REF = /^\/files\/(ast_[0-9A-Za-z]{10,40})\/(ver_[0-9A-Za-z]{10,40})\/original$/
const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/
const SHA256_HEX = /^[0-9a-f]{64}$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Distinct file versions the records point at: image/video asset `src` refs and file-card props. */
export function referencedFiles(records: Iterable<unknown>): FileRef[] {
  const seen = new Map<string, FileRef>()
  const add = (assetId: unknown, versionId: unknown) => {
    if (!isId('ast', assetId) || !isId('ver', versionId)) return
    seen.set(`${assetId}/${versionId}`, { assetId, versionId })
  }
  for (const r of records) {
    if (!isObject(r) || !isObject(r.props)) continue
    if (r.typeName === 'asset' && typeof r.props.src === 'string') {
      const m = STABLE_FILE_REF.exec(r.props.src)
      if (m) add(m[1], m[2])
    } else if (r.typeName === 'shape' && r.type === 'dr-file-card') add(r.props.assetId, r.props.versionId)
  }
  return [...seen.values()]
}

const refKey = (ref: FileRef) => `${ref.assetId}/${ref.versionId}`

/**
 * The subset of `refs` that `boardId` can show today (its own uploads, or versions linked to it), with
 * their asset_versions rows (packages/db 0007_assets).
 */
export async function filesShownOn(
  q: Queryable,
  workspaceId: string,
  boardId: string,
  refs: readonly FileRef[],
): Promise<{ shown: FileRef[]; versions: Map<string, VersionRow>; notShown: number }> {
  const shown: FileRef[] = []
  const versions = new Map<string, VersionRow>()
  const rows = await loadVersionRows(q, refs)
  for (const ref of refs) {
    const row = rows.get(refKey(ref))
    if (!row) continue
    const ok =
      (row.board_id === boardId && row.workspace_id === workspaceId) ||
      (await isAssetLinked(q, workspaceId, boardId, { ...ref, ownerBoardId: row.board_id }))
    if (!ok) continue
    shown.push(ref)
    versions.set(refKey(ref), row)
  }
  return { shown, versions, notShown: refs.length - shown.length }
}

/** The subset of `refs` the caller can view somewhere in the workspace (import). */
export async function filesViewableBy(
  q: Queryable,
  workspaceId: string,
  userId: string,
  refs: readonly FileRef[],
): Promise<{ allowed: FileRef[]; dropped: FileRef[] }> {
  const allowed: FileRef[] = []
  const dropped: FileRef[] = []
  const canView = new Map<string, boolean>()
  const rows = await loadVersionRows(q, refs)
  for (const ref of refs) {
    const row = rows.get(refKey(ref))
    let ok = false
    if (row) {
      for (const boardId of await boardsShowingAsset(q, workspaceId, {
        ...ref,
        ownerBoardId: row.board_id,
      })) {
        if (!canView.has(boardId)) {
          const access = await loadBoardAccess(q, boardId, userId)
          canView.set(boardId, !!access && can(access.role, 'view', access.board.status))
        }
        if (canView.get(boardId)) {
          ok = true
          break
        }
      }
    }
    ;(ok ? allowed : dropped).push(ref)
  }
  return { allowed, dropped }
}

/** The archive manifest entry of a version (values clamped to what the archive format accepts). */
export function archiveRef(v: VersionRow): ArchiveAssetRef | null {
  const sizeBytes = Number(v.size_bytes)
  if (!SHA256_HEX.test(v.sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return null
  return {
    assetId: v.asset_id,
    versionId: v.id,
    name: String(v.name ?? '').slice(0, 1024),
    mimeType: MIME_TYPE.test(v.mime_type) ? v.mime_type : 'application/octet-stream',
    sizeBytes,
    sha256: v.sha256,
  }
}
