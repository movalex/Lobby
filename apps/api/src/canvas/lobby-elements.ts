// How the api reads board content of the Excalidraw engine (docs/EXCALIDRAW-MIGRATION.md §1 A5, §3.1,
// §3.3, §3.6, §3.7): the sync snapshot's `lobby-elements` envelope (@draftroom/contracts
// sync-internal.ts LobbyElementsSnapshot), v2 checkpoint bodies and v2 archives all carry elements. The
// api never renders them; it reads what features need: which objects exist and where (vote eligibility,
// AI sources), their text, the files they show, and a copy made safe to export.
//
// Pure, no engine code (zod and plain JSON only). Tolerant: a malformed element reads as having no text
// and no file; the sync server validated every stored element when it was written.
//
// Api object refs stay `shape:<elementId>` (canvas-schema refs.ts), so comment anchors, AI ids and vote
// targets keep working; object types are the api's vocabulary (the tldraw shape types its readers use).

import { LobbyElementsSnapshot } from '@draftroom/contracts'

// biome-ignore lint/suspicious/noExplicitAny: elements are JSON, read field by field
export type Element = Record<string, any> & { id: string; type: string }

export const ELEMENT_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/
const VERSION_ID_RE = /^ver_[0-9A-Za-z]{10,40}$/
const ASSET_ID_RE = /^ast_[0-9A-Za-z]{10,40}$/
/** The one page of the new canvas (clients send the constant `page:page`, C1). */
export const SINGLE_PAGE_ID = 'page:page'

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The envelope when `snapshot` is the Excalidraw engine's (the api asks the same sync route either way). */
export function lobbySnapshotOf(snapshot: unknown): LobbyElementsSnapshot | null {
  const parsed = LobbyElementsSnapshot.safeParse(snapshot)
  return parsed.success ? parsed.data : null
}

/** Live elements with an id and a type (tombstones and malformed entries dropped). */
export function liveElements(elements: readonly unknown[]): Element[] {
  const out: Element[] = []
  for (const el of elements)
    if (isObject(el) && typeof el.id === 'string' && typeof el.type === 'string' && el.isDeleted !== true)
      out.push(el as Element)
  return out
}

/** `shape:<id>`, or null for an id outside the element id pattern. */
export const refOf = (id: string): string | null => (ELEMENT_ID_RE.test(id) ? `shape:${id}` : null)
/** The element id of a `shape:` ref, or null. */
export const elementIdOf = (ref: string): string | null => {
  if (!ref.startsWith('shape:')) return null
  const id = ref.slice('shape:'.length)
  return ELEMENT_ID_RE.test(id) ? id : null
}

/** A text bound to a container: part of its container, never an object of its own. */
export const isLabel = (el: Element): boolean =>
  el.type === 'text' && typeof el.containerId === 'string' && el.containerId.length > 0

export const lobbyOf = (el: Element): Record<string, unknown> => {
  const lobby = isObject(el.customData) ? el.customData.lobby : undefined
  return isObject(lobby) ? lobby : {}
}
export const lobbyServerOf = (el: Element): Record<string, unknown> => {
  const s = isObject(el.customData) ? el.customData.lobbyServer : undefined
  return isObject(s) ? s : {}
}

/** The bare version id an image shows (`fileId` without a PDF page's `.p<n>`), or null. */
export function versionOf(el: Element): string | null {
  if (el.type !== 'image' || typeof el.fileId !== 'string') return null
  const v = el.fileId.replace(/\.p[1-9][0-9]{0,3}$/, '')
  return VERSION_ID_RE.test(v) ? v : null
}

export interface ElementFile {
  versionId: string
  /** null when the element carries no `customData.lobby.file` facts */
  assetId: string | null
  kind: 'image' | 'pdf' | 'video' | 'other' | null
  name: string
}

