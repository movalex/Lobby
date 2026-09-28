// A11Y-07: a keyboard-only way to put a shape on the board. tldraw 5.4.2's note, geo and text tools
// create only on a pointer press, so "N, then Enter" did nothing and a blank board was a dead end without
// a mouse. Now:
//  - Enter, with the note, shape (geo) or text tool picked and the board focused, places that shape in
//    the middle of the view, clear of what is already there, selects it and starts typing in it;
//  - the dock's "Add a sticky note" button (FeatureHost.tsx) does the same for a note from anywhere.
// One undo step each. Read-only boards, open menus and dialogs, and text fields keep their Enter.

import {
  createShapeId,
  type Editor,
  GeoShapeGeoStyle,
  startEditingShapeWithRichText,
  type TLParentId,
  type TLShape,
  type TLShapeId,
  toRichText,
  type VecLike,
} from 'tldraw'
import { NOTE_SIZE } from '../features/canvas-ux/deps.ts'
import { findEmptySpot, type Rect } from '../features/canvas-ux/placement.ts'

export type PlaceableTool = 'note' | 'geo' | 'text'

/** A new shape keeps this much space (page units) from what is already on the board. */
export const PLACE_GAP = 24
/** tldraw's size for a clicked (not dragged) rectangle or ellipse. */
const GEO_SIZE = 200

export interface PlaceKeyLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
}

export interface PlaceKeyState {
  /** The key went to the board itself (the editor container or the canvas), not a control or field. */
  onBoard: boolean
  readonly: boolean
  /** A shape is being edited (typing goes into it). */
  editing: boolean
  menusOpen: boolean
  modalOpen: boolean
  /** editor.getPath(), e.g. 'note.idle'. */
  path: string
  /** The type of the one selected shape, if exactly one is selected. */
  onlySelectedType: string | null
}

/** Which tool's shape a key press places, or null when the key is not for us (pure; unit tested). */
export function placeOnEnter(e: PlaceKeyLike, s: PlaceKeyState): PlaceableTool | null {
  if (e.key !== 'Enter' || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null
  if (!s.onBoard || s.readonly || s.editing || s.menusOpen || s.modalOpen) return null
  const m = /^(note|geo|text)\.idle$/.exec(s.path)
  const tool = (m?.[1] ?? null) as PlaceableTool | null
  // tldraw's own Enter in the shape tool edits the label of the one selected shape: keep that.
  if (tool === 'geo' && s.onlySelectedType === 'geo') return null
  return tool
}

/** The size (page units) a placed shape takes, for finding room for it. */
export function placedSize(tool: PlaceableTool, scale: number): { w: number; h: number } {
  if (tool === 'note') return { w: NOTE_SIZE, h: NOTE_SIZE }
  if (tool === 'geo') return { w: GEO_SIZE * scale, h: GEO_SIZE * scale }
  return { w: 120 * scale, h: 40 * scale }
}

/** What a new shape must stay clear of: everything on the page but frames (it may go inside those). */
function obstacles(editor: Editor): Rect[] {
  const out: Rect[] = []
  for (const s of editor.getCurrentPageShapes()) {
    if (s.type === 'frame' || s.type === 'group') continue
    const b = editor.getShapePageBounds(s)
    if (b) out.push({ x: b.x, y: b.y, w: b.w, h: b.h })
  }
  return out
}

/** The innermost unlocked frame whose area contains the point (the new shape goes inside it). */
function frameAt(editor: Editor, point: VecLike): TLShape | undefined {
  return editor.getShapeAtPoint(point, {
    hitInside: true,
    hitFrameInside: true,
    filter: (s) => s.type === 'frame' && !editor.isShapeOrAncestorLocked(s),
  })
}

/**
 * Creates the tool's shape in the middle of the view (or the nearest free spot), selects it and starts
 * editing its text. Returns its id, or null on a read-only board.
 */
export function placeAtCenter(editor: Editor, tool: PlaceableTool): TLShapeId | null {
  if (editor.getIsReadonly()) return null
  const scale = tool === 'note' ? 1 : editor.getResizeScaleFactor()
  const size = placedSize(tool, scale)
  const view = editor.getViewportPageBounds()
  const spot = findEmptySpot(size, view.center, obstacles(editor), { gap: PLACE_GAP })
  const frame = frameAt(editor, { x: spot.x + size.w / 2, y: spot.y + size.h / 2 })
  const local = frame ? editor.getPointInShapeSpace(frame, spot) : spot
  const parentId: TLParentId = frame ? frame.id : editor.getCurrentPageId()
  const id = createShapeId()
  editor.markHistoryStoppingPoint(`dr-place-${tool}`)
  const base = { id, x: local.x, y: local.y, parentId }
  // Colour, fill, font and size come from the styles for the next shape, as with a click.
  if (tool === 'note') editor.createShapes([{ ...base, type: 'note' }])
  else if (tool === 'geo')
    editor.createShapes([
      {
        ...base,
        type: 'geo',
        props: { geo: editor.getStyleForNextShape(GeoShapeGeoStyle), w: size.w, h: size.h, scale },
      },
    ])
  else
    editor.createShapes([
      { ...base, type: 'text', props: { richText: toRichText(''), autoSize: true, w: 20, scale } },
    ])
  const shape = editor.getShape(id)
  if (!shape) return null
  editor.select(id)
  // A crowded view pushes it to the nearest free spot, which can be off screen: bring it into view.
  const bounds = editor.getShapePageBounds(id)
  if (bounds && !view.contains(bounds)) editor.zoomToSelectionIfOffscreen(64)
  startEditingShapeWithRichText(editor, shape)
  return id
}

function isControl(el: Element): boolean {
  const h = el as HTMLElement
  if (h.isContentEditable) return true
  if (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(h.tagName)) return true
  const role = h.getAttribute('role')
  return role === 'button' || role === 'menuitem' || role === 'option' || role === 'tab'
}

/** The key went to the board: its container (what "focus on the canvas" focuses) or the canvas. */
function isBoardTarget(editor: Editor, target: EventTarget | null): boolean {
  const container = editor.getContainer()
  const el = target as Element | null
  if (!el || typeof (el as HTMLElement).tagName !== 'string') return false
  if (el === container) return true
  return container.contains(el) && el.closest('.tl-canvas') !== null && !isControl(el)
}

/**
 * Listens for Enter with a creation tool picked (capture phase on the editor's document, before
 * tldraw's own keys). The matching key up is swallowed too, so tldraw's Enter-on-key-up never edits
 * something else afterwards.
 */
export function installPlaceOnEnter(editor: Editor): () => void {
  const doc = editor.getContainer().ownerDocument
  let swallowUp = false
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    const only = editor.getOnlySelectedShape()
    const tool = placeOnEnter(e, {
      onBoard: isBoardTarget(editor, e.target),
      readonly: editor.getIsReadonly(),
      editing: editor.getEditingShapeId() !== null,
      menusOpen: editor.menus.hasAnyOpenMenus(),
      modalOpen: doc.querySelector('dialog[open]') !== null,
      path: editor.getPath(),
      onlySelectedType: only?.type ?? null,
    })
    if (!tool) return
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat) return
    swallowUp = true
    placeAtCenter(editor, tool)
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (!swallowUp || e.key !== 'Enter') return
    swallowUp = false
    e.preventDefault()
    e.stopPropagation()
  }
  doc.addEventListener('keydown', onKeyDown, true)
  doc.addEventListener('keyup', onKeyUp, true)
  return () => {
    doc.removeEventListener('keydown', onKeyDown, true)
    doc.removeEventListener('keyup', onKeyUp, true)
  }
}
