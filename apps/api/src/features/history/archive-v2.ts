// The portable board archive v2 (`.lobby.json` of a board on the Excalidraw engine,
// docs/EXCALIDRAW-MIGRATION.md §3.7):
//
//   { format: 'lobby-board', version: 2, engine: 'excalidraw', engineVersion, schema, exportedAt,
//     elements, doc, assets: ArchiveAssetRef[] }
//
// Export strips who wrote what (`lobbyServer.privateNote.author`, `plusOne:*`, `react:*`, `lastEditedBy`) and leaves
// out the server-only `import` doc key. Import (v1 archives stay board-ops' `importBoardArchive`, converted
// by the sync seed) takes nothing on trust:
//  - every element gets a fresh id; `containerId`, `boundElements`, arrow bindings, `frameId`, `groupIds`
//    (fresh group ids) and the ids inside `mindmap` / `mindmapEdge` follow, and what points outside the
//    archive is cut (a binding to nothing unbinds, a label whose container is gone becomes a free text);
//  - server-owned and identity-stamped customData never comes from a file: `lobbyServer` goes (the seed
//    stores none), and so do `plusOne:*`, the wave N reactions `react:*`, `ai` and `privateFrame`;
//  - elements are checked with the server's own element check (canvas-schema elements.ts) and the archive
//    caps; the sync seed checks everything again with the invariants and assigns fresh indices.

import { randomBytes } from 'node:crypto'
import { checkElement } from '@draftroom/canvas-schema/elements'
import { ARCHIVE_MAX_ELEMENTS } from '@draftroom/canvas-schema/limits'
import { identityUidOf, isReactionKey } from '@draftroom/canvas-schema/reactions'
import {
  type Element,
  exportableElements,
  isLabel,
  isObject,
  liveElements,
} from '../../canvas/lobby-elements.ts'
import { type ArchiveAssetRef, ArchiveError, type ArchiveErrorCode } from './board-ops.ts'

export const LOBBY_ARCHIVE_FORMAT = 'lobby-board'
export const LOBBY_ARCHIVE_VERSION = 2
/** The engine the elements are for (the catalog pin; the archive says which build wrote it). */
export const LOBBY_ENGINE_VERSION = '0.18.0-1118751'
/** Most file manifest entries (as the v1 archive). */
const MAX_ASSETS = 5_000

export interface BoardArchiveV2 {
  format: 'lobby-board'
  version: 2
  engine: 'excalidraw'
  engineVersion: string
  schema: number
  exportedAt: string
  elements: Record<string, unknown>[]
  doc: Record<string, unknown>
  assets: ArchiveAssetRef[]
}

export function exportLobbyArchive(
  elements: readonly unknown[],
  doc: Readonly<Record<string, unknown>>,
  schema: number,
  assets: ArchiveAssetRef[],
  now: Date,
): BoardArchiveV2 {
  const { import: _serverOnly, ...portable } = doc
  return {
    format: LOBBY_ARCHIVE_FORMAT,
    version: LOBBY_ARCHIVE_VERSION,
    engine: 'excalidraw',
    engineVersion: LOBBY_ENGINE_VERSION,
    schema,
    exportedAt: now.toISOString(),
    elements: exportableElements(elements),
    doc: structuredClone(portable),
    assets,
  }
}

/** Whether an uploaded body claims to be a v2 archive (then it is read by `importLobbyArchive`). */
export const isLobbyArchive = (body: unknown): boolean =>
  isObject(body) && body.format === LOBBY_ARCHIVE_FORMAT

const fail = (code: ArchiveErrorCode, message: string, path?: string) =>
  new ArchiveError(code, message, path ? { path } : undefined)

const ASSET_RE = /^ast_[0-9A-Za-z]{10,40}$/
const VERSION_RE = /^ver_[0-9A-Za-z]{10,40}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/

