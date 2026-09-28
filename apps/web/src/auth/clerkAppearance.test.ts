// Clerk's <SignIn> follows the app's light/dark theme: its `appearance.variables` (@clerk/react 6.17.2,
// type `Variables`) are built from our own colour tokens, read here from styles.css itself for both
// themes, as resolved #rrggbb values.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, customProperties } from '../theme/contrast.ts'
import { CLERK_TOKENS, clerkAppearance, LIGHT_FALLBACK, toHex } from './clerkAppearance.ts'

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
const themes = {
  light: customProperties(css, ':root'),
  dark: customProperties(css, ':root[data-theme="dark"]'),
} as const
const HEX = /^#[0-9a-f]{6}$/

describe('toHex', () => {
  it('resolves the colour notations getComputedStyle can hand back to #rrggbb', () => {
    expect(toHex('#1D2027')).toBe('#1d2027')
    expect(toHex('  #fff ')).toBe('#ffffff')
    expect(toHex('#1d2027ff')).toBe('#1d2027')
    expect(toHex('rgb(29 32 39)')).toBe('#1d2027')
    expect(toHex('rgb(29, 32, 39)')).toBe('#1d2027')
    expect(toHex('rgba(29, 32, 39, 1)')).toBe('#1d2027')
    expect(toHex('rgb(29 32 39 / 100%)')).toBe('#1d2027')
  })

  it('refuses what it cannot resolve exactly (the light fallback is used instead)', () => {
    for (const v of [
      '',
      'white',
      'var(--dr-ink)',
      'rgb(0 0 0 / 40%)',
      'rgba(0,0,0,0.5)',
      '#12',
      'rgb(300 0 0)',
    ])
      expect(toHex(v), v).toBeNull()
  })
})

describe('clerkAppearance', () => {
  for (const mode of ['light', 'dark'] as const) {
    const a = clerkAppearance(themes[mode], mode)
    const v = a.variables ?? {}

    it(`${mode}: every variable is a resolved #rrggbb taken from our tokens`, () => {
      for (const [key, value] of Object.entries(v)) expect(value, key).toMatch(HEX)
      expect(v.colorPrimary).toBe(themes[mode]['--dr-navy'])
      expect(v.colorPrimaryForeground).toBe(themes[mode]['--dr-on-navy'])
      expect(v.colorBackground).toBe(themes[mode]['--dr-surface'])
      expect(v.colorForeground).toBe(themes[mode]['--dr-ink'])
      expect(v.colorMutedForeground).toBe(themes[mode]['--dr-ink-2'])
      expect(v.colorInput).toBe(themes[mode]['--dr-inset'])
      expect(v.colorInputForeground).toBe(themes[mode]['--dr-ink'])
      expect(v.colorNeutral).toBe(themes[mode]['--dr-ink'])
      expect(v.colorBorder).toBe(themes[mode]['--dr-line-strong'])
      expect(v.colorRing).toBe(themes[mode]['--dr-focus'])
      expect(v.colorDanger).toBe(themes[mode]['--dr-danger'])
      expect(a.captcha?.theme).toBe(mode)
    })

    it(`${mode}: Clerk's text pairs meet WCAG AA (4.5:1)`, () => {
      const pairs: [string | undefined, string | undefined][] = [
        [v.colorForeground as string, v.colorBackground as string],
        [v.colorMutedForeground as string, v.colorBackground as string],
        [v.colorInputForeground as string, v.colorInput as string],
        [v.colorPrimaryForeground as string, v.colorPrimary as string],
        [v.colorDanger as string, v.colorBackground as string],
        [themes[mode]['--dr-accent-ink'], v.colorBackground as string],
      ]
      for (const [fg, bg] of pairs)
        expect(contrastRatio(fg ?? '', bg ?? ''), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('dark really is dark: Clerk gets the dark surfaces and text, not the light ones', () => {
    const light = clerkAppearance(themes.light, 'light').variables ?? {}
    const dark = clerkAppearance(themes.dark, 'dark').variables ?? {}
    expect(dark.colorBackground).toBe('#1d2027')
    expect(dark.colorForeground).toBe('#ebe8e1')
    expect(light.colorBackground).toBe('#ffffff')
    expect(dark.colorBackground).not.toBe(light.colorBackground)
    expect(dark.colorShadow).toBe('#000000')
  })

  it('links use the accent ink, which stays readable on dark surfaces where the navy fill does not', () => {
    const dark = clerkAppearance(themes.dark, 'dark')
    expect(JSON.stringify(dark.elements)).toContain(themes.dark['--dr-accent-ink'])
    expect(contrastRatio(themes.dark['--dr-navy'] ?? '', themes.dark['--dr-surface'] ?? '')).toBeLessThan(4.5)
  })

  it('an unresolved token falls back to the light value, and the fallback matches styles.css', () => {
    for (const t of CLERK_TOKENS) expect(LIGHT_FALLBACK[t], t).toBe(themes.light[t])
    const v = clerkAppearance({ '--dr-surface': 'var(--missing)' }, 'light').variables ?? {}
    expect(v.colorBackground).toBe(themes.light['--dr-surface'])
    expect(v.colorForeground).toBe(themes.light['--dr-ink'])
  })
})
