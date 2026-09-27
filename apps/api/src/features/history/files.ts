// Which uploaded files a new board made from existing content may show (board_asset_links).
//
// A record can name ANY asset id (a forged push only needs a string), so a file is carried over only
// when the SOURCE could already show it: for a copy, the source board owns the version or holds a link
// to it; for an import, the caller can view some board of the workspace that shows it.

import type { Queryable } from '@draftroom/db'
import { type AssetVersionMeta, type DataLayout, isId, readMeta } from '@draftroom/dev-assets'
import { can } from '@draftroom/permissions'
import { loadBoardAccess } from '../../access.ts'
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

function metaOf(layout: DataLayout, ref: FileRef): AssetVersionMeta | null {
  try {
    const meta = readMeta(layout, ref.assetId, ref.versionId)
    return meta && meta.assetId === ref.assetId && meta.versionId === ref.versionId ? meta : null
  } catch {
    return null
  }
}

/** The subset of `refs` that `boardId` can show today (its own uploads, or versions linked to it). */
export async function filesShownOn(
  q: Queryable,
  layout: DataLayout,
  workspaceId: string,
  boardId: string,
  refs: readonly FileRef[],
): Promise<{ shown: FileRef[]; metas: Map<string, AssetVersionMeta>; notShown: number }> {
  const shown: FileRef[] = []
  const metas = new Map<string, AssetVersionMeta>()
  for (const ref of refs) {
    const meta = metaOf(layout, ref)
    if (!meta) continue
    const ok =
      meta.boardId === boardId ||
      (await isAssetLinked(q, workspaceId, boardId, { ...ref, ownerBoardId: meta.boardId }))
    if (!ok) continue
    shown.push(ref)
    metas.set(`${ref.assetId}/${ref.versionId}`, meta)
  }
  return { shown, metas, notShown: refs.length - shown.length }
}

/** The subset of `refs` the caller can view somewhere in the workspace (import). */
export async function filesViewableBy(
  q: Queryable,
  layout: DataLayout,
  workspaceId: string,
  userId: string,
  refs: readonly FileRef[],
): Promise<{ allowed: FileRef[]; dropped: FileRef[] }> {
  const allowed: FileRef[] = []
  const dropped: FileRef[] = []
  const canView = new Map<string, boolean>()
  for (const ref of refs) {
    const meta = metaOf(layout, ref)
    let ok = false
    if (meta) {
      for (const boardId of await boardsShowingAsset(q, workspaceId, {
        ...ref,
        ownerBoardId: meta.boardId,
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
export function archiveRef(meta: AssetVersionMeta): ArchiveAssetRef | null {
  if (!SHA256_HEX.test(meta.sha256) || !Number.isSafeInteger(meta.sizeBytes) || meta.sizeBytes < 0)
    return null
  return {
    assetId: meta.assetId,
    versionId: meta.versionId,
    name: String(meta.name ?? '').slice(0, 1024),
    mimeType: MIME_TYPE.test(meta.mimeType) ? meta.mimeType : 'application/octet-stream',
    sizeBytes: meta.sizeBytes,
    sha256: meta.sha256,
  }
}
