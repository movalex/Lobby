// What a library item may hold, checked by the api on every save, change and import (OWNER: WS2, wave Q;
// docs/WAVE-Q-CONTRACTS.md §2.3, §2.5, §5). Nothing the client sends is trusted:
//
// 1. board-ops' serializeLibraryItem runs again on the elements received (the web ran it before sending): refused and
//    unknown types, data:/blob: URLs, identity-bound and board-bound keys, item-local ids, canvas-schema's
//    checkElement and checkInvariants, and the item's caps (500 elements, 256 KiB, 20 images). A problem is a code
//    and counts, never content: 400 LIBRARY_INVALID_ELEMENTS, or 413 LIBRARY_TOO_LARGE for a cap.
// 2. Every file version the elements show must be one the SOURCE board can show today, as history decides it
//    (uploaded to it, or linked to it through board_asset_links; files-auth.ts isAssetLinked), in the item's own
//    workspace; an asset id the element states must be that version's. Otherwise 400 LIBRARY_FILE_NOT_SERVABLE.
// 3. `customData.lobby.file` is rewritten from the version row (never the client's facts), and the item's size is
//    measured again after that.
//
// board-ops' element code loads the engine's pure functions (canvas-schema invariants), about 7 MB, so it is imported
// on the first save or import only, never at the api's start.

import type { LibraryItemProblem, LibraryItemResult } from '@draftroom/board-ops/elements'
import { jsonByteLength, MAX_FILE_NAME_CHARS, versionIdOf } from '@draftroom/canvas-schema/limits'
import { LIBRARY_LIMITS } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { AssetKind } from '@draftroom/dev-assets'
import { ApiError } from '../../errors.ts'
import { isAssetLinked } from '../../files-auth.ts'

type BoardOps = typeof import('@draftroom/board-ops/elements')
let boardOpsModule: Promise<BoardOps> | null = null
const boardOps = (): Promise<BoardOps> => {
  boardOpsModule ??= import('@draftroom/board-ops/elements')
  return boardOpsModule
}

const ITEM_LIMITS = {
  maxElements: LIBRARY_LIMITS.itemElements,
  maxBytes: LIBRARY_LIMITS.itemBytes,
  maxImages: LIBRARY_LIMITS.itemImages,
  maxNameChars: LIBRARY_LIMITS.nameChars,
} as const

const TOO_LARGE: ReadonlySet<LibraryItemProblem> = new Set<LibraryItemProblem>([
  'too-many-elements',
  'too-large',
  'too-many-images',
])

export const invalidElements = (message = 'Some of these elements cannot be kept in the library.') =>
  new ApiError(400, 'LIBRARY_INVALID_ELEMENTS', message)
export const tooLarge = (message: string) => new ApiError(413, 'LIBRARY_TOO_LARGE', message)
export const fileNotServable = () =>
  new ApiError(
    400,
    'LIBRARY_FILE_NOT_SERVABLE',
    'An image in this selection is not one its board can show, so it cannot be saved to the library.',
  )

const PROBLEM_MESSAGES: Record<LibraryItemProblem, (n: number) => string> = {
  empty: () => 'There is nothing to save.',
  'refused-type': (n) => `${n} element(s) of a kind the library cannot hold.`,
  'unknown-type': (n) => `${n} element(s) of an unknown kind.`,
  'inline-data': (n) => `${n} element(s) hold embedded data the library does not keep.`,
  invalid: (n) => `${n} element(s) are not valid.`,
  'too-many-elements': () => `An item holds at most ${LIBRARY_LIMITS.itemElements} elements.`,
  'too-large': () => `An item holds at most ${LIBRARY_LIMITS.itemBytes / 1024} KiB of elements.`,
  'too-many-images': () => `An item holds at most ${LIBRARY_LIMITS.itemImages} images.`,
}

/** The refusal of a serializer problem (codes and counts only). */
export const problemError = (problem: LibraryItemProblem, count: number): ApiError =>
  TOO_LARGE.has(problem)
    ? tooLarge(PROBLEM_MESSAGES[problem](count))
    : invalidElements(PROBLEM_MESSAGES[problem](count))

export const isTooLarge = (problem: LibraryItemProblem) => TOO_LARGE.has(problem)

/** serializeLibraryItem over the received elements (no scene: the selection was gathered by the web). */
export async function serializeReceived(elements: readonly unknown[]): Promise<LibraryItemResult> {
  const ops = await boardOps()
  return ops.serializeLibraryItem(elements, { limits: ITEM_LIMITS })
}

export interface PreparedItem {
  elements: Record<string, unknown>[]
  /** the versions the elements show, each a real version of the item's workspace */
  files: { assetId: string; versionId: string }[]
  width: number
  height: number
  elementCount: number
  imageCount: number
  bytes: number
}

