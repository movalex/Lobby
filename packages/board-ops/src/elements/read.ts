/**
 * Readers over Excalidraw elements as Lobby stores them (canvas-schema `elements.ts` `WireElement`), for the
 * servers and for ported web code alike. Excalidraw keeps structure in fields, not parents: a note's text is
 * its bound label (`boundElements` → the text whose `containerId` names it), a frame's children carry
 * `frameId`, a group is a shared `groupIds` entry. Readers follow `containerId` and `boundElements`, never
 * id suffixes (docs/EXCALIDRAW-MIGRATION.md §3.6), and tolerate malformed input (they never throw).
 *
 * The same rules as the web's `apps/web/src/canvas/api/items.ts` (wave 1), which ported code uses on live
 * canvas data; this module is the one for plain element lists (archives, snapshots, server reads).
 *
 * Pure: no imports.
 */

/** The fields the readers use; any element-shaped object (a `WireElement`, a canvas element) will do. */
export interface BoardElement {
  readonly id: string
  readonly type: string
  readonly x?: number
  readonly y?: number
  readonly width?: number
  readonly height?: number
  readonly angle?: number
  readonly index?: string | null
  readonly isDeleted?: boolean
  readonly frameId?: string | null
  readonly groupIds?: readonly string[]
  readonly containerId?: string | null
  readonly boundElements?: readonly { readonly id: string; readonly type: string }[] | null
  readonly originalText?: string
  readonly text?: string
  readonly name?: string | null
  readonly strokeColor?: string
  readonly backgroundColor?: string
  readonly fileId?: string
  readonly customData?: {
    readonly lobby?: Readonly<Record<string, unknown>>
    readonly lobbyServer?: unknown
  }
}

export type ElementLookup = (id: string) => BoardElement | undefined

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** The element-shaped entries of an untrusted list (an `id` and a `type` string), live and deleted. */
export function asElements(list: Iterable<unknown>): BoardElement[] {
  const out: BoardElement[] = []
  for (const e of list)
    if (isObj(e) && typeof e.id === 'string' && typeof e.type === 'string') out.push(e as never)
  return out
}

/** A lookup over `elements` by id (the first element of an id wins). */
export function lookupOf(elements: Iterable<BoardElement>): ElementLookup {
  const byId = new Map<string, BoardElement>()
  for (const e of elements) if (!byId.has(e.id)) byId.set(e.id, e)
  return (id) => byId.get(id)
}

export const isLive = (el: BoardElement | undefined): el is BoardElement => !!el && el.isDeleted !== true

/** A bound label (a text whose `containerId` is set). */
export const isLabel = (el: BoardElement): boolean => el.type === 'text' && !!el.containerId

/** `customData.lobby[key]`, or undefined. */
export function lobbyValue(el: BoardElement | undefined, key: string): unknown {
  const lobby = el?.customData?.lobby
  return isObj(lobby) && Object.hasOwn(lobby, key) ? lobby[key] : undefined
}

/** The live bound label of a container (a note, a shape, an arrow), or undefined. */
export function labelOf(el: BoardElement, get: ElementLookup): BoardElement | undefined {
  const bound = Array.isArray(el.boundElements) ? el.boundElements : []
  for (const b of bound) {
    if (!isObj(b) || b.type !== 'text' || typeof b.id !== 'string') continue
    const label = get(b.id)
    if (isLive(label) && label.type === 'text' && label.containerId === el.id) return label
  }
  return undefined
}

/** The words of a text element (`originalText`, the unwrapped words; `text` for data without it). */
export function wordsOf(el: BoardElement): string {
  return typeof el.originalText === 'string' ? el.originalText : str(el.text)
}

/**
 * What Lobby calls an element (tldraw's shape types, for readers and exports): `note` (stickynote),
 * `text` (free text), `label` (a bound text), `rectangle`, `ellipse`, `diamond`, `arrow`, `line`, `draw`,
 * `highlight`, `image`, `file-card`, `frame`, or the element's own type when Lobby has no name for it.
 */
export function kindOf(el: BoardElement): string {
  switch (el.type) {
    case 'stickynote':
      return 'note'
    case 'text':
      return el.containerId ? 'label' : 'text'
    case 'freedraw':
      return lobbyValue(el, 'kind') === 'highlight' ? 'highlight' : 'draw'
    case 'image': {
      const file = lobbyValue(el, 'file')
      const kind = isObj(file) ? file.kind : undefined
      if (kind === undefined) return 'image'
      return kind === 'image' && lobbyValue(el, 'pdfPage') === undefined ? 'image' : 'file-card'
    }
    default:
      return el.type
  }
}

/**
 * The user-visible text of an element, for search, CSV and exports: a note's, shape's or arrow's label
 * words, a free text's words, a frame's name, an image's alt text and file name ("alt · name"). A bound
 * label itself reads as '' (its words belong to its container). Returns '' when there is nothing.
 */
export function elementText(el: BoardElement, get: ElementLookup): string {
  try {
    switch (el.type) {
      case 'text':
        return el.containerId ? '' : wordsOf(el)
      case 'frame':
        return str(el.name)
      case 'image': {
        const alt = str(lobbyValue(el, 'alt')).trim()
        const file = lobbyValue(el, 'file')
        const name = isObj(file) ? str(file.name).trim() : ''
        return alt && name ? `${alt} · ${name}` : alt || name
      }
      case 'stickynote':
      case 'rectangle':
      case 'ellipse':
      case 'diamond':
      case 'arrow': {
        const label = labelOf(el, get)
        return label ? wordsOf(label) : ''
      }
      default:
        return ''
    }
  } catch {
    return ''
  }
}

/** Scene-space axis-aligned bounds (rotation included) of an element's box. */
export function elementBounds(el: BoardElement): { x: number; y: number; w: number; h: number } {
  const x = finite(el.x)
  const y = finite(el.y)
  const w = Math.max(0, finite(el.width))
  const h = Math.max(0, finite(el.height))
  const angle = finite(el.angle)
  if (!angle) return { x, y, w, h }
  // Excalidraw rotates about the box centre
  const cx = x + w / 2
  const cy = y + h / 2
  const cos = Math.abs(Math.cos(angle))
  const sin = Math.abs(Math.sin(angle))
  const bw = w * cos + h * sin
  const bh = w * sin + h * cos
  return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh }
}

/** Excalidraw's paint order: by `index` (string compare), ties by `id` (`orderByFractionalIndex`). */
export function compareByIndex(a: BoardElement, b: BoardElement): number {
  const ai = str(a.index)
  const bi = str(b.index)
  if (ai < bi) return -1
  if (ai > bi) return 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