function readAsset(v: unknown, path: string): ArchiveAssetRef {
  if (!isObject(v)) throw fail('invalid-asset-ref', 'an asset entry must be an object', path)
  const { assetId, versionId, name, mimeType, sizeBytes, sha256 } = v
  if (typeof assetId !== 'string' || !ASSET_RE.test(assetId))
    throw fail('invalid-asset-ref', 'assetId is invalid', path)
  if (typeof versionId !== 'string' || !VERSION_RE.test(versionId))
    throw fail('invalid-asset-ref', 'versionId is invalid', path)
  if (typeof name !== 'string' || name.length > 1024) throw fail('invalid-asset-ref', 'name is invalid', path)
  if (typeof mimeType !== 'string' || !MIME_TYPE.test(mimeType))
    throw fail('invalid-asset-ref', 'mimeType is invalid', path)
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
    throw fail('invalid-asset-ref', 'sizeBytes is invalid', path)
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256))
    throw fail('invalid-asset-ref', 'sha256 is invalid', path)
  return { assetId, versionId, name, mimeType, sizeBytes, sha256 }
}

/** A fresh element or group id (Excalidraw-style, the element id character set). */
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
function freshId(): string {
  let s = ''
  for (const b of randomBytes(20)) s += B62[b % 62]
  return s
}

const TEXT_CONTAINERS = new Set(['rectangle', 'stickynote', 'diamond', 'ellipse', 'arrow'])
const BINDABLE = new Set(['rectangle', 'stickynote', 'diamond', 'ellipse', 'image', 'frame'])
const IDENTITY_KEYS = new Set(['ai', 'privateFrame'])

export interface ImportedLobbyBoard {
  elements: Record<string, unknown>[]
  doc: Record<string, unknown>
  assets: ArchiveAssetRef[]
  warnings: string[]
}

/** Reads a v2 archive (see the top of this file). Throws ArchiveError for anything it cannot take. */
export function importLobbyArchive(body: unknown): ImportedLobbyBoard {
  if (!isObject(body) || body.format !== LOBBY_ARCHIVE_FORMAT)
    throw fail('wrong-format', 'this is not a Lobby board archive')
  if (body.version !== LOBBY_ARCHIVE_VERSION)
    throw fail('unsupported-version', 'only version 2 archives of the new canvas are supported')
  if (!Array.isArray(body.elements)) throw fail('invalid-envelope', 'elements must be an array', 'elements')
  if (body.elements.length > ARCHIVE_MAX_ELEMENTS)
    throw fail('too-large', `an archive holds at most ${ARCHIVE_MAX_ELEMENTS} elements`)
  const rawAssets = body.assets === undefined ? [] : body.assets
  if (!Array.isArray(rawAssets) || rawAssets.length > MAX_ASSETS)
    throw fail('invalid-envelope', 'assets must be a short array', 'assets')
  const assets = rawAssets.map((a, i) => readAsset(a, `assets[${i}]`))
  const warnings: string[] = []

  const source = liveElements(body.elements)
  const ids = new Map<string, string>()
  for (const el of source) if (!ids.has(el.id)) ids.set(el.id, freshId())
  if (ids.size !== source.length) throw fail('duplicate-id', 'element ids must be unique', 'elements')
  const byOld = new Map(source.map((el) => [el.id, el]))
  const groups = new Map<string, string>()
  const groupOf = (g: string) => {
    const known = groups.get(g)
    if (known) return known
    const n = freshId()
    groups.set(g, n)
    return n
  }

  // 1. what may point where, by the archive's own ids
  const labelOf = new Map<string, string>() // container → its one label
  for (const el of source)
    if (
      isLabel(el) &&
      TEXT_CONTAINERS.has(byOld.get(el.containerId)?.type ?? '') &&
      !labelOf.has(el.containerId)
    )
      labelOf.set(el.containerId, el.id)
  const bindsTo = (a: Element, target: string) =>
    a.type === 'arrow' && (a.startBinding?.elementId === target || a.endBinding?.elementId === target)
  const bindable = (id: unknown) => {
    const t = typeof id === 'string' ? byOld.get(id) : undefined
    return !!t && (BINDABLE.has(t.type) || (t.type === 'text' && !isLabel(t)))
  }

  // 2. copies with fresh ids and everything cut that points outside the archive
  let cut = 0
  const out: Record<string, unknown>[] = []
  for (const el of source) {
    const copy: Element = structuredClone(el)
    copy.id = ids.get(el.id) as string
    if (copy.type === 'text') {
      const container = el.containerId
      const own = typeof container === 'string' && labelOf.get(container) === el.id
      if (container && !own) cut++
      copy.containerId = own ? ids.get(container) : null
    }
    const frame = typeof el.frameId === 'string' ? byOld.get(el.frameId) : undefined
    if (el.frameId && (frame?.type !== 'frame' || el.type === 'frame')) cut++
    copy.frameId = frame?.type === 'frame' && el.type !== 'frame' ? ids.get(frame.id) : null
    for (const end of ['startBinding', 'endBinding'] as const)
      if (copy[end]) {
        if (bindable(el[end]?.elementId)) copy[end] = { ...copy[end], elementId: ids.get(el[end].elementId) }
        else {
          copy[end] = null
          cut++
        }
      }
    if (Array.isArray(el.boundElements)) {
      const kept = el.boundElements.filter((b: { id?: unknown; type?: unknown }) => {
        const other = typeof b.id === 'string' ? byOld.get(b.id) : undefined
        if (!other) return false
        return b.type === 'text' ? labelOf.get(el.id) === other.id : bindsTo(other, el.id) && bindable(el.id)
      })
      copy.boundElements = kept.length
        ? kept.map((b: { id: string; type: string }) => ({ id: ids.get(b.id), type: b.type }))
        : null
    }
    copy.groupIds = Array.isArray(el.groupIds) ? el.groupIds.map((g: unknown) => groupOf(String(g))) : []
    copy.customData = importCustomData(el, ids)
    if (copy.customData === undefined) delete copy.customData
    const check = checkElement(copy)
    if (!check.ok) throw fail('invalid-record', `an element is not valid (${check.code})`, 'elements')
    out.push(check.element as Record<string, unknown>)
  }
  if (cut > 0)
    warnings.push(
      `${cut} link(s) between items pointed at something not in this archive; they were left out.`,
    )

  // 3. the board document: tag definitions, the start view (its frame remapped), workshop settings
  const doc: Record<string, unknown> = {}
  if (isObject(body.doc))
    for (const [key, value] of Object.entries(body.doc)) {
      if (key === 'import' || value === null) continue
      if (key === 'startView' && isObject(value)) {
        const frameId = typeof value.frameId === 'string' ? ids.get(value.frameId) : undefined
        const { frameId: _old, ...rest } = value
        doc.startView = frameId ? { ...rest, frameId } : rest
        continue
      }
      doc[key] = structuredClone(value)
    }
  return { elements: out, doc, assets, warnings }
}

