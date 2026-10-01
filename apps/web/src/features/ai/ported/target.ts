// OWNER: 3h. What an AI action works on, on the Excalidraw board page (the tldraw twin is ../target.ts):
// the selection, or, with nothing selected, the frame under the pointer (context menu) or in the middle
// of the view. Only object refs (`shape:<elementId>`, what the api reads the text of) go to the api; the
// counts here only decide which menu items make sense. The rules are the api's
// (apps/api/src/features/ai/sources.ts): a note's text is its label, frames stand for their children,
// and "Group into themes" leaves a template's prompt notes where they are (contracts splitThemeNotes).

import { AI_MAX_REQUEST_SHAPES, splitThemeNotes } from '@draftroom/contracts'
import {
  type Bounds,
  type CanvasElement,
  geometry,
  items,
  type LobbyCanvas,
} from '../../../canvas/api/index.ts'
import { plural } from '../copy.ts'

export interface AiTarget {
  kind: 'selection' | 'frame' | 'none'
  /** Element ids of the target (frames stand for their contents at the api). */
  ids: string[]
  /** "3 sticky notes", "the frame “Brainstorm”", "nothing selected". */
  label: string
  /** Unlocked sticky notes with text, less prompt notes: "Group into themes" needs two. */
  notes: number
  /** Prompt and instruction notes "Group into themes" leaves where they are (contracts splitThemeNotes). */
  prompts: number
  /** Names of groups the notes already sit in (boxes in their frame); empty when fewer than two. */
  groups: string[]
  /** Objects with text (notes, text, shape and connector labels). */
  texts: number
  /** Scene bounds of what the action is about (where results go), or null. */
  bounds: Bounds | null
}

/** Objects looked at when counting (a huge frame stops counting here: the api has its own caps). */
const COUNT_LIMIT = 600

const SHAPE_REF = 'shape:'
/** The api's object ref of an element. */
export const refOf = (id: string) => (id.startsWith(SHAPE_REF) ? id : `${SHAPE_REF}${id}`)
/** The element id of an api object ref. */
export const idOfRef = (ref: string) => (ref.startsWith(SHAPE_REF) ? ref.slice(SHAPE_REF.length) : ref)

export const isLive = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted
const isFrame = (el: CanvasElement) => el.type === 'frame'
export const isNote = (el: CanvasElement) => el.type === 'stickynote'

/** Everything `ids` stands for: a bound label stands for its container, hidden (collapsed) ids go. */
function resolve(canvas: LobbyCanvas, ids: readonly string[]): CanvasElement[] {
  const get = (id: string) => canvas.get(id)
  const out = new Map<string, CanvasElement>()
  for (const id of ids) {
    const el = canvas.get(id)
    if (!isLive(el) || canvas.isHidden(id)) continue
    const root = items.containerOf(el, get)
    if (isLive(root)) out.set(root.id, root)
  }
  return [...out.values()]
}

