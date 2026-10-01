// Helpers shared by the template tests (not exported from the package).

import type {
  TLArrowBinding,
  TLArrowShape,
  TLFrameShape,
  TLPageId,
  TLRecord,
  TLShape,
} from '@tldraw/tlschema'
import { estimateShapeRect, plainTextOfRichText, type Rect } from './layout.ts'

export const PAGE = 'page:templates-test' as TLPageId

export function shapesOf(records: readonly TLRecord[]): TLShape[] {
  return records.filter((r): r is TLShape => r.typeName === 'shape')
}

export function bindingsOf(records: readonly TLRecord[]): TLArrowBinding[] {
  return records.filter((r): r is TLArrowBinding => r.typeName === 'binding')
}

export function framesOf(records: readonly TLRecord[]): TLFrameShape[] {
  return shapesOf(records).filter((s): s is TLFrameShape => s.type === 'frame')
}

export function arrowsOf(records: readonly TLRecord[]): TLArrowShape[] {
  return shapesOf(records).filter((s): s is TLArrowShape => s.type === 'arrow')
}

export function byId(records: readonly TLRecord[]): Map<string, TLShape> {
  return new Map(shapesOf(records).map((s) => [s.id, s]))
}

export function childrenOf(records: readonly TLRecord[], parentId: string): TLShape[] {
  return shapesOf(records)
    .filter((s) => s.parentId === parentId)
    .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0))
}

/** Visible text of a shape: rich text for text-bearing shapes, the name for frames. */
export function textOf(shape: TLShape): string {
  if (shape.type === 'frame') return shape.props.name
  const props = shape.props as { richText?: unknown }
  return plainTextOfRichText(props.richText).trim()
}

/** Page-space estimated bounds (template frames are never rotated). */
export function pageRect(shape: TLShape, shapes: Map<string, TLShape>): Rect {
  const local = estimateShapeRect(shape)
  let x = local.x
  let y = local.y
  let parentId: string = shape.parentId
  for (let depth = 0; depth < 64 && parentId.startsWith('shape:'); depth++) {
    const parent = shapes.get(parentId)
    if (!parent) throw new Error(`missing parent ${parentId}`)
    x += parent.x
    y += parent.y
    parentId = parent.parentId
  }
  return { x, y, w: local.w, h: local.h }
}

export function arrowEndpoints(
  arrow: TLArrowShape,
  shapes: Map<string, TLShape>,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const origin = pageRect(
    { ...arrow, props: { ...arrow.props, start: { x: 0, y: 0 }, end: { x: 0, y: 0 } } },
    shapes,
  )
  return {
    start: { x: origin.x + arrow.props.start.x, y: origin.y + arrow.props.start.y },
    end: { x: origin.x + arrow.props.end.x, y: origin.y + arrow.props.end.y },
  }
}

/** True when the interiors of two rects intersect (touching edges do not count). */
export function rectsOverlap(a: Rect, b: Rect, tolerance = 0.5): boolean {
  return (
    a.x + a.w - tolerance > b.x &&
    b.x + b.w - tolerance > a.x &&
    a.y + a.h - tolerance > b.y &&
    b.y + b.h - tolerance > a.y
  )
}

/** Gap between two non-overlapping rects (0 if they overlap or touch). */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w))
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h))
  return Math.max(dx, dy)
}

export function rectContains(outer: Rect, inner: Rect, tolerance = 0.5): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.w <= outer.x + outer.w + tolerance &&
    inner.y + inner.h <= outer.y + outer.h + tolerance
  )
}