interface VersionFacts {
  id: string
  asset_id: string
  workspace_id: string
  board_id: string
  name: string
  mime_type: string
  kind: AssetKind
  size_bytes: number
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Steps 2 and 3 for one serialized item whose source is `boardId` (a board of `workspaceId` the caller can view):
 * the file checks and the rewrite of the file facts. Throws the refusal.
 */
export async function withServableFiles(
  q: Queryable,
  workspaceId: string,
  boardId: string,
  item: Extract<LibraryItemResult, { ok: true }>['item'],
): Promise<PreparedItem> {
  const elements = item.elements as unknown as Record<string, unknown>[]
  const versions = new Map<string, VersionFacts>()
  if (item.files.length) {
    const rows = await q.query<VersionFacts>(
      `SELECT v.id, v.asset_id, v.workspace_id, v.board_id, v.name, v.mime_type, v.kind,
              v.size_bytes::float8 AS size_bytes
         FROM asset_versions v WHERE v.id = ANY($1::text[])`,
      [item.files.map((f) => f.versionId)],
    )
    const byId = new Map(rows.rows.map((r) => [r.id, r]))
    for (const ref of item.files) {
      const v = byId.get(ref.versionId)
      if (!v || v.workspace_id !== workspaceId || (ref.assetId !== null && ref.assetId !== v.asset_id))
        throw fileNotServable()
      const shown =
        v.board_id === boardId ||
        (await isAssetLinked(q, workspaceId, boardId, {
          assetId: v.asset_id,
          versionId: v.id,
          ownerBoardId: v.board_id,
        }))
      if (!shown) throw fileNotServable()
      versions.set(v.id, v)
    }
  }
  for (const el of elements) {
    const custom = isObj(el.customData) ? el.customData : null
    const lobby = custom && isObj(custom.lobby) ? custom.lobby : null
    if (!lobby || lobby.file === undefined) continue
    // the room keeps file facts on images only (sync canonicalizeFile)
    if (el.type !== 'image') throw invalidElements()
    const file = isObj(lobby.file) ? lobby.file : null
    const v = typeof file?.versionId === 'string' ? versions.get(file.versionId) : undefined
    if (!v || typeof el.fileId !== 'string' || versionIdOf(el.fileId) !== v.id) throw fileNotServable()
    lobby.file = {
      assetId: v.asset_id,
      versionId: v.id,
      kind: v.kind,
      name: v.name.slice(0, MAX_FILE_NAME_CHARS),
      mimeType: v.mime_type,
      sizeBytes: Number(v.size_bytes),
    }
  }
  const bytes = jsonByteLength(elements)
  if (bytes > LIBRARY_LIMITS.itemBytes) throw problemError('too-large', bytes)
  return {
    elements,
    files: [...versions.values()].map((v) => ({ assetId: v.asset_id, versionId: v.id })),
    width: item.width,
    height: item.height,
    elementCount: item.elementCount,
    imageCount: item.imageCount,
    bytes,
  }
}

/** A serialized item that shows no file (an import's: no board can vouch for one). */
export function withoutFiles(item: Extract<LibraryItemResult, { ok: true }>['item']): PreparedItem {
  return {
    elements: item.elements as unknown as Record<string, unknown>[],
    files: [],
    width: item.width,
    height: item.height,
    elementCount: item.elementCount,
    imageCount: item.imageCount,
    bytes: item.bytes,
  }
}

/**
 * Whether a save from `boardId` makes an internal-only item: the board's project, or its workspace, is internal only
 * (read under the workspace row lock the switch takes). A board that is gone counts as internal (fail closed).
 */
export async function savedInternalOnly(q: Queryable, boardId: string): Promise<boolean> {
  const r = await q.maybeOne<{ io: boolean }>(
    `SELECT (w.internal_only OR COALESCE(p.internal_only, false)) AS io
       FROM boards b JOIN workspaces w ON w.id = b.workspace_id
       LEFT JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
      WHERE b.id = $1`,
    [boardId],
  )
  return r?.io ?? true
}

/** The rows of an item's files (library_item_files), in one statement. */
export async function insertItemFiles(
  q: Queryable,
  itemId: string,
  workspaceId: string,
  files: readonly { assetId: string; versionId: string }[],
): Promise<void> {
  if (!files.length) return
  await q.query(
    `INSERT INTO library_item_files (item_id, workspace_id, asset_id, version_id)
     SELECT $1, $2, a, v FROM unnest($3::text[], $4::text[]) AS t(a, v)`,
    [itemId, workspaceId, files.map((f) => f.assetId), files.map((f) => f.versionId)],
  )
}
