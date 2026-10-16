// OWNER: WS4 (wave T; docs/WAVE-T-CONTRACTS.md §6.3). The `kanban` export layer: each exported Kanban frame's header
// (column names and card counts, the WIP limit) and the lines between its columns, as the board shows them, in export
// coordinates with literal colours and text as `<text>` (searchable in the vector PDF).
import { kanbanColumns, kanbanOf, type PlanningElement } from '@draftroom/canvas-schema/planning'
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import { planningShown } from '../planning/index.ts'
import type { ExportOverlayInput, ExportOverlayLayer } from '../present-export/ported/badges.ts'
import { bandsOf, columnCounts, KANBAN_HEADER_H } from './layout.ts'
import { boxesIn, rectOf } from './scene.ts'

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
const FONT = 'font-family="Inter, \'Helvetica Neue\', Arial, sans-serif"'

export function kanbanExportSvg(input: Pick<ExportOverlayInput, 'canvas' | 'exported' | 'origin'>): string {
  const { canvas, exported, origin } = input
  let out = ''
  for (const el of canvas.index.withLobbyKey('kanban')) {
    if (!exported.has(el.id)) continue
    const value = kanbanOf(el as PlanningElement)
    if (!value) continue
    const frame = rectOf(el)
    const bands = bandsOf(frame, value)
    const cols = kanbanColumns(value)
    const { counts } = columnCounts(value, boxesIn(canvas, el.id))
    const y = el.y - origin.y
    out += `<rect x="${el.x - origin.x}" y="${y}" width="${el.width}" height="${KANBAN_HEADER_H}" fill="#f4f5f7" fill-opacity="0.9"/>`
    out += `<line x1="${el.x - origin.x}" y1="${y + KANBAN_HEADER_H}" x2="${el.x - origin.x + el.width}" y2="${y + KANBAN_HEADER_H}" stroke="#c5cad3"/>`
    bands.forEach((b, i) => {
      const x = b.x - origin.x
      if (i > 0)
        out += `<line x1="${x}" y1="${y + 8}" x2="${x}" y2="${y + el.height - 8}" stroke="#c5cad3" stroke-dasharray="6 6"/>`
      const c = cols[i]
      const count = counts.get(b.status) ?? 0
      const over = c?.wip != null && count > c.wip
      const n = c?.wip != null ? `${count} / ${c.wip}` : String(count)
      out += `<text x="${x + 16}" y="${y + 30}" ${FONT} font-size="16" font-weight="700" fill="#1f2a44">${esc(c?.label ?? b.status)}</text>`
      out += `<text x="${x + 16}" y="${y + 52}" ${FONT} font-size="12" font-weight="600" fill="${over ? '#b42318' : '#5b6372'}">${esc(over ? `${n} · over the limit` : `${n} ${count === 1 ? 'card' : 'cards'}`)}</text>`
    })
  }
  return out ? `<g data-layer="kanban">${out}</g>` : ''
}

export const KANBAN_OVERLAY: ExportOverlayLayer = {
  id: 'kanban',
  order: 15,
  active: (canvas: LobbyCanvas) => planningShown('kanban') && canvas.index.withLobbyKey('kanban').length > 0,
  svg: (input) => kanbanExportSvg(input),
}