const serverOf = (el: CanvasElement): Record<string, unknown> => {
  const v = (el.customData as { lobbyServer?: unknown } | null | undefined)?.lobbyServer
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

/** What "Group into themes" asks of a note (the api's shapesOfElements facts, the same keys). */
export function noteFacts(canvas: LobbyCanvas, note: CanvasElement) {
  const label = items.labelOf(note, (id) => canvas.get(id))
  const editedBy = label ? serverOf(label).lastEditedBy : undefined
  return {
    meta: {
      draftroomPrompt: items.lobbyValue(note, 'prompt'),
      drPrivateNote: serverOf(note).privateNote,
      drAi: items.lobbyValue(note, 'ai'),
    },
    textLastEditedBy:
      typeof editedBy === 'object' &&
      editedBy !== null &&
      typeof (editedBy as { uid?: unknown }).uid === 'string'
        ? (editedBy as { uid: string }).uid
        : null,
  }
}

function count(canvas: LobbyCanvas, roots: readonly CanvasElement[]) {
  const all = canvas.items()
  const candidates: CanvasElement[] = []
  let texts = 0
  let seen = 0
  const stack = [...roots]
  while (stack.length && seen < COUNT_LIMIT) {
    const el = stack.pop()
    if (!el) break
    seen++
    if (isFrame(el)) {
      for (const id of items.childrenOf(el.id, all)) {
        const c = canvas.get(id)
        if (isLive(c) && !(c.type === 'text' && c.containerId) && !canvas.isHidden(id)) stack.push(c)
      }
      continue
    }
    if (!canvas.text.of(el.id).trim()) continue
    texts++
    if (isNote(el) && !canvas.isLocked(el.id)) candidates.push(el)
  }
  // The api's rule (contracts splitThemeNotes): a template's prompt notes are not grouped.
  const { ideas, prompts } = splitThemeNotes(candidates, (n) => noteFacts(canvas, n))
  return { notes: ideas.length, prompts: prompts.length, texts }
}

function describe(els: readonly CanvasElement[], notes: number): string {
  const only = els.length === 1 ? els[0] : undefined
  if (only && isFrame(only)) {
    const name = String((only as { name?: string | null }).name ?? '').trim()
    return name ? `the frame “${name}”` : 'the frame'
  }
  if (els.every(isNote)) return plural(els.length, 'sticky note')
  if (notes && notes === els.length) return plural(notes, 'sticky note')
  return plural(els.length, 'selected item')
}

// ---- which frame things are in (W5-04) ---------------------------------------------------------------
//
// Read from the elements' own fields, never `canvas.bounds` (the port's is a scan of the board per call,
// CR 3b-7): these run over every loose element of the board, and in the context menu's predicates.

/** The live, shown frames of the board with their boxes (smallest first: frames never nest here). */
export interface FrameIndex {
  frames: { el: CanvasElement; b: Bounds }[]
  byId: Map<string, CanvasElement>
}

export function frameIndex(canvas: LobbyCanvas): FrameIndex {
  const frames: FrameIndex['frames'] = []
  const byId = new Map<string, CanvasElement>()
  for (const el of canvas.items()) {
    if (!isFrame(el) || !isLive(el) || canvas.isHidden(el.id)) continue
    byId.set(el.id, el)
    frames.push({ el, b: { x: el.x, y: el.y, width: el.width, height: el.height } })
  }
  frames.sort((p, q) => p.b.width * p.b.height - q.b.width * q.b.height)
  return { frames, byId }
}

/**
 * An element's unrotated box from its own fields (a line's from its points). The engine rotates an
 * element about this box's centre, so the centre is exact for rotated elements too.
 */
function boxOf(el: CanvasElement): Bounds {
  const points = (el as { points?: readonly (readonly [number, number])[] }).points
  if (Array.isArray(points) && points.length) {
    const xs = points.map((q) => q[0])
    const ys = points.map((q) => q[1])
    const x0 = Math.min(...xs)
    const y0 = Math.min(...ys)
    return { x: el.x + x0, y: el.y + y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 }
  }
  return { x: el.x, y: el.y, width: el.width, height: el.height }
}

const centreOf = (b: Bounds) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
const holds = (b: Bounds, p: { x: number; y: number }) =>
  p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height

/**
 * The frame `el` is in: its own (`frameId`) while that frame is on the board; for a loose element (no
 * `frameId`, as a note made with N before W5-01) the innermost unlocked frame its centre lies in, which is
 * the frame a note made there joins. Null on the open canvas, and for frames themselves.
 */
export function frameOfElement(
  canvas: LobbyCanvas,
  el: CanvasElement,
  index: FrameIndex = frameIndex(canvas),
): CanvasElement | null {
  if (isFrame(el)) return null
  if (el.frameId) return index.byId.get(el.frameId) ?? null
  const c = centreOf(boxOf(el))
  return index.frames.find((f) => !f.el.locked && holds(f.b, c))?.el ?? null
}

/**
 * The frame `els` belong in (W5-04): the target itself when it is one frame; else the place most of them
 * are in, counting each by `frameOfElement` (so a note made with N inside a frame counts as in it), a
 * tie going to the frame under their centre; null when that place is the open canvas.
 */
export function homeFrameOf(
  canvas: LobbyCanvas,
  els: readonly CanvasElement[],
  index: FrameIndex = frameIndex(canvas),
): CanvasElement | null {
  const first = els[0]
  if (!first) return null
  if (els.length === 1 && isFrame(first)) return first
  const counts = new Map<string | null, number>()
  for (const el of els) {
    const key = frameOfElement(canvas, el, index)?.id ?? null
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const most = Math.max(...counts.values())
  const tied = [...counts].filter(([, n]) => n === most).map(([k]) => k)
  if (tied.length === 1) return tied[0] ? (index.byId.get(tied[0]) ?? null) : null
  const b = geometry.union(els.map(boxOf))
  const under = b ? index.frames.find((f) => tied.includes(f.el.id) && holds(f.b, centreOf(b))) : undefined
  if (under) return under.el
  if (tied.includes(null)) return null
  const id = tied.find((k): k is string => k !== null)
  return id ? (index.byId.get(id) ?? null) : null
}

const GROUP_NAME_MAX = 40
/** tldraw's rectangle, oval, cloud and hexagon boxes: on the new canvas rectangles and ellipses. */
const BOX_TYPES = new Set(['rectangle', 'ellipse'])

/**
 * Names of the groups the notes already sit in (DANA-10): boxes with a short one-line name in the frame
 * the target is (or is in: `homeFrameOf`, so a note made with N among them changes nothing, W5-04), such
 * as the tour's Gameplay, Story and Community cards. AI's own theme labels and a template's image slots
 * or swatches are not groups. Fewer than two: none.
 */
export function existingGroups(canvas: LobbyCanvas, els: readonly CanvasElement[]): string[] {
  const frameId = homeFrameOf(canvas, els)?.id ?? null
  if (!frameId) return []
  const names: string[] = []
  for (const id of items.childrenOf(frameId, canvas.items())) {
    const c = canvas.get(id)
    if (!isLive(c) || !BOX_TYPES.has(c.type)) continue
    if (
      items.lobbyValue(c, 'ai') !== undefined ||
      items.lobbyValue(c, 'slot') !== undefined ||
      items.lobbyValue(c, 'swatch') !== undefined
    )
      continue
    const text = canvas.text.of(c.id).trim()
    if (text && text.length <= GROUP_NAME_MAX && !text.includes('\n')) names.push(text)
  }
  return names.length >= 2 ? names : []
}

/** The current selection as a target (null when nothing is selected). */
export function selectionTarget(canvas: LobbyCanvas): AiTarget | null {
  const els = resolve(canvas, canvas.selection)
  if (!els.length) return null
  const { notes, prompts, texts } = count(canvas, els)
  return {
    kind: 'selection',
    ids: els.slice(0, AI_MAX_REQUEST_SHAPES).map((e) => e.id),
    label: describe(els, notes),
    notes,
    prompts,
    groups: existingGroups(canvas, els),
    texts,
    bounds: canvas.boundsOf(els.map((e) => e.id)),
  }
}

/**
 * A frame as the target: it stands for its children at the api, and the loose elements lying in it (a
 * note made with N there, W5-01) are named beside it, so they count, are read and are grouped (W5-04).
 */
function frameTarget(canvas: LobbyCanvas, frame: CanvasElement): AiTarget {
  const index = frameIndex(canvas)
  const loose = canvas
    .items()
    .filter(
      (e) =>
        isLive(e) &&
        !e.frameId &&
        !isFrame(e) &&
        !(e.type === 'text' && e.containerId) &&
        !canvas.isHidden(e.id) &&
        frameOfElement(canvas, e, index)?.id === frame.id,
    )
  const { notes, prompts, texts } = count(canvas, [frame, ...loose])
  return {
    kind: 'frame',
    ids: [frame.id, ...loose.map((e) => e.id)].slice(0, AI_MAX_REQUEST_SHAPES),
    label: describe([frame], notes),
    notes,
    prompts,
    groups: existingGroups(canvas, [frame]),
    texts,
    bounds: canvas.bounds(frame.id),
  }
}

/** The frontmost frame containing `point` (scene coordinates). */
export function frameAt(canvas: LobbyCanvas, point: { x: number; y: number }): CanvasElement | null {
  let hit: CanvasElement | null = null
  // items() is in paint order: the last match is the frontmost
  for (const el of canvas.items()) {
    if (!isFrame(el) || canvas.isHidden(el.id)) continue
    const b = canvas.bounds(el.id)
    if (b && point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height)
      hit = el
  }
  return hit
}

export const NONE: AiTarget = {
  kind: 'none',
  ids: [],
  label: 'nothing selected',
  notes: 0,
  prompts: 0,
  groups: [],
  texts: 0,
  bounds: null,
}

/** The selection, else the frame at `point`, else nothing. */
export function targetAt(canvas: LobbyCanvas, point: { x: number; y: number } | null): AiTarget {
  const sel = selectionTarget(canvas)
  if (sel) return sel
  const frame = point ? frameAt(canvas, point) : null
  return frame ? frameTarget(canvas, frame) : NONE
}

/** The selection, else the frame in the middle of the view, else nothing. */
export function viewTarget(canvas: LobbyCanvas): AiTarget {
  const v = canvas.viewport.get()
  return targetAt(canvas, { x: v.x + v.width / 2, y: v.y + v.height / 2 })
}