export function fileOf(el: Element): ElementFile | null {
  const versionId = versionOf(el)
  if (!versionId) return null
  const f = lobbyOf(el).file
  const facts = isObject(f) && f.versionId === versionId ? f : null
  const kind =
    facts?.kind === 'image' || facts?.kind === 'pdf' || facts?.kind === 'video' || facts?.kind === 'other'
      ? facts.kind
      : null
  return {
    versionId,
    assetId: typeof facts?.assetId === 'string' && ASSET_ID_RE.test(facts.assetId) ? facts.assetId : null,
    kind,
    name: typeof facts?.name === 'string' ? facts.name : '',
  }
}

/** The api's object type of an element (the tldraw shape type its readers use); null for a bound label. */
export function objectTypeOf(el: Element): string | null {
  switch (el.type) {
    case 'stickynote':
      return 'note'
    case 'rectangle':
    case 'ellipse':
    case 'diamond':
      return 'geo'
    case 'text':
      return isLabel(el) ? null : 'text'
    case 'freedraw':
      return lobbyOf(el).kind === 'highlight' ? 'highlight' : 'draw'
    case 'arrow':
    case 'line':
    case 'frame':
      return el.type
    case 'image': {
      const file = fileOf(el)
      const pdfPage = typeof el.fileId === 'string' && /\.p[1-9][0-9]{0,3}$/.test(el.fileId)
      if (!file || pdfPage || file.kind === null || file.kind === 'image') return 'image'
      return file.kind === 'video' ? 'video' : 'dr-file-card'
    }
    default:
      return null
  }
}

/** Labels by the id of the container they name. */
export function labelsByContainer(elements: Iterable<Element>): Map<string, Element> {
  const out = new Map<string, Element>()
  for (const el of elements) if (isLabel(el) && !out.has(el.containerId)) out.set(el.containerId, el)
  return out
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** The plain text of an object: its label's, a free text's, a frame's name ('' when none). */
export function textOfElement(el: Element, labels: ReadonlyMap<string, Element>): string {
  switch (el.type) {
    case 'stickynote':
    case 'rectangle':
    case 'ellipse':
    case 'diamond':
    case 'arrow': {
      const label = labels.get(el.id)
      return label ? str(label.originalText) || str(label.text) : ''
    }
    case 'text':
      return isLabel(el) ? '' : str(el.originalText) || str(el.text)
    case 'frame':
      return str(el.name)
    default:
      return ''
  }
}

/** The file versions elements show, with the asset id when the element knows it (else null). */
export function filesOfElements(
  elements: Iterable<unknown>,
): { assetId: string | null; versionId: string }[] {
  const out = new Map<string, { assetId: string | null; versionId: string }>()
  for (const raw of elements) {
    if (!isObject(raw) || typeof raw.type !== 'string' || typeof raw.id !== 'string') continue
    const f = fileOf(raw as Element)
    if (!f) continue
    const prev = out.get(f.versionId)
    if (!prev || (!prev.assetId && f.assetId))
      out.set(f.versionId, { assetId: f.assetId, versionId: f.versionId })
  }
  return [...out.values()]
}

// ---- export (§3.7: the archive and checkpoint readers never hand out who wrote what) -------------------

/**
 * A copy of the elements for a portable archive (v2): without `lobbyServer.privateNote.author`, the
 * `plusOne:*` votes and `lastEditedBy` (as today's export strips authors). Tombstones are dropped.
 */
export function exportableElements(elements: readonly unknown[]): Element[] {
  return liveElements(elements).map((el) => {
    const copy = structuredClone(el)
    const custom = isObject(copy.customData) ? copy.customData : null
    if (custom) {
      if (isObject(custom.lobby))
        custom.lobby = Object.fromEntries(
          Object.entries(custom.lobby).filter(([k]) => !k.startsWith('plusOne:')),
        )
      if (isObject(custom.lobbyServer)) {
        const s = { ...custom.lobbyServer }
        s.lastEditedBy = null
        if (isObject(s.privateNote)) {
          const { author: _author, ...rest } = s.privateNote
          s.privateNote = rest
        }
        custom.lobbyServer = s
      }
    }
    return copy
  })
}
