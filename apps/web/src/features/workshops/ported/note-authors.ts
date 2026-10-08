// OWNER: 3f. Who last edited each sticky note, for the note-author label on the Excalidraw page (CR-3F-4;
// plan §4.3 "Attribution", §4.4 "Hide note authors"). The tldraw note face drew it (NoteShapeUtil's
// `.tl-note__attribution`, from `props.textLastEditedBy`); here the note is an Excalidraw element, so the
// label is an overlay (./NoteAuthors.tsx) and this module decides what it shows. Pure, over CanvasElement
// and a lookup, so it runs in Node tests.
//
// - The author is the note label's `customData.lobbyServer.lastEditedBy` (canvas-schema LobbyServer): the
//   sync server stamps it from the ticket when a text element is created with text or its text changes,
//   and place-notes stamps the draft's author (or null for an anonymous reveal). The client never writes it.
// - As tldraw's: nothing on a note without text or without an author; the first word of the name, with the
//   whole name kept for the label's title. K3-6: nothing on a note that arrived with its words (a template's,
//   the sample's, a paste) until someone edits them (`madeWithItsWords`): the template is nobody's idea.
// - The label sits in the note's bottom right corner. It is left out where Excalidraw would not show that
//   corner: under an opaque element painted above the note (another note, an image, a filled shape; the
//   same rule as the file-card faces), outside the note's frame (frames clip their children), on a
//   collapsed mind-map branch, and on the note this tab is typing in.
import { type CanvasElement, geometry, items } from '../../../canvas/api/index.ts'

export type Lookup = (id: string) => CanvasElement | undefined

interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface NoteAuthor {
  /** the note's element id */
  readonly id: string
  /** the note's box in scene units (unrotated) and its rotation, radians */
  readonly box: Box
  readonly angle: number
  /** what the label shows (the first name) and its title (the whole name) */
  readonly short: string
  readonly full: string
  /** the note label's ink (its stroke colour) and the note's opacity (0-1) */
  readonly color: string
  readonly opacity: number
}

/** The label's band at the bottom of a note, scene units: its line and the 4 px under it (tldraw's CSS). */
export const LABEL_BAND = 20
/** The share of the note's width the label may take, from the right (tldraw's `max-width: 60%`). */
export const LABEL_WIDTH_SHARE = 0.6
const CELL = 512

/** tldraw's short attribution: the first word of the name. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? ''
}

/** The label's author: the bound label's server-stamped last editor, or null. */
export function lastEditorOf(label: CanvasElement | undefined): { name: string } | null {
  const server = (label?.customData as { lobbyServer?: { lastEditedBy?: unknown } } | null | undefined)
    ?.lobbyServer
  const by = server?.lastEditedBy as { name?: unknown } | null | undefined
  return by && typeof by.name === 'string' && by.name.trim() ? { name: by.name.trim() } : null
}

interface ServerStamp {
  readonly createdAt?: unknown
  readonly lastEditedAt?: unknown
  readonly privateNote?: unknown
}

const stampOf = (el: CanvasElement | undefined): ServerStamp | null => {
  const s = (el?.customData as { lobbyServer?: unknown } | null | undefined)?.lobbyServer
  return s && typeof s === 'object' ? (s as ServerStamp) : null
}

/** A template's prompt note (`customData.lobby.prompt`, what the template emitter writes: CR-3H-2). */
const promptNote = (note: CanvasElement) =>
  (note.customData as { lobby?: { prompt?: unknown } } | null | undefined)?.lobby?.prompt === 'true'

/**
 * K3-6: a note that came onto the board with its words already in it and that nobody has typed in since:
 * a template's or the sample board's note, and a pasted, duplicated or generated one. The sync server
 * stamps both elements of such a note in the one write that created them (canvas-schema LobbyServer:
 * `createdAt` is that write's time on the note and on its label, and the label's `lastEditedAt` too), while
 * a note made with the note tool gets its label later, when someone types in it, and any later typing
 * moves the label's `lastEditedAt` on. A template's prompt note is told by its marker as well. Its "last
 * editor" is only whoever put it there, so it shows no author until someone edits its words. Revealed
 * private notes (`privateNote` on the note: place-notes writes the drafts' authors) keep their author.
 */
export function madeWithItsWords(note: CanvasElement, label: CanvasElement): boolean {
  const n = stampOf(note)
  const l = stampOf(label)
  if (!l || n?.privateNote) return false
  if (typeof l.createdAt !== 'number' || l.lastEditedAt !== l.createdAt) return false
  return promptNote(note) || (typeof n?.createdAt === 'number' && n.createdAt === l.createdAt)
}

/**
 * Whether an element painted above a note hides what is under it (the file-card faces' rule): notes,
 * images and shapes with a solid, fully opaque fill. Frames, texts, lines and unfilled shapes do not.
 */
export function opaque(el: CanvasElement): boolean {
  if (el.type === 'stickynote' || el.type === 'image') return true
  if (el.type !== 'rectangle' && el.type !== 'ellipse' && el.type !== 'diamond') return false
  const e = el as { backgroundColor?: string; fillStyle?: string; opacity?: number }
  return e.backgroundColor !== 'transparent' && e.fillStyle === 'solid' && (e.opacity ?? 100) >= 100
}

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h

