// The storyboard's export layer (wave T, WS2): the shot chips of the exported panels, in export coordinates, as
// literal-colour SVG with searchable text; nothing for panels left out of the export; the head's line; the review
// item label of a panel.
import { describe, expect, it, vi } from 'vitest'
import { PLANNING_FLAG_KEYS } from '../planning/index.ts'
import { chipSvg, STORYBOARD_OVERLAY, storyboardOverlaySvg } from './export-layer.ts'
import { createStoryboard } from './ops.ts'
import { panelReviewLabel } from './review.ts'
import { asCanvas, fakeSbCanvas } from './test-canvas.ts'

let n = 0
const ids = () => `x${++n}`

describe('the storyboard export layer', () => {
  it('draws each exported panel’s chip at its top-left, minus the export origin; the head’s line', () => {
    const f = fakeSbCanvas()
    const canvas = asCanvas(f)
    const made = createStoryboard(
      canvas,
      { title: 'Spot', aspect: '16:9', panels: [{ durationMs: 2500 }, {}, {}], at: { x: 100, y: 50 } },
      ids,
    )
    if (!made) throw new Error('not made')
    const [p1, p2] = made.panelIds as [string, string]
    const svg = storyboardOverlaySvg({
      canvas,
      exported: new Set([p1, made.headId]),
      origin: { x: 100, y: 0 },
    })
    expect(svg.startsWith('<g data-layer="storyboard">')).toBe(true)
    expect(svg).toContain('data-sb-chip="1"')
    expect(svg).not.toContain('data-sb-chip="2"')
    expect(svg).toContain('>SH 01<')
    expect(svg).toContain('>2.5 s<')
    expect(svg).toContain('3 panels · 0:07 · 16:9')
    expect(svg).not.toMatch(/var\(|href=|url\(/)
    const frame = f.els.get(p1)
    expect(svg).toContain(`<rect x="${(frame?.x ?? 0) + 12 - 100}" y="${(frame?.y ?? 0) + 7}"`)
    expect(storyboardOverlaySvg({ canvas, exported: new Set([p2]), origin: { x: 0, y: 0 } })).toContain(
      '>SH 02<',
    )
    expect(storyboardOverlaySvg({ canvas, exported: new Set(), origin: { x: 0, y: 0 } })).toBe('')
  })

  it('is active only with the switch on and a storyboard on the board', () => {
    const f = fakeSbCanvas()
    const canvas = asCanvas(f)
    expect(STORYBOARD_OVERLAY.active(canvas)).toBe(false)
    createStoryboard(canvas, { title: 'Spot', aspect: '1:1', panels: [{}], at: { x: 0, y: 0 } }, ids)
    // shipped on since the wave T integration (here the switch reads the shipped value)
    expect(STORYBOARD_OVERLAY.active(canvas)).toBe(true)
    expect(PLANNING_FLAG_KEYS.storyboard).toBe('lobby.planStoryboard')
    // a dev-auth page that turns the switch off
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === PLANNING_FLAG_KEYS.storyboard ? '0' : null),
    })
    try {
      expect(STORYBOARD_OVERLAY.active(canvas)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('escapes its words; a chip is literal colours', () => {
    expect(chipSvg(0, 0, 12, 600_000)).toContain('fill="#1b2330"')
    expect(chipSvg(0, 0, 12, 600_000)).toContain('>600 s<')
  })
})

describe('Put panels in review', () => {
  it('labels an item by its shot, and its frame’s own name when it has one', () => {
    expect(panelReviewLabel(3, 'Panel')).toBe('SH 03')
    expect(panelReviewLabel(3, '  ')).toBe('SH 03')
    expect(panelReviewLabel(12, 'Kitchen <dawn>')).toBe('SH 12 · Kitchen <dawn>')
  })
})
