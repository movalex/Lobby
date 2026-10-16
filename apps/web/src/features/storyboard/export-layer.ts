// OWNER: WS2 (wave T, storyboards). The storyboard's export layer (present-export/ported/badges.ts registry, id
// `storyboard`, order 10): the shot chip of every exported panel ("SH 03" and its duration) and the head's line
// ("12 panels · 0:24 · 16:9"), drawn over the engine's PNG, SVG, clipboard and vector PDF exports exactly where the
// canvas overlay draws them. Literal colours, text as <text> (searchable in the vector PDF), nothing external, no
// author name. Active only while the switch shows storyboards and the board holds one.
import { formatDuration, formatRunningTime, storyboardTimings } from '@draftroom/canvas-schema/planning'
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import type { ExportOverlayInput, ExportOverlayLayer } from '../present-export/ported/badges.ts'
import { PANEL_HEADER, shotLabel } from './model.ts'
import { boardsOf, shown } from './state.ts'

const FONT = "Nunito, 'Segoe UI', Helvetica, Arial, sans-serif"
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n2 = (v: number) => Math.round(v * 100) / 100

/** One chip as SVG at (x, y): the dark number pill, then the duration. */
export function chipSvg(x: number, y: number, shot: number, ms: number): string {
  const num = shotLabel(shot)
  const dur = formatDuration(ms)
  const w = 14 + num.length * 7.4
  return (
    `<g data-sb-chip="${shot}">` +
    `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="26" rx="13" fill="#1b2330"/>` +
    `<text x="${n2(x + w / 2)}" y="${n2(y + 17.5)}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="700" fill="#ffffff">${esc(num)}</text>` +
    `<text x="${n2(x + w + 8)}" y="${n2(y + 17.5)}" font-family="${FONT}" font-size="12" font-weight="600" fill="#5f6b7a">${esc(dur)}</text>` +
    `</g>`
  )
}

export function storyboardOverlaySvg(
  input: Pick<ExportOverlayInput, 'canvas' | 'exported' | 'origin'>,
): string {
  const { canvas, exported, origin } = input
  let out = ''
  for (const sb of boardsOf(canvas).values()) {
    const t = storyboardTimings(sb)
    for (const row of t.panels) {
      if (!exported.has(row.id)) continue
      const f = canvas.get(row.id)
      if (!f || f.isDeleted) continue
      out += chipSvg(
        f.x + 12 - origin.x,
        f.y + (PANEL_HEADER - 26) / 2 - origin.y,
        row.number,
        row.durationMs,
      )
    }
    const head = sb.head ? canvas.get(sb.head.id) : undefined
    if (head && !head.isDeleted && exported.has(head.id)) {
      const n = sb.panels.length
      const text = `${n} ${n === 1 ? 'panel' : 'panels'} · ${formatRunningTime(t.totalMs)} · ${sb.settings?.aspect ?? '16:9'}`
      out += `<text x="${n2(head.x + head.width + 16 - origin.x)}" y="${n2(head.y + head.height / 2 + 5 - origin.y)}" font-family="${FONT}" font-size="15" font-weight="600" fill="#5f6b7a">${esc(text)}</text>`
    }
  }
  return out ? `<g data-layer="storyboard">${out}</g>` : ''
}

export const STORYBOARD_OVERLAY: ExportOverlayLayer = {
  id: 'storyboard',
  order: 10,
  active: (canvas: LobbyCanvas) => shown() && boardsOf(canvas).size > 0,
  svg: (input) => storyboardOverlaySvg(input),
}
