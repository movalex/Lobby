// OWNER: 3i (docs/EXCALIDRAW-MIGRATION.md §4.8 (5)): the contrast check of Lobby's 13-colour palette on the new
// canvas, in light mode and in dark mode THROUGH THE ENGINE'S OWN FILTER. Excalidraw stores literal (light)
// colours and draws dark mode by filtering the whole canvas (`applyDarkModeFilter`: invert 93 %, hue-rotate
// 180°), so the dark values are not Lobby's choice as they were on tldraw (features/canvas-ux/palette.ts has
// hand-picked dark fills). This file lives under canvas/ because only canvas/** may import @excalidraw/*
// (biome.json); the WCAG maths is the a11y feature's (features/a11y/ported/contrast.ts).
//
// Finding (wave 3i): the RED note's ink is 3.43:1 in dark mode, below AA's 4.5:1 (3:1 is enough only for
// large text); every other note meets AA in both modes. Pinned below so a palette change shows up here; the
// fix belongs to the palette's owners (board-ops/elements/palette.ts and the converter's copy).
//
// The early wave-5 review (W5-10, W5-15) asks for the check to go through the dark path the board really
// draws and to require 4.5:1, and to cover frame names and outlines too. That path is 2C's engine theme
// (hand-picked dark variants instead of this filter), so those checks read the rendered pixels instead:
// e2e/excalidraw/a11y-contrast.spec.ts (expected failures until the theme lands; it measures 3.55:1 for the
// red note, 2.85:1 for a frame name on white). The filter's numbers here stay as the engine's baseline.
import {
  LOBBY_COLOR_NAMES,
  LOBBY_INK,
  LOBBY_PALETTE,
  type LobbyColorName,
} from '@draftroom/board-ops/elements'
import { applyDarkModeFilter } from '@excalidraw/common'
import { describe, expect, it } from 'vitest'
import { AA_NON_TEXT, AA_TEXT, contrastRatio } from '../../features/a11y/ported/contrast.ts'

const dark = (hex: string) => applyDarkModeFilter(hex)
/** The canvas background (Excalidraw's viewBackgroundColor, white) in each mode. */
const BG = { light: '#ffffff', dark: dark('#ffffff') }
const round = (n: number) => Number(n.toFixed(2))

const noteRatio = (name: LobbyColorName, mode: 'light' | 'dark') => {
  const c = LOBBY_PALETTE[name]
  return mode === 'light'
    ? contrastRatio(c.noteFill, LOBBY_INK)
    : contrastRatio(dark(c.noteFill), dark(LOBBY_INK))
}

describe('the note palette on the new canvas (WCAG AA)', () => {
  it('has the 13 colours', () => {
    expect(LOBBY_COLOR_NAMES).toHaveLength(13)
  })

  it('light mode: note ink on every note fill is at least 4.5:1', () => {
    const low = LOBBY_COLOR_NAMES.filter((n) => noteRatio(n, 'light') < AA_TEXT)
    expect(low).toEqual([])
  })

  it('dark mode (the engine filter): every note but red is at least 4.5:1; red is 3.43:1 (the finding)', () => {
    const low = LOBBY_COLOR_NAMES.filter((n) => noteRatio(n, 'dark') < AA_TEXT)
    expect(low).toEqual(['red'])
    expect(round(noteRatio('red', 'dark'))).toBe(3.43)
    expect(noteRatio('red', 'dark')).toBeGreaterThanOrEqual(AA_NON_TEXT)
  })

  it('the dark canvas is #121212, and the filter keeps note ink light on dark fills', () => {
    expect(BG.dark).toBe('#121212')
    expect(dark(LOBBY_INK)).toBe('#c9d0db')
  })

  it('every stroke colour that reads at 3:1 on the light canvas still does on the dark one', () => {
    const readable = LOBBY_COLOR_NAMES.filter(
      (n) => contrastRatio(LOBBY_PALETTE[n].solid, BG.light) >= AA_NON_TEXT,
    )
    expect(readable).toEqual(['black', 'blue', 'green', 'grey', 'orange', 'red', 'violet'])
    const lost = readable.filter((n) => contrastRatio(dark(LOBBY_PALETTE[n].solid), BG.dark) < AA_NON_TEXT)
    expect(lost).toEqual([])
  })
})

// Wave M (M1-5, FTU-9; W1's): a note whose fill is not one of Lobby's swatches is drawn in dark mode with the fill as
// it is (Lobby's theme draws an explicit colour unchanged), so its label takes whichever of Lobby's two inks reads
// better on that fill (canvas/engine/theme.ts `noteInkFor`). Through Lobby's dark table, the path the board draws.
describe('wave M (M1-5): off-palette notes read in dark mode; the 13 swatches are unchanged', async () => {
  const theme = await import('../engine/theme.ts')
  const { NOTE_PALETTE } = await import('../../features/canvas-ux/palette.ts')
  /** The fill as Lobby's dark mode draws it (its table; an explicit colour as it is; greys through the filter). */
  const drawn = (fill: string) => theme.lobbyDarkColor(fill) ?? dark(fill)

  it('excalidraw.com pastels (#b2f2bb, #a5d8ff, #ffc9c9) get an ink of at least 4.5:1 on the fill as drawn', () => {
    for (const fill of ['#b2f2bb', '#a5d8ff', '#ffc9c9']) {
      const ink = theme.noteInkFor(fill, 'dark')
      expect(ink, fill).toBe(theme.INK)
      expect(contrastRatio(drawn(fill), ink), fill).toBeGreaterThanOrEqual(AA_TEXT)
      // what it was: the one dark ink, near-white on pastel
      expect(contrastRatio(drawn(fill), theme.CHALK), fill).toBeLessThan(AA_TEXT)
    }
  })

  it('more pastels and darks from other tools: the ink is always the better of the two, and reads', () => {
    for (const fill of ['#ffec99', '#d0bfff', '#e9ecef', '#99e9f2', '#1e3a5f', '#343a40', '#000000']) {
      const ink = theme.noteInkFor(fill, 'dark')
      const other = ink === theme.INK ? theme.CHALK : theme.INK
      expect(contrastRatio(drawn(fill), ink), fill).toBeGreaterThanOrEqual(contrastRatio(drawn(fill), other))
      expect(contrastRatio(drawn(fill), ink), fill).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  it('the 13 swatches keep their inks (CHALK on the designed dark fills, INK in light), each at 4.5:1 or more', () => {
    expect(NOTE_PALETTE).toHaveLength(13)
    for (const s of NOTE_PALETTE) {
      expect(theme.noteInkFor(s.light.fill, 'light'), s.label).toBe(theme.INK)
      expect(theme.noteInkFor(s.light.fill, 'dark'), s.label).toBe(theme.CHALK)
      expect(contrastRatio(drawn(s.light.fill), theme.CHALK), s.label).toBeGreaterThanOrEqual(AA_TEXT)
      // case and the #rgb form do not matter
      expect(theme.noteInkFor(s.light.fill.toUpperCase(), 'dark'), s.label).toBe(theme.CHALK)
    }
    // what is no colour keeps the dark ink
    expect(theme.noteInkFor('transparent', 'dark')).toBe(theme.CHALK)
    expect(theme.noteInkFor('', 'dark')).toBe(theme.CHALK)
  })
})
