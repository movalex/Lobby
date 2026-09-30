// COL-05 bulk paste on the new canvas: a `text` content handler (paste and drop; docs/EXCALIDRAW-
// CONTRACTS.md §3 `contentHandlers`). One cell (a word, a sentence) is left to the engine's own paste (a
// text element); multi-line, TSV or CSV text opens "Paste as sticky notes or as text?" at the pointer.
//
// RETRO-01: the paste point is the pointer over the canvas, else the view's centre. The grid goes to the
// nearest empty spot there, into the frame under that point when it fits (bulk-paste.ts placeBulkGrid).
// The grid is board-ops' element layout (noteElementsFromText: the same parser and grid as the tldraw
// paste); each note is made with `tx.create('note')` in one step (CR-2D-2 will let the prepared notes be
// inserted as they are, with the pasted-note face).
import { DEFAULT_MAX_NOTES, noteElementsFromText, parseBulkText } from '@draftroom/board-ops/elements'
import { MAX_ITEMS } from '@draftroom/canvas-schema/limits'
import { useEffect, useId, useRef } from 'react'
import {
  type CanvasElement,
  type CanvasFeatureContext,
  type ContentHandlerSpec,
  items,
  type ScenePoint,
} from '../../../../canvas/api/index.ts'
import { useValue } from '../../../../lib/signals.ts'
import { placeBulkGrid, reflowLine, truncationMessage } from '../../bulk-paste.ts'
import { containingFrame, type Rect, rectContains, unionRects } from '../../placement.ts'
import { frameAt } from './model.ts'
import { pendingPaste } from './state.ts'

let pasteSeq = 0

/** Cells of a paste (null when it is not a bulk paste: one cell or less). */
export function analyzeBulkPaste(text: string): { cells: number; rows: number } | null {
  if (typeof text !== 'string' || !text.trim()) return null
  const rows = parseBulkText(text)
  const cells = rows.reduce((n, r) => n + r.length, 0)
  return cells >= 2 ? { cells, rows: rows.length } : null
}

export const BULK_PASTE_HANDLER: ContentHandlerSpec = {
  id: 'navigation.bulk-paste',
  kinds: ['text'],
  priority: 50,
  handle(content, ctx, at, source) {
    if (content.kind !== 'text' || source === 'insert' || ctx.canvas.readOnly()) return false
    const analysis = analyzeBulkPaste(content.text)
    if (!analysis) return false
    const v = ctx.canvas.viewport.get()
    const center = at ?? { x: v.x + v.width / 2, y: v.y + v.height / 2 }
    pendingPaste(ctx.canvas).set({ id: ++pasteSeq, text: content.text, cells: analysis.cells, center })
    return true
  },
}

const NOTE = 200
const boundsOf = (ctx: CanvasFeatureContext, id: string): Rect | null => {
  const b = ctx.canvas.bounds(id)
  return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null
}

/** The grid of a paste at the origin: each note's top-left and words (board-ops' layout, RETRO-01 reflow). */
export function pasteGrid(text: string): {
  cells: { text: string; x: number; y: number }[]
  truncated: boolean
} {
  const { elements, noteIds, truncated } = noteElementsFromText(text, {
    origin: { x: 0, y: 0 },
    maxNotes: DEFAULT_MAX_NOTES,
  })
  const byId = new Map(elements.map((e) => [e.id, e as unknown as CanvasElement]))
  const cells = noteIds.map((id) => {
    const note = byId.get(id) as CanvasElement
    return { text: items.textOf(note, (x) => byId.get(x)), x: note.x, y: note.y }
  })
  const reflowed = reflowLine(cells)
  return {
    cells: reflowed ? cells.map((c, i) => ({ ...c, ...(reflowed[i] as { x: number; y: number }) })) : cells,
    truncated,
  }
}

/**
 * "Paste as sticky notes": one note per non-empty cell (a long single column or row as a compact grid),
 * centred on the paste point and moved to the nearest empty spot, inside the frame under the paste point
 * when it fits there; all selected, one undo step. Returns the new note ids.
 */
