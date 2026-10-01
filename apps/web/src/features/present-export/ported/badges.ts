// Revealed vote results in the Excalidraw page's exports (final review R14; ../../workshops/vote-export.ts):
// the result badges are an overlay, so the engine's exports leave them out. The workshops feature provides
// the results per canvas (`provideVoteResultsForExport(ctx.canvas, …)`); every export here draws the same
// badges as the board shows them: into the SVG (vote-export.ts `voteBadgesSvg`), and onto bitmaps by
// drawing that SVG over the exported canvas.
import { fromShapeRef } from '@draftroom/canvas-schema/refs'
import type { VoteResult } from '@draftroom/contracts'
import type { Bounds, LobbyCanvas } from '../../../canvas/api/index.ts'
import { type ExportBadge, voteBadgesSvg, voteResultsForExport } from '../../workshops/vote-export.ts'

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

/** `svg` (an Excalidraw export: viewBox `0 0 w h`) with the badges drawn on top. */
export function svgWithBadges(svg: string, badges: readonly ExportBadge[]): string {
  if (!badges.length) return svg
  const end = svg.lastIndexOf('</svg>')
  const m = /<svg\b[^>]*?\sviewBox="\s*([\d.e+-]+)[\s,]+([\d.e+-]+)[\s,]+([\d.e+-]+)[\s,]+([\d.e+-]+)/i.exec(
    svg,
  )
  if (end < 0 || !m) return svg
  const view = { minX: Number(m[1]), minY: Number(m[2]), width: Number(m[3]), height: Number(m[4]) }
  return `${svg.slice(0, end)}${voteBadgesSvg(badges, view)}${svg.slice(end)}`
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
  const layer = voteBadgesSvg(badges, { minX: 0, minY: 0, width: w, height: h })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${w} ${h}">${layer}</svg>`
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
