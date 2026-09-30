/**
 * The files a board's elements reference (the element version of apps/api `referencedFiles`): for an
 * archive's manifest, the export policy and the backup asset-ref collector (docs/EXCALIDRAW-MIGRATION.md
 * §3.7 "The asset-ref collector reads fileId and customData.lobby.file").
 *
 * - An `image`'s `fileId` is a Lobby version id, or a placed PDF page `ver_….p<n>` (canvas-schema
 *   limits.ts FILE_ID_PATTERN): its version id is the bare `ver_…`.
 * - A file card's (and a new upload's) `customData.lobby.file` carries `{assetId, versionId}`.
 * Converted images carry only `fileId` (the converter keeps the asset id out of the element), so
 * `assetId` is null there; the file-refs lookup takes bare version ids (packages/contracts sync-internal).
 *
 * Pure: no engine code. Deleted elements are left out; malformed values are ignored.
 */
import {
  ASSET_ID_PATTERN,
  FILE_ID_PATTERN,
  VERSION_ID_PATTERN,
  versionIdOf,
} from '@draftroom/canvas-schema/limits'
import { asElements, isLive, lobbyValue } from './read.ts'

export interface ElementFileRef {
  versionId: string
  /** the `ast_…` id when an element says it (`customData.lobby.file.assetId`), else null */
  assetId: string | null
}

/** Every file version the live elements reference, once each (sorted by version id). */
export function elementFileRefs(elements: Iterable<unknown>): ElementFileRef[] {
  const out = new Map<string, ElementFileRef>()
  const add = (versionId: string, assetId: string | null) => {
    const known = out.get(versionId)
    if (!known || (!known.assetId && assetId)) out.set(versionId, { versionId, assetId })
  }
  for (const el of asElements(elements)) {
    if (!isLive(el)) continue
    if (el.type === 'image' && typeof el.fileId === 'string' && FILE_ID_PATTERN.test(el.fileId))
      add(versionIdOf(el.fileId), null)
    const file = lobbyValue(el, 'file') as { versionId?: unknown; assetId?: unknown } | undefined
    if (file && typeof file.versionId === 'string' && VERSION_ID_PATTERN.test(file.versionId))
      add(
        file.versionId,
        typeof file.assetId === 'string' && ASSET_ID_PATTERN.test(file.assetId) ? file.assetId : null,
      )
  }
  return [...out.values()].sort((a, b) =>
    a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0,
  )
}
