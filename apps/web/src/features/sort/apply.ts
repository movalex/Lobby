// L8-1 and L8-2: writes a sort plan to the board. Everything inside ONE `canvas.transact`, so Ctrl+Z takes the
// whole sort back in one step (the positions and the headings together) and collaborators receive it through
// the board's sync like any edit. The client writes the notes' `x` and `y` (and their bound labels', which the
// engine does not move with them), the new headings, and a frame's size when it had to grow. It never writes
// an arrow: the server re-snaps every connector bound to a note that moved, in the same commit.
import { LOBBY_INK, newElementId } from '@draftroom/board-ops/elements'
import { type CanvasElement, items, type LobbyCanvas } from '../../canvas/api/index.ts'
import { LABEL_FONT_FAMILY, LABEL_FONT_SIZE, unionRects } from './geom.ts'
import type { ColumnsPlan } from './plan.ts'

export interface ApplyOptions {
  /** the undo step's name */
  readonly label: string
  /** the `customData` of the headings a sort makes (kind 'sort-label', or an AI run's provenance) */
  customData(): Record<string, unknown>
}

export interface Applied {
  /** notes that moved */
  readonly moved: number
  readonly headings: number
  readonly grew: boolean
  /** every element the step wrote */
  readonly written: readonly string[]
}

/** Moves a note and its bound label by (dx, dy): the engine keeps a label's own x, y. */
function moveNote(
  canvas: LobbyCanvas,
  tx: { update(id: string, p: Record<string, unknown>): void },
  id: string,
  to: { x: number; y: number },
  labelId: string | null,
) {
  const el = canvas.get(id)
  if (!el) return false
  const dx = to.x - el.x
  const dy = to.y - el.y
  if (!dx && !dy) return false
  tx.update(id, { x: to.x, y: to.y })
  const label = labelId ? canvas.get(labelId) : items.labelOf(el, (x) => canvas.get(x))
  if (label) tx.update(label.id, { x: label.x + dx, y: label.y + dy })
  return true
}

/** Writes `plan` as one undo step. */
export function applyColumns(canvas: LobbyCanvas, plan: ColumnsPlan, opts: ApplyOptions): Applied {
  const written: string[] = []
  let moved = 0
  let headings = 0
  let grew = false
  canvas.transact(opts.label, (tx) => {
    for (const space of plan.spaces) {
      for (const id of space.stale) {
        tx.delete(id)
        written.push(id)
      }
      for (const l of space.labels) {
        const id = tx.create('text', {
          id: newElementId(),
          x: l.x,
          y: l.y,
          text: l.block.text,
          originalText: l.name,
          fontFamily: LABEL_FONT_FAMILY,
          fontSize: LABEL_FONT_SIZE,
          textAlign: 'left',
          verticalAlign: 'top',
          strokeColor: LOBBY_INK,
          frameId: space.frameId,
          // wrapped at the column's width: it keeps its lines when someone edits it
          autoResize: l.block.text === l.name,
          customData: opts.customData(),
        })
        written.push(id)
        headings++
      }
      for (const m of space.moves) {
        if (moveNote(canvas, tx, m.id, m, m.labelId)) {
          written.push(m.id)
          moved++
        }
      }
      if (space.grow) {
        tx.update(space.grow.id, { width: space.grow.width, height: space.grow.height })
        written.push(space.grow.id)
        grew = true
      }
    }
  })
  return { moved, headings, grew, written }
}

/** The scene box of everything a plan puts or moves (what to bring into view). */
export function planBounds(
  canvas: LobbyCanvas,
  plan: ColumnsPlan,
): { x: number; y: number; width: number; height: number } | null {
  const rects = plan.spaces.flatMap((s) => [
    ...s.labels.map((l) => ({ x: l.x, y: l.y, w: l.width, h: l.block.height })),
    ...s.moves.map((m) => {
      const el: CanvasElement | undefined = canvas.get(m.id)
      return { x: m.x, y: m.y, w: el?.width ?? 0, h: el?.height ?? 0 }
    }),
  ])
  const u = unionRects(rects)
  return u ? { x: u.x, y: u.y, width: u.w, height: u.h } : null
}

/** Brings `bounds` into view when it is not wholly on screen. The camera is not the board: a failure is not an error. */
export function bringIntoView(
  canvas: LobbyCanvas,
  bounds: { x: number; y: number; width: number; height: number } | null,
) {
  if (!bounds) return
  try {
    canvas.viewport.ensureVisible(bounds, { animate: true })
  } catch (e) {
    console.warn('sort: could not bring the result into view', e)
  }
}
