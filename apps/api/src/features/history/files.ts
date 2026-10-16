// Which uploaded files a new board made from existing content may show (board_asset_links).
//
// A record can name ANY asset id (a forged push only needs a string), so a file is carried over only
// when the SOURCE could already show it: for a copy, the source board owns the version or holds a link
// to it; for an import, the caller can view some board of the workspace that shows it.

import type { Queryable } from '@draftroom/db'
import { isId } from '@draftroom/dev-assets'
import { can } from '@draftroom/permissions'
import { loadBoardAccess } from '../../access.ts'
import { filesOfElements } from '../../canvas/lobby-elements.ts'
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

/**
 * Distinct file versions elements of the Excalidraw engine show (an image's `fileId`, D7), as the same
 * refs: `customData.lobby.file` names the asset; an image without those facts gets its version's asset
 * from asset_versions (a version id is unique), and a version that no longer exists is left out.
 */
export async function referencedElementFiles(q: Queryable, elements: Iterable<unknown>): Promise<FileRef[]> {
  const files = filesOfElements(elements)
  const known: FileRef[] = []
  const bare: string[] = []
  for (const f of files) {
    if (f.assetId) known.push({ assetId: f.assetId, versionId: f.versionId })
    else bare.push(f.versionId)
  }
  for (let i = 0; i < bare.length; i += 500) {
    const rows = await q.query<{ id: string; asset_id: string }>(
      'SELECT id, asset_id FROM asset_versions WHERE id = ANY($1::text[])',
      [bare.slice(i, i + 500)],
    )
    for (const r of rows.rows) known.push({ assetId: r.asset_id, versionId: r.id })
  }
  return known
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

/**
 * IO-10 (wave J refix round 2): an import's files that the importer can view only on boards of an
 * internal-only project, when the new board lands outside every internal-only scope (no project, or a
 * project that is not internal only). Carrying them would link the project's stored originals to a board
 * outside the switch, where outside invitations and links work: the move out that IO-1 keeps for the people
 * who may turn the switch off. So they are left out (`fenced`, shown as missing with a warning) unless the
 * importer is a workspace owner or admin who is a creator. Into an internal-only project (between two of
 * them, as a move) or while the workspace itself is internal only, nothing is fenced. A file the importer can
 * also view on a board outside every internal-only project is already outside the switch, so it is kept.
 * Call in createBoardFrom's transaction, under the workspace row lock the switch and a move take, after the
 * caller's viewable check (filesViewableBy).
 */
export async function fenceInternalOnlyFiles(
  q: Queryable,
  deps: { identity: { isCreatorUser(q: Queryable, userId: string): Promise<boolean> } },
  target: { workspaceId: string; userId: string; projectId: string | null },
  files: readonly FileRef[],
): Promise<{ kept: FileRef[]; fenced: FileRef[] }> {
  const all = { kept: [...files], fenced: [] as FileRef[] }
  if (!files.length) return all
  const { workspaceId, userId, projectId } = target
  const flags = await q.maybeOne<{ ws: boolean; target: boolean | null; any: boolean }>(
    `SELECT w.internal_only AS ws,
            (SELECT p.internal_only FROM projects p WHERE p.id = $2 AND p.workspace_id = w.id) AS target,
            EXISTS (SELECT 1 FROM projects p WHERE p.workspace_id = w.id AND p.internal_only) AS any
       FROM workspaces w WHERE w.id = $1`,
    [workspaceId, projectId],
  )
  if (!flags || flags.ws || flags.target === true || !flags.any) return all
  if (await mayTakeOutOfInternalOnly(q, deps, workspaceId, userId)) return all
  return splitInternalOnlyFiles(q, workspaceId, userId, files)
}

/** A workspace owner or admin who is a creator: the people who may turn the switch off (IO-1, IO-10). */
export async function mayTakeOutOfInternalOnly(
  q: Queryable,
  deps: { identity: { isCreatorUser(q: Queryable, userId: string): Promise<boolean> } },
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const member = await q.maybeOne<{ role: string }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  )
  return (
    (member?.role === 'owner' || member?.role === 'admin') && (await deps.identity.isCreatorUser(q, userId))
  )
}

/**
 * `files` split by where `userId` can view them: `kept`, on some board outside every internal-only project;
 * `fenced`, only on boards of an internal-only project (or nowhere). No role or switch check: the callers decide
 * whether the split applies (fenceInternalOnlyFiles; a backup, backup/export.ts planBackup).
 */
export async function splitInternalOnlyFiles<T extends FileRef>(
  q: Queryable,
  workspaceId: string,
  userId: string,
  files: readonly T[],
): Promise<{ kept: T[]; fenced: T[] }> {
  const kept: T[] = []
  const fenced: T[] = []
  const outsideSwitch = new Map<string, boolean>()
  const rows = await loadVersionRows(q, files)
  for (const ref of files) {
    const row = rows.get(refKey(ref))
    let ok = false
    if (row) {
      for (const boardId of await boardsShowingAsset(q, workspaceId, {
        ...ref,
        ownerBoardId: row.board_id,
      })) {
        if (!outsideSwitch.has(boardId)) {
          const access = await loadBoardAccess(q, boardId, userId)
          const viewable = !!access && can(access.role, 'view', access.board.status)
          const fencedBoard = await q.maybeOne(
            `SELECT 1 AS hit FROM boards b JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
              WHERE b.id = $1 AND p.internal_only`,
            [boardId],
          )
          outsideSwitch.set(boardId, viewable && fencedBoard === null)
        }
        if (outsideSwitch.get(boardId)) {
          ok = true
          break
        }
      }
    }
    ;(ok ? kept : fenced).push(ref)
  }
  return { kept, fenced }
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
