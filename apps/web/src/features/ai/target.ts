// What an AI action works on (docs/WAVE4-CONTRACTS.md §4 ai-assist): the selection, or, with nothing
// selected, the frame under the pointer (context menu) or in the middle of the view. Only shape ids go
// to the api, which reads the text itself; the counts here only decide which menu items make sense.

import { AI_MAX_REQUEST_SHAPES } from '@draftroom/contracts'
import {
  type Box,
  type Editor,
  renderPlaintextFromRichText,
  type TLRichText,
  type TLShape,
  type TLShapeId,
  type VecLike,
} from 'tldraw'
import { plural } from './copy.ts'

export interface AiTarget {
  kind: 'selection' | 'frame' | 'none'
  /** Sent to the api (frames and groups stand for their contents there). */
  ids: TLShapeId[]
  /** "3 sticky notes", "the frame “Brainstorm”", "nothing selected". */
  label: string
  /** Unlocked sticky notes with text: "Group into themes" needs two. */
  notes: number
  /** Shapes with text (notes, text, shape and connector labels). */
  texts: number
  /** Page bounds of what the action is about (where results go), or null. */
  bounds: Box | null
}

/** Shapes looked at when counting (a huge frame stops counting here: the api has its own caps). */
const COUNT_LIMIT = 600

const TEXT_TYPES = new Set(['note', 'text', 'geo', 'arrow'])

function hasText(editor: Editor, shape: TLShape): boolean {
  if (!TEXT_TYPES.has(shape.type)) return false
  const rich = (shape.props as { richText?: TLRichText }).richText
  if (!rich) return false
  try {
    return renderPlaintextFromRichText(editor, rich).trim().length > 0
  } catch {
    return false
  }
}

function count(editor: Editor, roots: readonly TLShape[]): { notes: number; texts: number } {
  let notes = 0
  let texts = 0
  let seen = 0
  const stack = [...roots]
  while (stack.length && seen < COUNT_LIMIT) {
    const s = stack.pop()
    if (!s) break
    seen++
    if (s.type === 'frame' || s.type === 'group') {
      for (const id of editor.getSortedChildIdsForParent(s.id)) {
        const c = editor.getShape(id)
        if (c) stack.push(c)
      }
      continue
    }
    if (!hasText(editor, s)) continue
    texts++
    if (s.type === 'note' && !editor.isShapeOrAncestorLocked(s)) notes++
  }
  return { notes, texts }
}

function describe(shapes: readonly TLShape[], notes: number): string {
  const only = shapes.length === 1 ? shapes[0] : undefined
  if (only?.type === 'frame') {
    const name = (only.props as { name?: string }).name?.trim()
    return name ? `the frame “${name}”` : 'the frame'
  }
  if (shapes.every((s) => s.type === 'note')) return plural(shapes.length, 'sticky note')
  if (notes && notes === shapes.length) return plural(notes, 'sticky note')
  return plural(shapes.length, 'selected item')
}

/** The current selection as a target (null when nothing is selected). */
export function selectionTarget(editor: Editor): AiTarget | null {
  const shapes = editor.getSelectedShapes()
  if (!shapes.length) return null
  const { notes, texts } = count(editor, shapes)
  return {
    kind: 'selection',
    ids: shapes.slice(0, AI_MAX_REQUEST_SHAPES).map((s) => s.id),
    label: describe(shapes, notes),
    notes,
    texts,
    bounds: editor.getSelectionPageBounds(),
  }
}

function frameTarget(editor: Editor, frame: TLShape): AiTarget {
  const { notes, texts } = count(editor, [frame])
  return {
    kind: 'frame',
    ids: [frame.id],
    label: describe([frame], notes),
    notes,
    texts,
    bounds: editor.getShapePageBounds(frame) ?? null,
  }
}

/** The innermost frame on the current page containing `point` (page space). */
export function frameAt(editor: Editor, point: VecLike): TLShape | null {
  const frames = editor
    .getCurrentPageShapesSorted()
    .filter((s) => s.type === 'frame')
    .filter((f) => editor.getShapePageBounds(f)?.containsPoint(point))
  // Sorted back to front: the last is the frontmost (a nested frame is drawn above its parent).
  return frames.at(-1) ?? null
}

const NONE: AiTarget = { kind: 'none', ids: [], label: 'nothing selected', notes: 0, texts: 0, bounds: null }

/** The selection, else the frame at `point`, else nothing. */
export function targetAt(editor: Editor, point: VecLike | null): AiTarget {
  const sel = selectionTarget(editor)
  if (sel) return sel
  const frame = point ? frameAt(editor, point) : null
  return frame ? frameTarget(editor, frame) : NONE
}

/** The selection, else the frame in the middle of the view, else nothing. */
export function viewTarget(editor: Editor): AiTarget {
  return targetAt(editor, editor.getViewportPageBounds().center)
}
