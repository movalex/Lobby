// OWNER: WS5 (wave T). The timeline's layer in the export-overlay registry (present-export/ported/badges.ts, id
// `timeline`, order 40): PNG, the clipboard, SVG and the vector PDF pages draw each exported timeline (its ruler, lanes,
// today marker and bars) over the engine's export, from the same layout and primitives the board shows. Literal colours
// (the light palette: exports are light), text as `<text>` (searchable in the vector PDF), `rx` with `ry` (the vector
// page reads a rect with only one as a feature it does not draw), no clip path, no external reference and no author.
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import { planningShown, timelinesOn } from '../planning/index.ts'
import type { ExportOverlayLayer } from '../present-export/ported/badges.ts'
import { timelineCards } from './cards.ts'
import { todayOf } from './dates.ts'
import { layoutTimeline } from './layout.ts'
import { memberNamesOf } from './names.ts'
import { barPrims, esc, framePrims, LIGHT, primsSvg } from './paint.ts'

/** The markup of one timeline in an export whose top-left is `origin` (scene coordinates). */
export function timelineSvg(
  canvas: LobbyCanvas,
  frameId: string,
  origin: { readonly x: number; readonly y: number },
  today: string = todayOf(),
): string {
  const found = timelinesOn(canvas).find((f) => f.el.id === frameId)
  if (!found) return ''
  const layout = layoutTimeline({
    t: found.value,
    size: { width: found.el.width, height: found.el.height },
    cards: timelineCards(canvas),
    today,
    names: memberNamesOf(canvas),
  })
  const bars = layout.bars
    .map((bar) => `<g data-dr-timeline-bar="${esc(bar.id)}">${primsSvg(barPrims(bar, LIGHT))}</g>`)
    .join('')
  const x = Math.round((found.el.x - origin.x) * 100) / 100
  const y = Math.round((found.el.y - origin.y) * 100) / 100
  return (
    `<g data-dr-timeline="${esc(frameId)}" transform="translate(${x} ${y})">` +
    `${primsSvg(framePrims(layout, LIGHT))}${bars}</g>`
  )
}

export const TIMELINE_EXPORT_LAYER: ExportOverlayLayer = {
  id: 'timeline',
  order: 40,
  active: (canvas) => planningShown('timeline') && timelinesOn(canvas).length > 0,
  svg: ({ canvas, exported, origin }) =>
    timelinesOn(canvas)
      .filter((f) => exported.has(f.el.id))
      .map((f) => timelineSvg(canvas, f.el.id, origin))
      .join(''),
}
