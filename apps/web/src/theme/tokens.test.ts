// The theme's colour tokens, read from styles.css itself (not a copy): every colour has a dark value,
// and text / focus pairs meet WCAG AA in both themes (PRF-12: "interface text meets WCAG AA in light
// and dark themes"; visible focus rings).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, customProperties, relativeLuminance } from './contrast.ts'

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
const themes = {
  light: customProperties(css, ':root'),
  dark: customProperties(css, ':root[data-theme="dark"]'),
} as const
type Mode = keyof typeof themes

// tldraw 5.4.2's canvas and panel colours (tldraw.css .tl-theme__light / .tl-theme__dark:
// --tl-color-background, --tl-color-panel): our focus rings are also drawn on the canvas and its panels.
const TLDRAW = {
  light: { '--tl-canvas': '#f9fafb', '--tl-panel': '#ffffff' },
  dark: {
    '--tl-canvas': '#101011' /* hsl(240 5% 6.5%) */,
    '--tl-panel': '#202127' /* hsl(235 6.8% 13.5%) */,
  },
} as const

const color = (mode: Mode, token: string): string => {
  const value =
    (themes[mode] as Record<string, string>)[token] ?? (TLDRAW[mode] as Record<string, string>)[token]
  if (!value) throw new Error(`${token} is not defined in the ${mode} theme`)
  return value
}

const SURFACES = [
  '--dr-paper',
  '--dr-surface',
  '--dr-inset',
  '--dr-hover',
  '--dr-chip',
  '--dr-accent-bg',
  '--dr-accent-tint',
  '--dr-note-bg',
]

/** [foreground, backgrounds] that carry text: 4.5:1 (WCAG 1.4.3, normal-size text). */
const TEXT_PAIRS: [string, string[]][] = [
  ['--dr-ink', SURFACES],
  ['--dr-ink-2', SURFACES],
  [
    '--dr-accent-ink',
    ['--dr-paper', '--dr-surface', '--dr-inset', '--dr-hover', '--dr-accent-bg', '--dr-accent-tint'],
  ],
  ['--dr-live', ['--dr-live-bg', '--dr-surface', '--dr-paper']],
  ['--dr-warn', ['--dr-warn-bg', '--dr-surface', '--dr-paper']],
  ['--dr-danger', ['--dr-danger-bg', '--dr-surface', '--dr-paper']],
  ['--dr-on-navy', ['--dr-navy', '--dr-navy-hover']],
  ['--dr-on-danger', ['--dr-danger-fill']],
  ['--dr-on-inverse', ['--dr-inverse']],
  ['--dr-on-amber', ['--dr-amber']],
]

/** Focus rings and meaningful non-text marks: 3:1 against what they sit on (WCAG 1.4.11). */
const UI_PAIRS: [string, string[]][] = [
  [
    '--dr-focus',
    ['--dr-paper', '--dr-surface', '--dr-inset', '--dr-hover', '--dr-accent-bg', '--tl-canvas', '--tl-panel'],
  ],
  // pressed chips, the pressed dock tab and the board card's focus outline are navy
  ['--dr-navy', ['--dr-paper', '--dr-surface']],
  // the pressed star
  ['--dr-amber-ink', ['--dr-surface', '--dr-paper']],
]

function failures(mode: Mode, pairs: [string, string[]][], min: number) {
  const out: string[] = []
  for (const [fg, bgs] of pairs) {
    for (const bg of bgs) {
      const ratio = contrastRatio(color(mode, fg), color(mode, bg))
      if (ratio < min) out.push(`${fg} on ${bg}: ${ratio.toFixed(2)}:1`)
    }
  }
  return out
}

describe('theme tokens (styles.css)', () => {
  it('parses both token blocks', () => {
    expect(themes.light['--dr-paper']).toBe('#f6f4ee')
    expect(themes.dark['--dr-paper']).toMatch(/^#[0-9a-f]{6}$/)
    expect(Object.keys(themes.light).length).toBeGreaterThan(30)
  })

  it('gives every colour token a dark value (and invents none the light theme lacks)', () => {
    const isColour = (v: string) => /#|rgb|hsl|color-mix/.test(v)
    const colourTokens = Object.entries(themes.light)
      .filter(([, v]) => isColour(v))
      .map(([k]) => k)
    expect(colourTokens.length).toBeGreaterThan(30)
    expect(colourTokens.filter((k) => !(k in themes.dark))).toEqual([])
    expect(Object.keys(themes.dark).filter((k) => !(k in themes.light))).toEqual([])
  })

  it('declares plain #rrggbb for every token a contrast pair uses', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const [fg, bgs] of [...TEXT_PAIRS, ...UI_PAIRS]) {
        for (const token of [fg, ...bgs]) expect(color(mode, token)).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  for (const mode of ['light', 'dark'] as const) {
    it(`${mode}: text meets WCAG AA (4.5:1) on every surface it is used on`, () => {
      expect(failures(mode, TEXT_PAIRS, 4.5)).toEqual([])
    })
    it(`${mode}: focus rings and accent marks reach 3:1`, () => {
      expect(failures(mode, UI_PAIRS, 3)).toEqual([])
    })
  }

  it('is actually dark: surfaces darker than text, the page darker than the light one', () => {
    expect(relativeLuminance(color('dark', '--dr-paper'))).toBeLessThan(0.02)
    expect(relativeLuminance(color('dark', '--dr-surface'))).toBeLessThan(
      relativeLuminance(color('dark', '--dr-ink')),
    )
    expect(relativeLuminance(color('dark', '--dr-paper'))).toBeLessThan(
      relativeLuminance(color('dark', '--dr-surface')),
    )
  })

  it('switches the native controls too (color-scheme)', () => {
    expect(css).toMatch(/:root \{[^}]*color-scheme: light;/)
    expect(css).toMatch(/:root\[data-theme="dark"\] \{[^}]*color-scheme: dark;/)
  })
})

describe('contrast math', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
  })
  it('rejects colours it cannot measure', () => {
    expect(() => relativeLuminance('rgb(0 0 0)')).toThrow()
  })
})