/**
 * Whether a `customData.lobby` key belongs to one person (`plusOne:<uid>`, wave N `react:<code>:<uid>`), malformed
 * forms of either class included: such keys mean nothing across deployments, and a file never plants them.
 */
const identityBound = (key: string): boolean =>
  key.startsWith('plusOne:') || isReactionKey(key) || identityUidOf(key) !== null

/** customData of an imported element: no server-owned or identity-stamped keys, refs remapped. */
function importCustomData(
  el: Element,
  ids: ReadonlyMap<string, string>,
): Record<string, unknown> | undefined {
  const lobby = isObject(el.customData) && isObject(el.customData.lobby) ? el.customData.lobby : null
  if (!lobby) return undefined
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(lobby)) {
    if (identityBound(key) || IDENTITY_KEYS.has(key)) continue
    if (key === 'mindmap' || key === 'mindmapEdge') {
      if (!isObject(value)) continue
      const refs = key === 'mindmap' ? ['rootId', 'parentId'] : ['rootId', 'parentId', 'childId']
      const mapped: Record<string, unknown> = { ...value }
      let ok = true
      for (const r of refs) {
        const v = value[r]
        if (v === null && r === 'parentId' && key === 'mindmap') continue
        const n = typeof v === 'string' ? ids.get(v) : undefined
        if (!n) ok = false
        else mapped[r] = n
      }
      if (ok) next[key] = mapped
      continue
    }
    next[key] = structuredClone(value)
  }
  return Object.keys(next).length ? { lobby: next } : undefined
}
