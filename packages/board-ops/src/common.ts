// Engine-neutral helpers shared by the tldraw readers (./board-index.ts and friends) and the Excalidraw
// element readers (./elements/**): no tldraw and no Excalidraw import, so both builds (and the servers) can
// use them. Moved here unchanged from board-index.ts for the Excalidraw migration
// (docs/EXCALIDRAW-MIGRATION.md §4.9, wave 2D).

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Minimum vertical jitter (page units) tolerated between items that share a reading-order row. */
export const DEFAULT_ROW_TOLERANCE = 24

/**
 * Reading order: items are grouped into rows by their top edge (an item joins the current row when its
 * top is within `tolerance` of the row's topmost item), rows go top to bottom and each row left to right.
 * Default tolerance: max(24, 25% of the smaller of the two heights). Ties break by id for determinism.
 */
export function readingOrder<T extends { id: string; bounds: Box }>(
  items: readonly T[],
  tolerance?: number,
): T[] {
  const byId = (a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const sorted = [...items].sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x || byId(a, b))
  const rows: T[][] = []
  for (const item of sorted) {
    const row = rows.at(-1)
    const first = row?.[0]
    if (row && first) {
      const tol =
        tolerance !== undefined && Number.isFinite(tolerance) && tolerance >= 0
          ? tolerance
          : Math.max(DEFAULT_ROW_TOLERANCE, 0.25 * Math.min(first.bounds.h, item.bounds.h))
      if (item.bounds.y - first.bounds.y <= tol) {
        row.push(item)
        continue
      }
    }
    rows.push([item])
  }
  return rows.flatMap((row) =>
    row.sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y || byId(a, b)),
  )
}

/** `text.slice(0, max)` that never ends on the high half of a surrogate pair (no lone surrogates). */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}
