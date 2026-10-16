// What the board shows as overlays, in the Excalidraw page's exports. Overlays are not elements, so the engine's
// exports leave them out; every export here draws them as the board shows them: into the SVG, and onto bitmaps by
// drawing that SVG over the exported canvas (and so into vector PDF pages too, which are SVG).
//
// Wave T foundation (docs/WAVE-T-CONTRACTS.md §6.3): the EXPORT-OVERLAY REGISTRY. Each overlay is a named layer
// (`registerExportOverlay`) that says whether it has anything to draw on a canvas and gives its SVG markup for one
// export (`ExportOverlayInput`: the ids the export draws, its top-left in scene coordinates, its viewBox). The first
// layer is the revealed vote results (final review R14; ../../workshops/vote-export.ts: the workshops feature provides
// the results per canvas, `provideVoteResultsForExport(ctx.canvas, …)`). Wave T's workstreams add theirs: storyboard
// shot chips (WS2), card chips (WS4), Kanban columns (WS4) and timeline rulers and bars (WS5). With no active layer an
// export is the engine's alone, exactly as before.
import { fromShapeRef } from '@draftroom/canvas-schema/refs'
import type { VoteResult } from '@draftroom/contracts'
import type { Bounds, LobbyCanvas } from '../../../canvas/api/index.ts'
import {
  type ExportBadge,
  type ViewBox,
  voteBadgesSvg,
  voteResultsForExport,
} from '../../workshops/vote-export.ts'

/** A vote result's element id (results name shapes by their api ref, `shape:<id>`). */
export const resultElementId = (r: Pick<VoteResult, 'shapeId'>): string =>
  fromShapeRef(String(r.shapeId)) ?? String(r.shapeId)

/** The revealed results this person sees as badges (null: none revealed or shown). */
export const exportResults = (canvas: LobbyCanvas) => voteResultsForExport(canvas)

/** Badges for the results on `exported` elements, in scene coordinates (the corner the board uses). */
export function exportBadges(
  canvas: LobbyCanvas,
  exported: ReadonlySet<string>,
  results: readonly VoteResult[] | null,
): ExportBadge[] {
  const out: ExportBadge[] = []
  for (const r of results ?? []) {
    const id = resultElementId(r)
    if (!exported.has(id)) continue
    const b = canvas.bounds(id)
    if (b) out.push({ x: b.x + b.width, y: b.y, rank: r.rank, n: r.count })
  }
  return out
}

/** Badges moved into an export whose top-left is `origin` (scene), in export px at `scale`. */
export const shiftBadges = (badges: readonly ExportBadge[], origin: { x: number; y: number }) =>
  badges.map((b) => ({ ...b, x: b.x - origin.x, y: b.y - origin.y }))

/**
 * An export's top-left in scene coordinates, from what it draws and its size: the drawn elements'
 * right and bottom edges plus the margin are the export's (a frame's title the engine draws sits above
 * the frame, so the left and top edges are not the elements' own).
 */
export function exportOrigin(
  elements: readonly Bounds[],
  size: { width: number; height: number },
  padding: number,
): { x: number; y: number } {
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const b of elements) {
    maxX = Math.max(maxX, b.x + b.width)
    maxY = Math.max(maxY, b.y + b.height)
  }
  if (!Number.isFinite(maxX)) return { x: 0, y: 0 }
  return { x: maxX + padding - size.width, y: maxY + padding - size.height }
}

const VIEWBOX_RE = /<svg\b[^>]*?\sviewBox="\s*([\d.e+-]+)[\s,]+([\d.e+-]+)[\s,]+([\d.e+-]+)[\s,]+([\d.e+-]+)/i

/** `layer` (SVG markup in the export's coordinates) inserted before the end of `svg`; `svg` when it cannot be. */
function svgWithLayer(svg: string, layer: (view: ViewBox) => string): string {
  const end = svg.lastIndexOf('</svg>')
  const m = VIEWBOX_RE.exec(svg)
  if (end < 0 || !m) return svg
  const markup = layer({ minX: Number(m[1]), minY: Number(m[2]), width: Number(m[3]), height: Number(m[4]) })
  return markup ? `${svg.slice(0, end)}${markup}${svg.slice(end)}` : svg
}

/** `svg` (an Excalidraw export: viewBox `0 0 w h`) with the badges drawn on top. */
export function svgWithBadges(svg: string, badges: readonly ExportBadge[]): string {
  if (!badges.length) return svg
  return svgWithLayer(svg, (view) => voteBadgesSvg(badges, view))
}

