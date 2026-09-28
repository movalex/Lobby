// Pure logic behind the PDF page viewer and "Place on board" (FIL-04): which pages have previews,
// page navigation, the page selection, zoom steps and the row the placed pages form. No editor, no
// DOM: unit-tested in pdf-pages.test.ts.
import type { FileCardShape } from '@draftroom/canvas-schema'
import { pageRenderings } from '../assets/asset-store.ts'
import type { AssetVersionMeta, DerivativeRecord } from '../assets/contract.ts'
import type { Block, Size } from '../assets/drop-layout.ts'

export interface PreviewPage {
  /** 1-based page number. */
  page: number
  /** The largest rendering: what the viewer shows and what a placed page shows when zoomed in. */
  full: DerivativeRecord
  /** The smallest rendering (the viewer's page list). */
  thumb: DerivativeRecord
}

/** The pages the worker rendered, in page order (only the first LIMITS.eagerPdfPages have previews). */
export function previewPages(meta: AssetVersionMeta | null): PreviewPage[] {
  if (meta?.status !== 'ready' || meta.kind !== 'pdf') return []
  const numbers = new Set<number>()
  for (const d of meta.derivatives ?? []) {
    if (typeof d?.page === 'number' && Number.isInteger(d.page) && d.page >= 1) numbers.add(d.page)
  }
  const out: PreviewPage[] = []
  for (const page of [...numbers].sort((a, b) => a - b)) {
    const all = pageRenderings(meta, page)
    const thumb = all[0]
    const full = all[all.length - 1]
    if (thumb && full) out.push({ page, full, thumb })
  }
  return out
}

/** How many pages the document has: the worker's count, else the card's hint, never fewer than the previews. */
export function documentPageCount(
  meta: AssetVersionMeta | null,
  props: Pick<FileCardShape['props'], 'pageCount'>,
  previewed: number,
): number {
  const probe = meta?.probe?.pageCount
  const n =
    typeof probe === 'number' && Number.isInteger(probe) && probe > 0
      ? probe
      : typeof props.pageCount === 'number' && props.pageCount > 0
        ? props.pageCount
        : 0
  return Math.max(n, previewed)
}

// ---- navigation -----------------------------------------------------------------------------------

/** `delta` pages on from `current` among the previewed `pages` (sorted), clamped to the first/last. */
export function stepPage(pages: readonly number[], current: number, delta: number): number {
  if (!pages.length) return current
  const at = pages.indexOf(current)
  const from = at === -1 ? 0 : at
  const to = Math.min(pages.length - 1, Math.max(0, from + delta))
  return pages[to] ?? current
}

/** `wanted` if it has a preview, else the nearest previewed page (the first one for anything odd). */
export function validPage(pages: readonly number[], wanted: number): number {
  if (!pages.length) return 1
  if (pages.includes(wanted)) return wanted
  let best = pages[0] ?? 1
  for (const p of pages) if (Math.abs(p - wanted) < Math.abs(best - wanted)) best = p
  return best
}

// ---- selection --------------------------------------------------------------------------------------

/**
 * The selection after a click on `page`'s checkbox. A plain click toggles that page; with `range`
 * (Shift) and a previous click (`anchor`), every previewed page between the two takes the clicked
 * page's new state, as in a file list. Always sorted, unique, previewed pages only.
 */
export function toggleSelection(
  selected: readonly number[],
  page: number,
  available: readonly number[],
  opts: { range?: boolean; anchor?: number | null } = {},
): number[] {
  const set = new Set(selected.filter((p) => available.includes(p)))
  if (!available.includes(page)) return [...set].sort((a, b) => a - b)
  const on = !set.has(page)
  const anchor = opts.anchor
  if (opts.range && typeof anchor === 'number' && available.includes(anchor) && anchor !== page) {
    const lo = Math.min(anchor, page)
    const hi = Math.max(anchor, page)
    for (const p of available) {
      if (p < lo || p > hi) continue
      if (on) set.add(p)
      else set.delete(p)
    }
  } else if (on) set.add(page)
  else set.delete(page)
  return [...set].sort((a, b) => a - b)
}

// ---- zoom -------------------------------------------------------------------------------------------

/** Viewer zoom, as a multiple of "fit the whole page in the viewer". */
export const VIEWER_ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const

export function zoomStep(zoom: number, direction: 1 | -1): number {
  const steps: readonly number[] = VIEWER_ZOOM_STEPS
  if (direction > 0) return steps.find((s) => s > zoom + 1e-6) ?? steps[steps.length - 1] ?? zoom
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]
    if (s !== undefined && s < zoom - 1e-6) return s
  }
  return steps[0] ?? zoom
}

/** Zoom as a percentage of the fitted page (100 % = the whole page in view). */
export const zoomLabel = (zoom: number) => `${Math.round(zoom * 100)}%`

/** The page's on-screen size in the viewer: contain-fit in the stage, times `zoom`. */
export function viewerPageSize(page: Size, stage: Size, zoom: number): Size {
  if (!(page.w > 0 && page.h > 0 && stage.w > 0 && stage.h > 0)) return { w: 0, h: 0 }
  const fit = Math.min(stage.w / page.w, stage.h / page.h)
  return { w: page.w * fit * zoom, h: page.h * fit * zoom }
}

// ---- placing pages on the board ---------------------------------------------------------------------

/**
 * Page units per rendered pixel is 1 / PAGE_PIXEL_RATIO: a placed page is half its rendering's pixel
 * size (a 1024 px US Letter rendering becomes a 512 x 662 image). At 100 % zoom that is two device
 * pixels per page unit, sharp on a 2x (retina) screen; on a 1x screen it stays sharp up to 200 %.
 */
export const PAGE_PIXEL_RATIO = 2
/** Gap between placed pages, and between the card and the first page (page units). */
export const PAGE_GAP = 24

export function placedPageSize(d: Pick<DerivativeRecord, 'width' | 'height'>): Size {
  return { w: d.width / PAGE_PIXEL_RATIO, h: d.height / PAGE_PIXEL_RATIO }
}

/** The pages left to right in page order, tops aligned, `gap` apart; rects relative to the row's top-left. */
export function layoutPageRow(sizes: readonly Size[], gap = PAGE_GAP): Block {
  let x = 0
  const items = sizes.map((s) => {
    const w = s.w > 0 ? s.w : 1
    const h = s.h > 0 ? s.h : 1
    const r = { x, y: 0, w, h }
    x += w + gap
    return r
  })
  return {
    w: items.length ? x - gap : 0,
    h: items.reduce((m, r) => Math.max(m, r.h), 0),
    items,
  }
}

/** A placed page's file name: "Q3 brief — page 2.webp" (searchable, and "Download original" names the file). */
export function pageAssetName(fileName: string, page: number, mimeType: string): string {
  const stem = fileName.replace(/\.(?:pdf|docx|pptx|xlsx|odt|odp|ods)$/i, '').trim() || 'document'
  const ext = mimeType === 'image/png' ? 'png' : 'webp'
  return `${stem} — page ${page}.${ext}`.slice(0, 200)
}

/** "Page 3 of Q3 brief.pdf": the placed image's alt text. */
export const pageAltText = (fileName: string, page: number) => `Page ${page} of ${fileName}`
