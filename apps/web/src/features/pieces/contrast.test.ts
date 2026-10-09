// L8-3: every piece reads in both themes. Each piece's words (a label inside a shape, a text on a card) have
// at least 4.5:1 against what is behind them, in light mode and in dark mode, where the canvas draws every
// stored colour through Lobby's dark table (canvas/engine/theme.ts `lobbyDarkColor`). A colour with no designed
// dark shade would fall to Excalidraw's own filter and is not allowed: pieces use only Lobby's palette.
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { instantiatePiece, PIECE_IDS, type PieceId } from '@draftroom/templates/pieces'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../../theme/contrast.ts'

// the engine's dark-mode cache exists only in a browser (`typeof window`): stand one in before the theme loads
;(globalThis as { window?: unknown }).window ??= globalThis
const theme = await import('../../canvas/engine/theme.ts')

installServerTextMetrics()

interface El {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  strokeColor: string
  backgroundColor: string
  index: string
  containerId?: string | null
  points?: [number, number][]
  originalText?: string
}

const box = (e: El) => {
  if (e.points?.length) {
    const xs = e.points.map((p) => e.x + p[0])
    const ys = e.points.map((p) => e.y + p[1])
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    }
  }
  return { x: e.x, y: e.y, w: e.width, h: e.height }
}

/** What is behind a text: the fill of the topmost shape under its middle, else the canvas. */
function backdrop(text: El, all: readonly El[]): string {
  const b = box(text)
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const under = all
    .filter((e) => e.index < text.index && e.type !== 'text' && e.backgroundColor !== 'transparent')
    .filter((e) => {
      const r = box(e)
      return c.x >= r.x && c.x <= r.x + r.w && c.y >= r.y && c.y <= r.y + r.h
    })
    .sort((p, q) => (p.index < q.index ? 1 : -1))
  return under[0]?.backgroundColor ?? 'canvas'
}

const dark = (color: string): string => {
  if (color === 'canvas') return theme.CANVAS_DARK
  const d = theme.lobbyDarkColor(color)
  if (d === null) throw new Error(`${color} has no designed dark shade (not one of Lobby's palette colours)`)
  return d
}
const light = (color: string): string => (color === 'canvas' ? theme.CANVAS_LIGHT : color)

describe.each(PIECE_IDS.map((id) => [id] as const))('piece %s: words read in both themes', (id: PieceId) => {
  const piece = instantiatePiece(id, { origin: { x: 0, y: 0 } })
  const all = piece.elements as unknown as El[]
  const texts = all.filter((e) => e.type === 'text')

  it('has colours that exist in the dark table: strokes and fills are Lobby’s own', () => {
    // (a frame is drawn in the theme's own frame colours, FRAME_STYLE, not by its stored stroke)
    for (const e of all.filter((x) => x.type !== 'frame')) {
      for (const c of [e.strokeColor, e.backgroundColor]) {
        if (c === 'transparent') continue
        expect(() => dark(c), `${e.type} ${c}`).not.toThrow()
      }
    }
  })

  it('has every word at 4.5:1 or more on what is behind it, in light and in dark', () => {
    for (const t of texts) {
      const bg = t.containerId
        ? (all.find((e) => e.id === t.containerId)?.backgroundColor ?? 'canvas')
        : backdrop(t, all)
      // a see-through container (a polygon's holder) shows the shape drawn under it
      const behind = bg === 'transparent' ? backdrop(t, all) : bg
      expect(
        contrastRatio(light(t.strokeColor), light(behind)),
        `light: "${t.originalText}" on ${behind}`,
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(dark(t.strokeColor), dark(behind)),
        `dark: "${t.originalText}" on ${behind}`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('never sets white words on a saturated fill', () => {
    for (const t of texts) expect(t.strokeColor.toLowerCase(), t.originalText).not.toBe('#ffffff')
  })
})