/** Draws `markup` (SVG in export coordinates of `w` x `h` scene units) over a bitmap export. */
async function drawSvgOver(canvas: HTMLCanvasElement, markup: string, w: number, h: number): Promise<void> {
  if (!markup) return
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${w} ${h}">${markup}</svg>`
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Draws the badges over a bitmap export (`scale` export px per scene px). */
export async function drawBadges(
  canvas: HTMLCanvasElement,
  badges: readonly ExportBadge[],
  scale: number,
): Promise<void> {
  if (!badges.length) return
  const w = canvas.width / scale
  const h = canvas.height / scale
  await drawSvgOver(canvas, voteBadgesSvg(badges, { minX: 0, minY: 0, width: w, height: h }), w, h)
}

// ---- the export-overlay registry (wave T foundation) -------------------------------------------------------------

/** The overlay layers an export draws (each workstream adds its own id here through the lead). */
export type ExportOverlayId = 'votes' | 'storyboard' | 'cards' | 'kanban' | 'timeline'

/** One export, as a layer sees it. */
export interface ExportOverlayInput {
  readonly canvas: LobbyCanvas
  /** the ids the export draws (a layer draws only for those) */
  readonly exported: ReadonlySet<string>
  /** the export's top-left in scene coordinates: a layer draws a scene point p at p - origin */
  readonly origin: { readonly x: number; readonly y: number }
  /** the export's viewBox, in the same (export) coordinates */
  readonly view: ViewBox
}

export interface ExportOverlayLayer {
  readonly id: ExportOverlayId
  /** drawing order, lowest first (votes 100: the badges stay on top of wave T's layers, 10 to 40) */
  readonly order: number
  /** whether it may have anything to draw on this canvas (cheap; false for every layer: the engine's export alone) */
  active(canvas: LobbyCanvas): boolean
  /**
   * Its SVG markup for one export ('' for nothing): literal colours (an exported SVG is drawn as an image, where the
   * app's CSS variables do not exist), text as `<text>` (searchable in the vector PDF), no external reference.
   */
  svg(input: ExportOverlayInput): string
}

const layers = new Map<ExportOverlayId, ExportOverlayLayer>()

/** Adds (or replaces) a layer; returns its removal. A workstream registers its layer once, at module load. */
export function registerExportOverlay(layer: ExportOverlayLayer): () => void {
  layers.set(layer.id, layer)
  return () => {
    if (layers.get(layer.id) === layer) layers.delete(layer.id)
  }
}

/** The registered layers in drawing order (by `order`, then id). */
export const exportOverlayLayers = (): ExportOverlayLayer[] =>
  [...layers.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** Whether any layer may draw on this canvas (an export with none skips the overlay work). */
export const exportOverlaysActive = (canvas: LobbyCanvas): boolean =>
  exportOverlayLayers().some((l) => l.active(canvas))

/** Every active layer's markup for one export, in order. */
export function exportOverlaySvg(input: ExportOverlayInput): string {
  let out = ''
  for (const l of exportOverlayLayers()) if (l.active(input.canvas)) out += l.svg(input)
  return out
}

/** `svg` (an Excalidraw export) with every active layer drawn on top. */
export function svgWithOverlays(svg: string, input: Omit<ExportOverlayInput, 'view'>): string {
  return svgWithLayer(svg, (view) => exportOverlaySvg({ ...input, view }))
}

/** Draws every active layer over a bitmap export (`scale` export px per scene px). */
export async function drawOverlays(
  canvas: HTMLCanvasElement,
  input: Omit<ExportOverlayInput, 'view'>,
  scale: number,
): Promise<void> {
  const w = canvas.width / scale
  const h = canvas.height / scale
  await drawSvgOver(
    canvas,
    exportOverlaySvg({ ...input, view: { minX: 0, minY: 0, width: w, height: h } }),
    w,
    h,
  )
}

/** The first layer: revealed vote results, as the board shows them (the badges' corner, rank colours). */
export const VOTES_OVERLAY: ExportOverlayLayer = {
  id: 'votes',
  order: 100,
  active: (canvas) => exportResults(canvas) !== null,
  svg: ({ canvas, exported, origin, view }) => {
    const badges = shiftBadges(exportBadges(canvas, exported, exportResults(canvas)), origin)
    return badges.length ? voteBadgesSvg(badges, view) : ''
  },
}
registerExportOverlay(VOTES_OVERLAY)
