// Internal: read-only index over a set of records (shapes by id, pages, parent chains, page transforms).
// Every accessor tolerates malformed data (missing parents, parent cycles, non-finite numbers).
import type { TLPage, TLPageId, TLRecord, TLShape } from '@tldraw/tlschema'
import { getIndexAbove, type IndexKey } from '@tldraw/utils'

/** Parent chains longer than this are treated as broken (real boards nest a handful of levels). */
const MAX_PARENT_DEPTH = 256

export interface PageTransform {
  x: number
  y: number
  rotation: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `validateIndexKey` is `@internal` in @tldraw/utils 5.4.2; index generation validates its lower bound, so use that. */
export function isValidIndexKey(key: unknown): key is IndexKey {
  if (typeof key !== 'string' || key.length === 0 || key.length > 256) return false
  try {
    getIndexAbove(key as IndexKey)
    return true
  } catch {
    return false
  }
}

export function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function propsOf(shape: TLShape): Record<string, unknown> {
  return isRecordObject(shape.props) ? (shape.props as Record<string, unknown>) : {}
}

export function stringProp(shape: TLShape, key: string): string {
  const value = propsOf(shape)[key]
  return typeof value === 'string' ? value : ''
}

export class BoardIndex {
  readonly shapes = new Map<string, TLShape>()
  readonly pages = new Map<string, TLPage>()
  /** Page ids in first-seen order (page records and page parents of shapes). */
  readonly pageOrder: string[] = []
  private readonly pageCache = new Map<string, TLPageId | null>()
  private readonly transformCache = new Map<string, PageTransform | null>()

  constructor(records: Iterable<TLRecord>) {
    const seenPages = new Set<string>()
    for (const record of records) {
      if (!isRecordObject(record) || typeof record.id !== 'string') continue
      if (record.typeName === 'shape') {
        if (!this.shapes.has(record.id)) this.shapes.set(record.id, record as TLShape)
      } else if (record.typeName === 'page') {
        if (!this.pages.has(record.id)) this.pages.set(record.id, record as TLPage)
        if (!seenPages.has(record.id)) {
          seenPages.add(record.id)
          this.pageOrder.push(record.id)
        }
      }
    }
    for (const shape of this.shapes.values()) {
      const parent = shape.parentId
      if (typeof parent === 'string' && parent.startsWith('page:') && !seenPages.has(parent)) {
        seenPages.add(parent)
        this.pageOrder.push(parent)
      }
    }
    // Pages with records sort by their fractional index; pages known only from parentIds keep first-seen order after them.
    this.pageOrder.sort((a, b) => {
      const ia = this.pages.get(a)?.index
      const ib = this.pages.get(b)?.index
      if (typeof ia === 'string' && typeof ib === 'string') return ia < ib ? -1 : ia > ib ? 1 : 0
      if (typeof ia === 'string') return -1
      if (typeof ib === 'string') return 1
      return 0
    })
  }

  /**
   * The shape followed by its ancestors, nearest first, stopping at the page. Returns `null` when the
   * chain is broken (missing parent shape), cyclic, or implausibly deep.
   */
  chain(id: string): { shapes: TLShape[]; pageId: TLPageId } | null {
    const shapes: TLShape[] = []
    const seen = new Set<string>()
    let current = this.shapes.get(id)
    while (current) {
      if (seen.has(current.id) || shapes.length >= MAX_PARENT_DEPTH) return null
      seen.add(current.id)
      shapes.push(current)
      const parent = current.parentId
      if (typeof parent !== 'string') return null
      if (parent.startsWith('page:')) return { shapes, pageId: parent as TLPageId }
      current = this.shapes.get(parent)
    }
    return null
  }

  /** The page a shape lives on, or `null` for orphans (a missing parent) and parent cycles. */
  pageOf(id: string): TLPageId | null {
    const cached = this.pageCache.get(id)
    if (cached !== undefined) return cached
    const pageId = this.chain(id)?.pageId ?? null
    this.pageCache.set(id, pageId)
    return pageId
  }

  /** Page-space position and rotation of the shape's origin, composing every ancestor transform. */
  pageTransform(id: string): PageTransform | null {
    const cached = this.transformCache.get(id)
    if (cached !== undefined) return cached
    const chain = this.chain(id)
    if (!chain) {
      this.transformCache.set(id, null)
      return null
    }
    let acc: PageTransform = { x: 0, y: 0, rotation: 0 }
    for (let i = chain.shapes.length - 1; i >= 0; i--) {
      const shape = chain.shapes[i] as TLShape
      const known = this.transformCache.get(shape.id)
      if (known) {
        acc = known
        continue
      }
      const lx = finiteOr(shape.x, 0)
      const ly = finiteOr(shape.y, 0)
      const cos = Math.cos(acc.rotation)
      const sin = Math.sin(acc.rotation)
      acc = {
        x: acc.x + lx * cos - ly * sin,
        y: acc.y + lx * sin + ly * cos,
        rotation: acc.rotation + finiteOr(shape.rotation, 0),
      }
      this.transformCache.set(shape.id, acc)
    }
    return acc
  }

  /** Nearest ancestor frame (not the shape itself), skipping groups and other containers. */
  parentFrame(id: string): TLShape | null {
    const chain = this.chain(id)
    if (!chain) return null
    for (let i = 1; i < chain.shapes.length; i++) {
      const ancestor = chain.shapes[i] as TLShape
      if (ancestor.type === 'frame') return ancestor
    }
    return null
  }

  /** Number of frame ancestors. */
  frameDepth(id: string): number {
    const chain = this.chain(id)
    if (!chain) return 0
    let depth = 0
    for (let i = 1; i < chain.shapes.length; i++) if ((chain.shapes[i] as TLShape).type === 'frame') depth++
    return depth
  }

  pageRank(pageId: string): number {
    const rank = this.pageOrder.indexOf(pageId)
    return rank === -1 ? Number.MAX_SAFE_INTEGER : rank
  }
}

/** Approximate local size of a shape (exact for frames, geo, images, file cards and notes; 0 when unknown). */
export function localSize(shape: TLShape): { w: number; h: number } {
  const props = propsOf(shape)
  if (shape.type === 'note') {
    const scale = finiteOr(props.scale, 1)
    return { w: 200 * scale, h: (200 + Math.max(0, finiteOr(props.growY, 0))) * scale }
  }
  const w = Math.max(0, finiteOr(props.w, 0))
  const h =
    Math.max(0, finiteOr(props.h, 0)) + (shape.type === 'geo' ? Math.max(0, finiteOr(props.growY, 0)) : 0)
  return { w, h }
}

const TWO_PI = Math.PI * 2

/** True when the angle is a whole number of turns (within float noise). */
export function isUnrotated(rotation: number): boolean {
  const r = ((rotation % TWO_PI) + TWO_PI) % TWO_PI
  return r < 1e-9 || TWO_PI - r < 1e-9
}

/**
 * Page-space axis-aligned bounds of a local `w × h` box under `t`. Exact when unrotated; for rotated
 * shapes this is the bounding box of the rotated rectangle (not the rectangle itself).
 */
export function pageBounds(t: PageTransform, w: number, h: number): Box {
  if (isUnrotated(t.rotation)) return { x: t.x, y: t.y, w, h }
  const cos = Math.cos(t.rotation)
  const sin = Math.sin(t.rotation)
  const xs = [0, w * cos, w * cos - h * sin, -h * sin]
  const ys = [0, w * sin, w * sin + h * cos, h * cos]
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: t.x + minX, y: t.y + minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY }
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