/** The axis-aligned box of `r` rotated by `angle` around the point `about`. */
function rotatedBox(r: Box, angle: number, about: { x: number; y: number }): Box {
  if (!angle) return r
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const pts = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ].map((p) => ({
    x: about.x + (p.x - about.x) * cos - (p.y - about.y) * sin,
    y: about.y + (p.x - about.x) * sin + (p.y - about.y) * cos,
  }))
  const b = geometry.fromPoints(pts)
  return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : r
}

/** An element's axis-aligned box from its own fields, rotation included. */
function aabbOf(el: CanvasElement): Box {
  const r = { x: el.x, y: el.y, w: el.width, h: el.height }
  return rotatedBox(r, el.angle ?? 0, { x: r.x + r.w / 2, y: r.y + r.h / 2 })
}

/** Where the label is drawn on `note`, as a scene box (axis-aligned, rotation included). */
export function labelBandOf(note: CanvasElement): Box {
  const band = {
    x: note.x + note.width * (1 - LABEL_WIDTH_SHARE),
    y: note.y + note.height - LABEL_BAND,
    w: note.width * LABEL_WIDTH_SHARE,
    h: LABEL_BAND,
  }
  return rotatedBox(band, note.angle ?? 0, { x: note.x + note.width / 2, y: note.y + note.height / 2 })
}

/** Opaque elements by grid cell, with their paint index: which ones may cover a band is a local lookup. */
class Occluders {
  private readonly cells = new Map<string, Occluder[]>()
  /** elements over more than BIG_CELLS cells (a background image): checked for every band */
  private readonly big: Occluder[] = []

  add(index: number, el: CanvasElement): void {
    const o = { index, box: aabbOf(el), id: el.id }
    const [x0, x1, y0, y1] = span(o.box)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > BIG_CELLS) {
      this.big.push(o)
      return
    }
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const key = `${x}:${y}`
        const list = this.cells.get(key)
        if (list) list.push(o)
        else this.cells.set(key, [o])
      }
  }

  /** Whether an element painted after `index` covers part of `band` (a note-sized box). */
  covers(band: Box, index: number): boolean {
    const hit = (o: Occluder) => o.index > index && overlap(o.box, band)
    if (this.big.some(hit)) return true
    const [x0, x1, y0, y1] = span(band)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) if (this.cells.get(`${x}:${y}`)?.some(hit)) return true
    return false
  }
}

interface Occluder {
  readonly index: number
  readonly box: Box
  readonly id: string
}

const BIG_CELLS = 64

/** The grid cells a box spans: [x0, x1, y0, y1]. */
function span(b: Box): [number, number, number, number] {
  return [
    Math.floor(b.x / CELL),
    Math.floor((b.x + b.w) / CELL),
    Math.floor(b.y / CELL),
    Math.floor((b.y + b.h) / CELL),
  ]
}

export interface NoteAuthorsOptions {
  readonly get: Lookup
  /** hidden by a mind-map collapse (`canvas.isHidden`) */
  readonly hidden: (id: string) => boolean
  /** this tab's open editor (`canvas.editingId()`): the note or its label */
  readonly editing: string | null
}

/**
 * The note-author labels to draw for `elements` (the live elements, in paint order: `canvas.items()`).
 * Linear in the elements, plus a grid lookup per note for the elements painted above it.
 */
export function noteAuthorsOf(
  elements: readonly CanvasElement[],
  { get, hidden, editing }: NoteAuthorsOptions,
): NoteAuthor[] {
  const occluders = new Occluders()
  const notes: { index: number; el: CanvasElement }[] = []
  elements.forEach((el, index) => {
    // an element that cannot be seen (a collapsed branch) hides nothing
    if (opaque(el) && !hidden(el.id)) occluders.add(index, el)
    if (el.type === 'stickynote') notes.push({ index, el })
  })
  const out: NoteAuthor[] = []
  for (const { index, el } of notes) {
    if (hidden(el.id) || el.id === editing) continue
    const label = items.labelOf(el, get)
    if (!label || label.id === editing) continue
    const text = String((label as { originalText?: unknown }).originalText ?? '')
    if (!text.trim()) continue
    const by = lastEditorOf(label)
    if (!by || madeWithItsWords(el, label)) continue
    const band = labelBandOf(el)
    if (occluders.covers(band, index)) continue
    const frameId = (el as { frameId?: string | null }).frameId
    if (frameId) {
      const frame = get(frameId)
      if (frame && !(frame as { isDeleted?: boolean }).isDeleted && !contains(aabbOf(frame), band)) continue
    }
    out.push({
      id: el.id,
      box: { x: el.x, y: el.y, w: el.width, h: el.height },
      angle: el.angle ?? 0,
      short: firstName(by.name),
      full: by.name,
      color: String((label as { strokeColor?: unknown }).strokeColor ?? '#1e1e1e'),
      opacity: Math.max(0, Math.min(1, ((el as { opacity?: number }).opacity ?? 100) / 100)),
    })
  }
  return out
}
