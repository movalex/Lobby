// W5-10 and W5-15 (wave 5, 2C): frame names and outlines that read, and Lobby's dark-mode colours.
import { beforeAll, describe, expect, it } from 'vitest'
import { contrastRatio } from '../../features/a11y/ported/contrast.ts'
import { NOTE_PALETTE } from '../../features/canvas-ux/palette.ts'

// the engine creates its dark-mode cache only in a browser (`typeof window`): stand one in before it loads
;(globalThis as { window?: unknown }).window ??= globalThis
const common = await import('@excalidraw/common')
const theme = await import('./theme.ts')

beforeAll(() => {
  expect(theme.installLobbyEngineTheme()).toBe(true)
})

const dark = (c: string) => common.applyDarkModeFilter(c, true)

describe('W5-10: frames read on the canvas', () => {
  it('frame names are Lobby ink, >= 4.5:1 on the canvas in both modes (was #999999, 2.65:1)', () => {
    const fs = common.FRAME_STYLE as {
      nameColorLightTheme: string
      nameColorDarkTheme: string
      strokeColor: string
    }
    expect(fs.nameColorLightTheme).toBe(theme.INK)
    expect(contrastRatio(fs.nameColorLightTheme, theme.CANVAS_LIGHT)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(fs.nameColorDarkTheme, theme.CANVAS_DARK)).toBeGreaterThanOrEqual(4.5)
  })
  it('frame outlines are >= 3:1 on the canvas in both modes, and the dark canvas is tldraw’s', () => {
    const fs = common.FRAME_STYLE as { strokeColor: string }
    expect(contrastRatio(fs.strokeColor, theme.CANVAS_LIGHT)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(dark(fs.strokeColor), theme.CANVAS_DARK)).toBeGreaterThanOrEqual(3)
    expect(dark(theme.CANVAS_LIGHT)).toBe(theme.CANVAS_DARK)
  })
})

describe('W5-15: dark mode keeps Lobby’s colours', () => {
  it('brand and palette colours get tldraw’s designed dark shades, not an inverted hue', () => {
    expect(dark('#f1ac4b')).toBe('#ffc034') // Ember / yellow (Excalidraw's filter: #874c00)
    expect(dark('#e03131')).toBe('#e03131') // Signal red (filter: #ff8383)
    expect(dark('#ae3ec9')).toBe('#ae3ec9') // violet (filter: #de7ef6)
    expect(dark('#4465e9')).toBe('#4f72fc')
    expect(dark('#F1AC4B')).toBe('#ffc034') // case does not matter
  })
  it('note fills get the palette’s designed dark fills, and every note reads (>= 4.5:1) with the dark ink', () => {
    for (const s of NOTE_PALETTE) {
      const fill = dark(s.light.fill)
      const ink = dark('#1e1e1e')
      expect(contrastRatio(fill, ink), `${s.label}: ${fill} with ${ink}`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(fill, dark(theme.INK)), s.label).toBeGreaterThanOrEqual(4.5)
      if (s.name !== 'white') expect(fill).toBe(s.dark.fill.toLowerCase())
    }
  })
  it('any other explicit colour is drawn as it is; greys and non-hex values follow Excalidraw’s filter', () => {
    expect(dark('#123abc')).toBe('#123abc')
    expect(dark('#7f3f9a80')).toBe('#7f3f9a80')
    expect(theme.lobbyDarkColor('#808080')).toBeNull()
    expect(theme.lobbyDarkColor('transparent')).toBeNull()
    expect(dark('transparent')).toBe(common.applyDarkModeFilter('transparent', true))
    // the engine's default ink becomes Lobby's dark ink
    expect(dark('#1e1e1e')).toBe(theme.CHALK)
  })
  it('light mode is untouched', () => {
    expect(common.applyDarkModeFilter('#f1ac4b', false)).toBe('#f1ac4b')
  })
})
