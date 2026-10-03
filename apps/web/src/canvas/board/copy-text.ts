/**
 * What a read-only role takes with Ctrl/Cmd+C (CR-3A-4): the words of the selection, as plain text.
 * Excalidraw's own copy is off for them (its `onCopy` returns on a non-interactive canvas), and Lobby does
 * not hand a viewer the engine's clipboard format (the elements themselves, ready to paste into another
 * board): the case this serves is a reviewer copying a note's text into an email.
 *
 * A note or shape gives its label, a text its words, a frame its name and, selected as a frame, the words
 * of what is inside it. A selected label counts as its container. Hidden items (a collapsed mind-map
 * branch) and deleted ones give nothing. The pieces come top to bottom, then left to right, one per line;
 * notes whose tops are within half the median item height of each other are one visual row (two notes
 * dropped a few pixels apart read left to right, not by whichever is a pixel higher).
 *
 * Pure (Node-tested); the session passes the LobbyCanvas.
 */
import type { LobbyCanvas } from '../api/lobby-canvas.ts'
import type { CanvasElement } from '../port.ts'

/** The canvas members the copy reads. */
export type CopyCanvas = Pick<LobbyCanvas, 'selection' | 'get' | 'items' | 'isHidden'> & {
  readonly text: Pick<LobbyCanvas['text'], 'of'>
}

/** A copy never puts more than this many characters on the clipboard. */
export const MAX_COPY_CHARS = 200_000

/** How far apart (as a share of the median item height) two tops may be and still be one row. */
const ROW_TOLERANCE = 0.5

/**
 * Top to bottom in rows, left to right inside a row. A row starts at its topmost item; an item whose top is
 * within ROW_TOLERANCE x the median height of that one joins it (not chained: a column of staggered notes
 * does not become one row). Items without a height (none selected has one) fall back to exact tops.
 */
export function readingOrder(els: readonly CanvasElement[]): CanvasElement[] {
  const heights = els.map((e) => e.height).filter((h) => Number.isFinite(h) && h > 0)
  heights.sort((a, b) => a - b)
  const mid = heights.length >> 1
  const median =
    heights.length % 2 ? (heights[mid] ?? 0) : ((heights[mid - 1] ?? 0) + (heights[mid] ?? 0)) / 2
  const tolerance = median * ROW_TOLERANCE
  const byTop = [...els].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
  const out: CanvasElement[] = []
  let row: CanvasElement[] = []
  let rowTop = 0
  const flush = () => {
    row.sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id))
    out.push(...row)
    row = []
  }
  for (const el of byTop) {
    if (row.length && el.y - rowTop > tolerance) flush()
    if (!row.length) rowTop = el.y
    row.push(el)
  }
  flush()
  return out
}

export function selectionText(canvas: CopyCanvas): string {
  const picked = new Map<string, CanvasElement>()
  const take = (el: CanvasElement | undefined | null) => {
    if (!el || el.isDeleted || picked.has(el.id) || canvas.isHidden(el.id)) return
    picked.set(el.id, el)
  }
  let all: readonly CanvasElement[] | null = null
  for (const id of canvas.selection) {
    const el = canvas.get(id)
    if (!el || el.isDeleted) continue
    // a selected label is its container's words
    take(el.type === 'text' && el.containerId ? (canvas.get(el.containerId) ?? el) : el)
    if (el.type === 'frame') {
      all ??= canvas.items()
      for (const c of all) if (c.frameId === el.id && !(c.type === 'text' && c.containerId)) take(c)
    }
  }
  const parts: string[] = []
  for (const el of readingOrder([...picked.values()])) {
    const text = canvas.text.of(el.id).trim()
    if (text) parts.push(text)
  }
  return parts.join('\n').slice(0, MAX_COPY_CHARS)
}
