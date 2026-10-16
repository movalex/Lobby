// Board deep links (docs/EXCALIDRAW-MIGRATION.md §3.6, contracts C2): "Copy link" to a selection or a
// frame, the dashboard's "Inside boards" results, and the legacy links the tldraw board wrote.
//
//   ?el=<id>,<id>          elements (the new canvas: `,` never appears in an element id)
//   ?view=<x>,<y>,<w>,<h>  a scene rectangle
//   ?d=s<id>.<id>          legacy (tldraw's createDeepLinkString): shapes, ids URI-encoded with `.` as %2E
//   ?d=v<x>.<y>.<w>.<h>[.<pageId>], ?d=p<pageId>   legacy viewport and page links
//
// Legacy shape ids map straight to element ids (a converted element keeps its tldraw id without
// `shape:`, or `lb_doc.import.legacyIds` names the id the converter gave it); a `.`-joined list is split
// against the live ids, longest match first, so a hand-made link with dotted ids still resolves. Legacy
// viewport links move with their page's frozen offset (`lb_doc.import.legacyPages`). Pure: no DOM, no
// engine, no tldraw (the dashboard builds links with it too).
import { ELEMENT_ID_PATTERN } from '@draftroom/canvas-schema/limits'
import { REVIEW_VIEW_VALUE } from '@draftroom/contracts'

export const ELEMENTS_PARAM = 'el'
export const VIEW_PARAM = 'view'
/** tldraw's deep-link parameter (Editor.createDeepLink's default), read on the new canvas, never written. */
export const LEGACY_PARAM = 'd'
export const DEEP_LINK_PARAMS: readonly string[] = [ELEMENTS_PARAM, VIEW_PARAM, LEGACY_PARAM]

/** At most this many ids are read from one link (a selection of a whole board stays a usable URL). */
export const MAX_LINK_IDS = 500

export interface LinkRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export type DeepLink =
  | { readonly kind: 'elements'; readonly ids: readonly string[] }
  | { readonly kind: 'view'; readonly bounds: LinkRect }
  /** tldraw shape ids without `shape:`, decoded, in link order (resolve with `resolveLegacyShapes`) */
  | { readonly kind: 'legacy-shapes'; readonly parts: readonly string[] }
  | { readonly kind: 'legacy-view'; readonly bounds: LinkRect; readonly pageId: string | null }
  | { readonly kind: 'legacy-page'; readonly pageId: string }

const MAX_ABS = 1e9
const finite = (n: number) => Number.isFinite(n) && Math.abs(n) < MAX_ABS

