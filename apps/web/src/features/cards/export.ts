// OWNER: WS4 (wave T; docs/WAVE-T-CONTRACTS.md §6.3). The `cards` export layer: every exported card's chips (status
// with its icon and words, the due date, the assignee's initials) drawn over the engine's export as the board shows
// them, in export coordinates (a scene point p at p - origin), with literal colours and text as `<text>` (searchable
// in the vector PDF), no external reference. An export with no card draws nothing.
import { cardOf, type PlanningElement } from '@draftroom/canvas-schema/planning'
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import { planningShown } from '../planning/index.ts'
import type { ExportOverlayInput, ExportOverlayLayer } from '../present-export/ported/badges.ts'
import { cardsOf } from './bridge.ts'
import { STATUS_PATHS } from './icons.tsx'
import { dueWords, initialsOf, STATUS_EXPORT_COLORS, statusWords, todayLocal } from './model.ts'

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )

const FONT = 'font-family="Inter, \'Helvetica Neue\', Arial, sans-serif"'
const H = 20
const PAD = 8
/** An estimate of a run of 11 px text (no measuring in a worker or a test). */
const textWidth = (s: string) => Math.ceil([...s].length * 6.1)

function chip(
  x: number,
  y: number,
  label: string,
  colors: { fill: string; ink: string; line: string },
  icon?: readonly string[],
) {
  const iw = icon ? 16 : 0
  const w = PAD + iw + textWidth(label) + PAD
  const paths = icon
    ? `<g transform="translate(${x + PAD - 2} ${y + 3}) scale(0.875)" fill="none" stroke="${colors.ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icon.map((d) => `<path d="${d}"/>`).join('')}</g>`
    : ''
  return {
    w,
    svg:
      `<rect x="${x}" y="${y}" width="${w}" height="${H}" rx="${H / 2}" fill="${colors.fill}" stroke="${colors.line}"/>` +
      paths +
      `<text x="${x + PAD + iw}" y="${y + 14}" ${FONT} font-size="11" font-weight="600" fill="${colors.ink}">${esc(label)}</text>`,
  }
}

const DUE = { fill: '#ffffff', ink: '#3d4451', line: '#c5cad3' }
const OVERDUE = { fill: '#fde4e4', ink: '#b42318', line: '#f1a9a3' }

/** The chips' markup for the exported cards (export coordinates). */
export function cardsExportSvg(input: Pick<ExportOverlayInput, 'canvas' | 'exported' | 'origin'>): string {
  const { canvas, exported, origin } = input
  const s = cardsOf(canvas)
  const today = todayLocal()
  let out = ''
  for (const el of canvas.index.withLobbyKey('card:status')) {
    if (!exported.has(el.id)) continue
    const card = cardOf(el as PlanningElement)
    if (!card) continue
    const x0 = el.x - origin.x + PAD
    const y = el.y - origin.y + el.height - H - PAD
    let x = x0
    const st = chip(
      x,
      y,
      statusWords(card.status),
      STATUS_EXPORT_COLORS[card.status],
      STATUS_PATHS[card.status],
    )
    out += st.svg
    x += st.w + 4
    const due = dueWords(card, today)
    if (due) {
      const c = chip(x, y, due.text, due.overdue ? OVERDUE : DUE)
      out += c.svg
      x += c.w + 4
    }
    if (card.who) {
      const name =
        s?.people.member(card.who)?.name ?? canvas.collaborators().find((r) => r.uid === card.who)?.name
      const initials = name ? initialsOf(name) : '?'
      const cx = Math.max(x + H / 2, el.x - origin.x + el.width - PAD - H / 2)
      out +=
        `<circle cx="${cx}" cy="${y + H / 2}" r="${H / 2}" fill="#1f2a44"/>` +
        `<text x="${cx}" y="${y + 14}" text-anchor="middle" ${FONT} font-size="10" font-weight="700" fill="#ffffff">${esc(initials)}</text>`
    }
  }
  return out ? `<g data-layer="cards">${out}</g>` : ''
}

/** The layer as the export-overlay registry takes it (active once the board holds a card). */
export const CARDS_OVERLAY: ExportOverlayLayer = {
  id: 'cards',
  order: 20,
  active: (canvas: LobbyCanvas) =>
    planningShown('cards') && canvas.index.withLobbyKey('card:status').length > 0,
  svg: (input) => cardsExportSvg(input),
}
