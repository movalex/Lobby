// How the internal routes read stored elements (docs/EXCALIDRAW-MIGRATION.md §3.1, §3.3, §3.6): what an
// element is in the api's object vocabulary (the tldraw shape types the api's search, "Recently deleted"
// list and vote eligibility already speak), its user-visible text, and the file versions it shows.
//
// Pure and tolerant: stored rows were schema-checked when written, but nothing here throws on a
// malformed one (it reads as having no text and no file).

import { MAX_ALT_CHARS, VERSION_ID_PATTERN, versionIdOf } from '@draftroom/canvas-schema/limits'
import { toShapeRef } from '@draftroom/canvas-schema/refs'

// biome-ignore lint/suspicious/noExplicitAny: stored elements are JSON, read field by field
export type El = Record<string, any> & { id: string; type: string }

const ASSET_ID_RE = /^ast_[0-9A-Za-z]{10,40}$/
const ELEMENT_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A parsed stored element, or null when the JSON is not an element with an id and a type. */
export function parseElement(data: string): El | null {
  try {
    const el = JSON.parse(data) as unknown
    if (!isObject(el) || typeof el.id !== 'string' || typeof el.type !== 'string') return null
    return el as El
  } catch {
    return null
  }
}

/** `shape:<id>` (canvas-schema refs.ts), or null for an id outside the element id pattern. */
export function refOf(id: string): string | null {
  if (!ELEMENT_ID_RE.test(id)) return null
  try {
    return toShapeRef(id)
  } catch {
    return null
  }
}

/** A text bound to a container (a note's, a shape's or an arrow's label): part of its container, never an object of its own. */
export const isLabel = (el: El): boolean =>
  el.type === 'text' && typeof el.containerId === 'string' && el.containerId.length > 0

/** `customData.lobby` (empty when absent). */
export const lobbyOf = (el: El): Record<string, unknown> => {
  const lobby = isObject(el.customData) ? el.customData.lobby : undefined
  return isObject(lobby) ? lobby : {}
}

/** The stable file facts of an image or file card (`customData.lobby.file`), as far as they are valid. */
export interface ElementFile {
  readonly versionId: string
  /** null when the element carries no `file` facts (a plain image placed before its facts were known) */
  readonly assetId: string | null
  readonly kind: 'image' | 'pdf' | 'video' | 'other' | null
  readonly name: string
}

export function fileOf(el: El): ElementFile | null {
  if (el.type !== 'image' || typeof el.fileId !== 'string') return null
  const versionId = versionIdOf(el.fileId)
  if (!VERSION_ID_PATTERN.test(versionId)) return null
  const file = lobbyOf(el).file
  const facts = isObject(file) && file.versionId === versionId ? file : null
  const assetId = typeof facts?.assetId === 'string' && ASSET_ID_RE.test(facts.assetId) ? facts.assetId : null
  const kind =
    facts?.kind === 'image' || facts?.kind === 'pdf' || facts?.kind === 'video' || facts?.kind === 'other'
      ? facts.kind
      : null
  const name = typeof facts?.name === 'string' ? facts.name : ''
  return { versionId, assetId, kind, name }
}

/** A placed PDF page (`fileId` with `.p<n>`) is an image of its page, not a file card. */
const isPdfPage = (el: El): boolean => typeof el.fileId === 'string' && /\.p[1-9][0-9]{0,3}$/.test(el.fileId)

/**
 * The api's object type of an element: the tldraw shape type the api's readers use (search kinds,
 * "Recently deleted" labels, vote eligibility). Bound labels have none (they are their container's).
 */
export function objectTypeOf(el: El): string | null {
  switch (el.type) {
    case 'stickynote':
      return 'note'
    case 'rectangle':
    case 'ellipse':
    case 'diamond':
      return 'geo'
    case 'text':
      return isLabel(el) ? null : 'text'
    case 'arrow':
      return 'arrow'
    case 'line':
      return 'line'
    case 'freedraw':
      return lobbyOf(el).kind === 'highlight' ? 'highlight' : 'draw'
    case 'frame':
      return 'frame'
    case 'image': {
      const file = fileOf(el)
      if (!file || isPdfPage(el) || file.kind === null || file.kind === 'image') return 'image'
      return file.kind === 'video' ? 'video' : 'dr-file-card'
    }
    default:
      return null
  }
}

/** Labels by the id of the container they name (live elements only are passed in). */
export function labelsByContainer(elements: Iterable<El>): Map<string, El> {
  const out = new Map<string, El>()
  for (const el of elements)
    if (isLabel(el) && !out.has(el.containerId as string)) out.set(el.containerId, el)
  return out
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * The user-visible text of an object (never of a bound label, whose text is its container's): a note's,
 * shape's or arrow's label, a free text, a frame's name, an image's alt text with its file name, a file
 * card's file name. '' when it has none.
 */
export function objectText(el: El, labels: ReadonlyMap<string, El>): string {
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
    case 'image': {
      const type = objectTypeOf(el)
      const name = fileOf(el)?.name.trim() ?? ''
      if (type === 'dr-file-card' || type === 'video') return name
      const alt = str(lobbyOf(el).alt).slice(0, MAX_ALT_CHARS).trim()
      return alt && name ? `${alt} · ${name}` : alt || name
    }
    default:
      return ''
  }
}