/** Liang-Barsky: does the segment p->q pass through the rect's interior (shrunk by `inset`)? */
export function segmentCrossesRect(
  p: { x: number; y: number },
  q: { x: number; y: number },
  rect: Rect,
  inset = 1,
): boolean {
  const r = { x: rect.x + inset, y: rect.y + inset, w: rect.w - inset * 2, h: rect.h - inset * 2 }
  if (r.w <= 0 || r.h <= 0) return false
  const dx = q.x - p.x
  const dy = q.y - p.y
  let t0 = 0
  let t1 = 1
  const clips: Array<[number, number]> = [
    [-dx, p.x - r.x],
    [dx, r.x + r.w - p.x],
    [-dy, p.y - r.y],
    [dy, r.y + r.h - p.y],
  ]
  for (const [pk, qk] of clips) {
    if (pk === 0) {
      if (qk < 0) return false
      continue
    }
    const t = qk / pk
    if (pk < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return false
  }
  return true
}

/** Distance from a point to the boundary of a rect. */
export function distanceToRectBoundary(pt: { x: number; y: number }, r: Rect): number {
  const inside = pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h
  if (inside) return Math.min(pt.x - r.x, r.x + r.w - pt.x, pt.y - r.y, r.y + r.h - pt.y)
  const dx = Math.max(r.x - pt.x, 0, pt.x - (r.x + r.w))
  const dy = Math.max(r.y - pt.y, 0, pt.y - (r.y + r.h))
  return Math.hypot(dx, dy)
}

/**
 * Reference reading order per docs/FEATURES-CONTRACTS.md frameOutline: rows by top edge
 * (with tolerance), then left to right; nested frames follow their parent.
 */
export function readingOrder(
  records: readonly TLRecord[],
  pageId: TLPageId,
  rowTolerance = 24,
): TLFrameShape[] {
  const shapes = byId(records)
  const frames = framesOf(records)
  const order = (parentId: string): TLFrameShape[] => {
    const level = frames
      .filter((f) => f.parentId === parentId)
      .map((f) => ({ f, r: pageRect(f, shapes) }))
      .sort((a, b) => a.r.y - b.r.y || a.r.x - b.r.x)
    const rows: Array<Array<{ f: TLFrameShape; r: Rect }>> = []
    for (const item of level) {
      const row = rows[rows.length - 1]
      const head = row?.[0]
      if (row && head && Math.abs(item.r.y - head.r.y) <= rowTolerance) row.push(item)
      else rows.push([item])
    }
    return rows.flatMap((row) => row.sort((a, b) => a.r.x - b.r.x).flatMap(({ f }) => [f, ...order(f.id)]))
  }
  return order(pageId)
}

/**
 * The keyboard's reading order over boxes: tldraw 5.4.2's `Editor._getShapesInReadingOrder` (Tab, Ctrl+Arrow,
 * Ctrl+Shift+Down into a frame), which the new canvas's traversal copies with the same constants
 * (apps/web/src/features/a11y/ported/reading-order.ts `inReadingOrder`): centres sorted top to bottom, rows of
 * centres within 100 px of the row's last one, each row left to right (a stable sort), then a nearer entry
 * two places on at a shallow angle swaps forward.
 */
export function keyboardReadingOrder<T extends { readonly rect: Rect }>(entries: readonly T[]): T[] {
  if (entries.length <= 1) return [...entries]
  const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
  const items = entries.map((entry) => ({ entry, c: centre(entry.rect) }))
  items.sort((a, b) => a.c.y - b.c.y)
  const rows: (typeof items)[] = []
  for (const it of items) {
    let row = -1
    for (let i = rows.length - 1; i >= 0; i--) {
      const last = rows[i]?.[(rows[i]?.length ?? 1) - 1]
      if (last && Math.abs(it.c.y - last.c.y) < 100) {
        row = i
        break
      }
    }
    if (row === -1) rows.push([it])
    else rows[row]?.push(it)
  }
  for (const row of rows) row.sort((a, b) => a.c.x - b.c.x)
  const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
  for (const row of rows) {
    for (let i = 0; i + 2 < row.length; i++) {
      const [cur, next, after] = [row[i], row[i + 1], row[i + 2]]
      if (!cur || !next || !after) continue
      if (d2(cur.c, after.c) < d2(cur.c, next.c) * 0.9) {
        const angle = Math.abs((Math.atan2(after.c.y - cur.c.y, after.c.x - cur.c.x) * 180) / Math.PI)
        if (angle <= 20) {
          row[i + 1] = after
          row[i + 2] = next
        }
      }
    }
  }
  return rows.flat().map((it) => it.entry)
}

export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`)
  return value
}

/** Calls `visit` for every string value inside `value` (keys included). */
export function walkStrings(value: unknown, visit: (s: string) => void, depth = 0): void {
  if (depth > 64) throw new Error('too deep')
  if (typeof value === 'string') visit(value)
  else if (Array.isArray(value)) for (const v of value) walkStrings(v, visit, depth + 1)
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      visit(k)
      walkStrings(v, visit, depth + 1)
    }
  }
}

/** Collects every nested object/array reference (to detect shared mutable structure). */
export function collectObjects(value: unknown, into: Set<object>, dupes: object[], depth = 0): void {
  if (depth > 64 || value === null || typeof value !== 'object') return
  if (into.has(value)) {
    dupes.push(value)
    return
  }
  into.add(value)
  for (const v of Object.values(value)) collectObjects(v, into, dupes, depth + 1)
}
