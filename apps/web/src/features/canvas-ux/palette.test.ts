import type { TLTheme } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { contrastRatio, hasNotePalette, NOTE_PALETTE, relativeLuminance, withNotePalette } from './palette.ts'

// The 13 colour-style values of @tldraw/tlschema 5.4.2 (DefaultColorStyle.values).
const TLDRAW_COLOR_NAMES = [
  'black',
  'grey',
  'light-violet',
  'violet',
  'blue',
  'light-blue',
  'yellow',
  'orange',
  'green',
  'light-green',
  'light-red',
  'red',
  'white',
]

describe('Draftroom note palette', () => {
  it('has at least 12 colours, each a distinct tldraw colour name with its own label', () => {
    expect(NOTE_PALETTE.length).toBeGreaterThanOrEqual(12)
    expect(new Set(NOTE_PALETTE.map((s) => s.name)).size).toBe(NOTE_PALETTE.length)
    expect(new Set(NOTE_PALETTE.map((s) => s.label)).size).toBe(NOTE_PALETTE.length)
    for (const s of NOTE_PALETTE) expect(TLDRAW_COLOR_NAMES).toContain(s.name)
    expect(NOTE_PALETTE.map((s) => s.name).sort()).toEqual([...TLDRAW_COLOR_NAMES].sort())
  })

  it('meets WCAG AA (4.5:1) for note text on every fill, light and dark', () => {
    for (const s of NOTE_PALETTE) {
      for (const mode of ['light', 'dark'] as const) {
        const ratio = contrastRatio(s[mode].fill, s[mode].text)
        expect({ color: s.label, mode, ok: ratio >= 4.5, ratio: Number(ratio.toFixed(2)) }).toMatchObject({
          ok: true,
        })
      }
    }
  })

  it('uses visibly different fills within each mode', () => {
    for (const mode of ['light', 'dark'] as const) {
      const fills = NOTE_PALETTE.map((s) => s[mode].fill.toLowerCase())
      expect(new Set(fills).size).toBe(fills.length)
    }
  })

  it('does not reuse tldraw’s default note fills (our own palette)', () => {
    const tldrawLight = ['#fce19c', '#8aa3ff', '#6fc896', '#c0cad3', '#9bc4fd', '#98d08a', '#f7a5a1']
    for (const s of NOTE_PALETTE) expect(tldrawLight).not.toContain(s.light.fill.toLowerCase())
  })
})

describe('contrast math', () => {
  it('matches the WCAG reference values', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5)
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
  })
  it('rejects malformed colours', () => {
    expect(() => relativeLuminance('red')).toThrow()
  })
})

describe('withNotePalette', () => {
  const fakeTheme = () => {
    const colorSet = (noteFill: string) =>
      Object.fromEntries(
        TLDRAW_COLOR_NAMES.map((n) => [
          n,
          { solid: '#123456', fill: '#123456', noteFill, noteText: '#000000' },
        ]),
      )
    return {
      id: 'default',
      fontSize: 16,
      lineHeight: 1.35,
      strokeWidth: 2,
      fonts: {},
      colors: {
        light: { text: '#000000', background: '#ffffff', ...colorSet('#fce19c') },
        dark: { text: '#ffffff', background: '#000000', ...colorSet('#2c2c2c') },
      },
    } as unknown as TLTheme
  }

  it('replaces only note fill/text and keeps every other value', () => {
    const before = fakeTheme()
    const snapshot = JSON.stringify(before)
    const after = withNotePalette(before)
    expect(JSON.stringify(before)).toBe(snapshot) // not mutated
    const light = after.colors.light as unknown as Record<string, Record<string, string>>
    const dark = after.colors.dark as unknown as Record<string, Record<string, string>>
    expect(light.black?.noteFill).toBe('#f8e48f')
    expect(light.black?.solid).toBe('#123456')
    expect(dark.blue?.noteFill).toBe('#2f4180')
    expect(dark.blue?.noteText).toBe('#f4f1ea')
    expect((after.colors.light as unknown as Record<string, string>).background).toBe('#ffffff')
    expect(hasNotePalette(before)).toBe(false)
    expect(hasNotePalette(after)).toBe(true)
  })
})