const decode = (s: string): string | null => {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/** A `?view=` / legacy `v` rectangle, or null when a part is not a finite number or the size is not positive. */
function rectOf(parts: readonly string[]): LinkRect | null {
  if (parts.length < 4) return null
  const [x, y, w, h] = parts.slice(0, 4).map((p) => (p.trim() === '' ? Number.NaN : Number(p))) as [
    number,
    number,
    number,
    number,
  ]
  if (![x, y, w, h].every(finite) || w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

/** A tldraw deep-link string (`s…`, `v…`, `p…`), or null when it is malformed. */
export function parseLegacyDeepLink(value: string): DeepLink | null {
  const type = value[0]
  const rest = value.slice(1)
  if (type === 's') {
    const parts: string[] = []
    for (const raw of rest.split('.')) {
      if (!raw) continue
      const id = decode(raw)
      if (id === null) return null
      if (id) parts.push(id)
      if (parts.length >= MAX_LINK_IDS) break
    }
    return parts.length ? { kind: 'legacy-shapes', parts } : null
  }
  if (type === 'v') {
    const parts = rest.split('.')
    const bounds = rectOf(parts)
    if (!bounds) return null
    const page = parts[4] ? decode(parts[4]) : null
    return { kind: 'legacy-view', bounds, pageId: page ? `page:${page}` : null }
  }
  if (type === 'p') {
    const page = decode(rest)
    return page ? { kind: 'legacy-page', pageId: `page:${page}` } : null
  }
  return null
}

/** The deep link in a board URL: `?el=` first, then `?view=`, then the legacy `?d=`; null for none (or a malformed one). */
export function readDeepLink(href: string): DeepLink | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const el = url.searchParams.get(ELEMENTS_PARAM)
  if (el?.trim()) {
    const ids: string[] = []
    for (const raw of el.split(',')) {
      const id = decode(raw.trim())
      if (id && ELEMENT_ID_PATTERN.test(id) && !ids.includes(id)) ids.push(id)
      if (ids.length >= MAX_LINK_IDS) break
    }
    return ids.length ? { kind: 'elements', ids } : null
  }
  const view = url.searchParams.get(VIEW_PARAM)
  if (view?.trim()) {
    const bounds = rectOf(view.split(','))
    return bounds ? { kind: 'view', bounds } : null
  }
  const d = url.searchParams.get(LEGACY_PARAM)
  if (d?.trim()) return parseLegacyDeepLink(d.trim())
  return null
}

/** Whether the URL carries any deep-link parameter (handled once, then removed from the address bar). */
export function hasDeepLinkParam(href: string): boolean {
  try {
    const p = new URL(href).searchParams
    return DEEP_LINK_PARAMS.some((n) => p.has(n) && !(n === VIEW_PARAM && p.get(n) === REVIEW_VIEW_VALUE))
  } catch {
    return false
  }
}

/** The board's own URL with no query or hash: the base every "Copy link" builds on. */
export function linkBase(href: string): string {
  const url = new URL(href)
  return `${url.origin}${url.pathname}`
}

/**
 * `<base>?el=<id>,<id>` (ids URI-encoded; `,` is left readable). Ids that are not element ids are left
 * out; with none left, the bare base.
 */
export function elementsLink(base: string, ids: readonly string[]): string {
  const clean = [...new Set(ids)].filter((id) => ELEMENT_ID_PATTERN.test(id)).slice(0, MAX_LINK_IDS)
  if (!clean.length) return base
  return `${base}?${ELEMENTS_PARAM}=${clean.map((id) => encodeURIComponent(id)).join(',')}`
}

/**
 * Wave N (WS7, N7-5): the in-app path of a board, at one element when given (`/b/<id>?el=<id>`), as "Linked from"'s
 * "Go to the link" opens it. Read back by `readDeepLink` like any `?el=` link, so the board zooms to the element.
 */
export function boardElementPath(boardId: string, elementId?: string | null): string {
  const base = `/b/${encodeURIComponent(boardId)}`
  return elementId ? elementsLink(base, [elementId]) : base
}

/** `<base>?view=<x>,<y>,<w>,<h>` (rounded to whole scene pixels). */
export function viewLink(base: string, r: LinkRect): string {
  const n = (v: number) => String(Math.round(v))
  return `${base}?${VIEW_PARAM}=${[r.x, r.y, Math.max(1, r.w), Math.max(1, r.h)].map(n).join(',')}`
}

/**
 * The legacy shapes deep-link string (`s<id>.<id>`), exactly as tldraw's createDeepLinkString builds it:
 * the id without `shape:`, URI-encoded, with dots encoded too. The tldraw board page reads only this.
 */
export function legacyShapesLink(shapeIds: readonly string[]): string {
  const enc = (id: string) => encodeURIComponent(id.replace(/^shape:/, '')).replace(/\./g, '%2E')
  return `s${shapeIds.map(enc).join('.')}`
}

/**
 * The live element ids a legacy shapes link names, in link order. Each id is looked up through
 * `legacyIds` (`shape:<tldraw id>` → element id, lb_doc.import) and then as itself; a part that names
 * nothing is joined with the parts after it (`a.b.c`: `a.b.c`, then `a.b`, then `a`), longest first.
 */
export function resolveLegacyShapes(
  parts: readonly string[],
  isLive: (id: string) => boolean,
  legacyIds: Readonly<Record<string, string>> = {},
): string[] {
  const out: string[] = []
  const lookup = (candidate: string): string | null => {
    const mapped = Object.hasOwn(legacyIds, `shape:${candidate}`)
      ? legacyIds[`shape:${candidate}`]
      : undefined
    if (mapped && isLive(mapped)) return mapped
    return isLive(candidate) ? candidate : null
  }
  let i = 0
  while (i < parts.length) {
    let found: { id: string; next: number } | null = null
    for (let j = parts.length; j > i; j--) {
      const id = lookup(parts.slice(i, j).join('.'))
      if (id) {
        found = { id, next: j }
        break
      }
    }
    if (found) {
      if (!out.includes(found.id)) out.push(found.id)
      i = found.next
    } else i++
  }
  return out
}

/** One flattened tldraw page's frozen offset (canvas-schema doc.ts `import.legacyPages`). */
export interface LegacyPageOffset {
  readonly dx: number
  readonly dy: number
}

/** The frozen page offsets of `lb_doc.import`, or {} when the board was never converted (or it is malformed). */
export function legacyPagesOf(importDoc: unknown): Readonly<Record<string, LegacyPageOffset>> {
  const pages = (importDoc as { legacyPages?: unknown } | null | undefined)?.legacyPages
  if (!pages || typeof pages !== 'object') return {}
  const out: Record<string, LegacyPageOffset> = {}
  for (const [id, v] of Object.entries(pages as Record<string, unknown>)) {
    const p = v as { dx?: unknown; dy?: unknown } | null
    if (p && typeof p.dx === 'number' && typeof p.dy === 'number' && finite(p.dx) && finite(p.dy))
      out[id] = { dx: p.dx, dy: p.dy }
  }
  return out
}

/** `lb_doc.import.legacyIds` (`shape:<tldraw id>` → element id), or {}. */
export function legacyIdsOf(importDoc: unknown): Readonly<Record<string, string>> {
  const ids = (importDoc as { legacyIds?: unknown } | null | undefined)?.legacyIds
  if (!ids || typeof ids !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(ids as Record<string, unknown>)) if (typeof v === 'string') out[k] = v
  return out
}

/**
 * A legacy viewport link's rectangle on the new canvas: page 1 (or an unknown page) as it is, a page the
 * converter flattened to the right moved by that page's frozen offset.
 */
export function legacyViewBounds(
  bounds: LinkRect,
  pageId: string | null,
  pages: Readonly<Record<string, LegacyPageOffset>>,
): LinkRect {
  const off = pageId ? pages[pageId] : undefined
  return off ? { ...bounds, x: bounds.x + off.dx, y: bounds.y + off.dy } : bounds
}

/** path + remaining query + hash, for history.replaceState (same origin by construction). */
export function withoutParams(href: string, names: readonly string[]): string {
  const url = new URL(href)
  for (const n of names) {
    // wave S (WS4): `?view=review` is the review page's address (features/review-page), not a viewport deep link: it
    // stays, so a reload of the page is still the page
    if (n === VIEW_PARAM && url.searchParams.get(n) === REVIEW_VIEW_VALUE) continue
    url.searchParams.delete(n)
  }
  return `${url.pathname}${url.search}${url.hash}`
}
