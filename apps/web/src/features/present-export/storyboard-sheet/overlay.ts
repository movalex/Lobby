// OWNER: WS3 (wave T). The export layer `storyboard` (docs/WAVE-T-CONTRACTS.md §6.3, ./badges.ts registry): every
// export of the board (PNG, the clipboard, SVG and vector PDF pages) draws each exported panel's shot chip
// ("SH 03 · 2.5 s") at its frame's top-left, as the board shows the panel's number. Shot numbers are derived, never
// stored (canvas-schema planning: by `sb:pos`, ties by id), so the export says what every reader computes. Literal
// colours, the number as <text> (searchable in a vector PDF), nothing external, no author.
import { formatDuration } from '@draftroom/canvas-schema/planning'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { shotLabel, storyboardViews } from '../../storyboard-play/model.ts'
import type { ExportOverlayInput, ExportOverlayLayer } from '../ported/badges.ts'
import { xmlText } from '../review-summary/svg.ts'

const FONT = 'ui-sans-serif, system-ui, -apple-system, Helvetica, Arial, sans-serif'
const CHIP = { h: 24, padX: 8, inset: 8, fontPx: 13, charEm: 0.6, fill: '#1b2330', ink: '#ffffff' } as const

const num = (v: number) => String(Math.round(v * 100) / 100)

export interface ShotChip {
  /** the frame's top-left in the export's coordinates */
  readonly x: number
  readonly y: number
  readonly text: string
}

/** The chips of the exported panels, in export coordinates. */
export function shotChips(input: Pick<ExportOverlayInput, 'canvas' | 'exported' | 'origin'>): ShotChip[] {
  const out: ShotChip[] = []
  for (const sb of storyboardViews(input.canvas))
    for (const p of sb.panels) {
      if (!input.exported.has(p.id) || !p.bounds) continue
      out.push({
        x: p.bounds.x - input.origin.x,
        y: p.bounds.y - input.origin.y,
        text: `${shotLabel(p.number)} · ${formatDuration(p.durationMs)}`,
      })
    }
  return out
}

/** The chips as SVG (inside the frame's top-left corner). */
export function shotChipsSvg(chips: readonly ShotChip[]): string {
  if (!chips.length) return ''
  const parts = chips.map((c) => {
    const w = Math.ceil(CHIP.padX * 2 + c.text.length * CHIP.fontPx * CHIP.charEm)
    const x = c.x + CHIP.inset
    const y = c.y + CHIP.inset
    return (
      `<g data-dr-shot="${xmlText(c.text)}" transform="translate(${num(x)} ${num(y)})">` +
      `<rect x="0" y="0" width="${w}" height="${CHIP.h}" rx="${CHIP.h / 2}" fill="${CHIP.fill}"/>` +
      `<text x="${CHIP.padX}" y="${CHIP.h / 2 + CHIP.fontPx * 0.36}" fill="${CHIP.ink}" font-family="${FONT}" ` +
      `font-size="${CHIP.fontPx}px" font-weight="bold">${xmlText(c.text)}</text></g>`
    )
  })
  return `<g data-dr-storyboard-shots="">${parts.join('')}</g>`
}

/** Whether a canvas holds a storyboard panel (cheap: the scene index by key). */
const hasPanels = (canvas: LobbyCanvas) => canvas.index.withLobbyKey('sb:of').length > 0

export const STORYBOARD_OVERLAY: ExportOverlayLayer = {
  id: 'storyboard',
  order: 10,
  active: (canvas) => hasPanels(canvas),
  svg: (input) => shotChipsSvg(shotChips(input)),
}