export function pasteAsNotes(ctx: CanvasFeatureContext, text: string, center: ScenePoint): string[] {
  const { canvas } = ctx
  const { cells, truncated } = pasteGrid(text)
  if (!cells.length) return []
  const content = items.contentItems(canvas.items())
  if (content.length + cells.length > MAX_ITEMS) {
    ctx.notify({
      key: 'bulk-paste',
      text: 'This board has too many objects to paste that many notes.',
      tone: 'error',
      testId: 'bulk-paste-notice',
    })
    return []
  }
  const grid = unionRects(cells.map((c) => ({ x: c.x, y: c.y, w: NOTE, h: NOTE }))) ?? {
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  }
  // obstacles: the target frame's children, or the board's top-level items (frames included)
  const target = frameAt(canvas, center)
  const targetBounds = target ? boundsOf(ctx, target.id) : null
  const rectsOf = (list: readonly CanvasElement[]) => list.flatMap((e) => boundsOf(ctx, e.id) ?? [])
  const placement = placeBulkGrid({
    size: { w: grid.w, h: grid.h },
    center,
    frame: targetBounds,
    frameObstacles: target ? rectsOf(content.filter((e) => e.frameId === target.id)) : [],
    pageObstacles: rectsOf(content.filter((e) => !e.frameId)),
  })
  const dx = placement.topLeft.x - grid.x
  const dy = placement.topLeft.y - grid.y
  const bounds = { ...grid, x: grid.x + dx, y: grid.y + dy }
  // into the frame under the paste point when the grid is inside it; else whichever unlocked frame holds it
  let frameId: string | null = null
  if (target && targetBounds && placement.inFrame && rectContains(targetBounds, bounds)) frameId = target.id
  else {
    const frames = content
      .filter((e) => e.type === 'frame' && !e.locked)
      .flatMap((e) => {
        const b = boundsOf(ctx, e.id)
        return b ? [{ id: e.id, bounds: b }] : []
      })
    frameId = containingFrame(bounds, frames)?.id ?? null
  }
  const ids = canvas.transact('paste as notes', (tx) => {
    const made = cells.map((c) => tx.create('note', { x: c.x + dx, y: c.y + dy, text: c.text, size: NOTE }))
    if (frameId) tx.setFrame(made, frameId)
    return made
  })
  canvas.select(ids)
  // keep the whole grid in view (zooming out only, never in)
  const v = canvas.viewport.get()
  const view = { x: v.x, y: v.y, w: v.width, h: v.height }
  if (!rectContains(view, bounds)) {
    canvas.viewport.zoomTo(
      { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h },
      { maxZoom: v.zoom, animate: { durationMs: 220 } },
    )
  }
  const omitted = Math.max(0, (analyzeBulkPaste(text)?.cells ?? cells.length) - cells.length)
  const msg = truncationMessage(cells.length, omitted, truncated && omitted === 0, DEFAULT_MAX_NOTES)
  if (msg) ctx.notify({ key: 'bulk-paste', text: msg, timeoutMs: 10_000, testId: 'bulk-paste-notice' })
  return ids
}

/** "Paste as text": the whole paste as one text element at the paste point, one undo step. */
export function pasteAsText(ctx: CanvasFeatureContext, text: string, center: ScenePoint): string {
  const id = ctx.canvas.transact('paste as text', (tx) =>
    tx.create('text', { x: center.x, y: center.y, text }),
  )
  ctx.canvas.select([id])
  return id
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max)

/** "Paste N items as sticky notes or as text?" at the paste point (a screen overlay layer). */
export function BulkPastePrompt({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const pending = useValue('nav-pending-paste', () => pendingPaste(canvas).get(), [canvas])
  const pos = useValue('nav-paste-pos', () => {
    const p = pendingPaste(canvas).get()
    if (!p) return null
    const at = canvas.sceneToOverlay(p.center)
    const v = canvas.viewport.get()
    const w = v.width * v.zoom
    const h = v.height * v.zoom
    return { x: clamp(at.x, 170, Math.max(170, w - 170)), y: clamp(at.y, 70, Math.max(70, h - 90)) }
  }, [canvas])
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  // working on the canvas instead of answering dismisses the prompt (nothing is pasted)
  useEffect(
    () =>
      canvas.on('input', (e) => {
        if (e.type === 'pointer-down' && pendingPaste(canvas).get()) pendingPaste(canvas).set(null)
      }),
    [canvas],
  )
  useEffect(() => () => pendingPaste(canvas).set(null), [canvas])
  if (!pending || !pos) return null
  const finish = () => {
    pendingPaste(canvas).set(null)
    canvas.focus({ preventScroll: true })
  }
  const notes = Math.min(pending.cells, DEFAULT_MAX_NOTES)
  return (
    <div
      // a new paste replaces the prompt: remount so the Notes button takes focus again
      key={pending.id}
      ref={ref}
      className="dr-cux-paste"
      role="dialog"
      aria-labelledby={titleId}
      data-testid="bulk-paste-prompt"
      style={{ left: pos.x, top: pos.y, pointerEvents: 'auto' }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        finish()
      }}
    >
      <p id={titleId} className="dr-cux-paste__title">
        Paste {pending.cells} {pending.cells === 1 ? 'item' : 'items'} as sticky notes or as text?
      </p>
      {pending.cells > DEFAULT_MAX_NOTES && (
        <p className="dr-cux-muted">Only the first {DEFAULT_MAX_NOTES} become notes.</p>
      )}
      <div className="dr-cux-paste__actions">
        <button
          type="button"
          className="dr-btn dr-btn--primary dr-btn--sm"
          data-testid="bulk-paste-notes"
          // biome-ignore lint/a11y/noAutofocus: the prompt exists to take this one decision
          autoFocus
          onClick={() => {
            const p = pendingPaste(canvas).get()
            pendingPaste(canvas).set(null)
            if (p) pasteAsNotes(ctx, p.text, p.center)
            canvas.focus({ preventScroll: true })
          }}
        >
          {notes} sticky {notes === 1 ? 'note' : 'notes'}
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="bulk-paste-text"
          onClick={() => {
            const p = pendingPaste(canvas).get()
            pendingPaste(canvas).set(null)
            if (p) pasteAsText(ctx, p.text, p.center)
            canvas.focus({ preventScroll: true })
          }}
        >
          Text
        </button>
        <button
          type="button"
          className="dr-iconbtn dr-iconbtn--sm"
          data-testid="bulk-paste-cancel"
          aria-label="Cancel paste"
          onClick={finish}
        >
          ×
        </button>
      </div>
    </div>
  )
}
