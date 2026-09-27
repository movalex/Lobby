// Draftroom's own sticky-note palette (COL-06): 13 fixed colours with names of our own, applied to
// tldraw 5.4.2's theme (`editor.updateTheme`, TLTheme.colors.{light,dark}[colorName].noteFill/noteText,
// read by NoteShapeUtil when the note's labelColor is the default 'black'). The stored colour names
// stay tldraw's (the schema validates them), so boards remain portable; only the rendered values change.
// Every fill has AA contrast (>= 4.5:1) with its text colour in both modes (see palette.test.ts).

import type { TLTheme } from 'tldraw'

export type NoteColorName =
  | 'black'
  | 'grey'
  | 'light-violet'
  | 'violet'
  | 'blue'
  | 'light-blue'
  | 'yellow'
  | 'orange'
  | 'green'
  | 'light-green'
  | 'light-red'
  | 'red'
  | 'white'

export interface NoteSwatch {
  /** tldraw colour-style value stored on the note. */
  name: NoteColorName
  /** Draftroom's name, shown in the picker. */
  label: string
  light: { fill: string; text: string }
  dark: { fill: string; text: string }
}

const INK = '#1b2330'
const CHALK = '#f4f1ea'

/** Picker order: warm to cool, neutrals last. `black` is tldraw's default note colour (our "Butter"). */
export const NOTE_PALETTE: readonly NoteSwatch[] = [
  {
    name: 'black',
    label: 'Butter',
    light: { fill: '#f8e48f', text: INK },
    dark: { fill: '#5e5222', text: CHALK },
  },
  {
    name: 'yellow',
    label: 'Marigold',
    light: { fill: '#f6c453', text: INK },
    dark: { fill: '#6e4f12', text: CHALK },
  },
  {
    name: 'orange',
    label: 'Apricot',
    light: { fill: '#f4a874', text: INK },
    dark: { fill: '#70401f', text: CHALK },
  },
  {
    name: 'light-red',
    label: 'Blush',
    light: { fill: '#f6bfc4', text: INK },
    dark: { fill: '#6b3740', text: CHALK },
  },
  {
    name: 'red',
    label: 'Coral',
    light: { fill: '#ef8c82', text: INK },
    dark: { fill: '#7d2f28', text: CHALK },
  },
  {
    name: 'light-violet',
    label: 'Lilac',
    light: { fill: '#e3c9f4', text: INK },
    dark: { fill: '#573f6e', text: CHALK },
  },
  {
    name: 'violet',
    label: 'Plum',
    light: { fill: '#c5a4ea', text: INK },
    dark: { fill: '#4a3275', text: CHALK },
  },
  {
    name: 'blue',
    label: 'Iris',
    light: { fill: '#a7b7f6', text: INK },
    dark: { fill: '#2f4180', text: CHALK },
  },
  {
    name: 'light-blue',
    label: 'Sky',
    light: { fill: '#a6d8f3', text: INK },
    dark: { fill: '#1d4f6e', text: CHALK },
  },
  {
    name: 'green',
    label: 'Fern',
    light: { fill: '#93cfa6', text: INK },
    dark: { fill: '#1e5439', text: CHALK },
  },
  {
    name: 'light-green',
    label: 'Pistachio',
    light: { fill: '#cde7a2', text: INK },
    dark: { fill: '#3f5b20', text: CHALK },
  },
  {
    name: 'grey',
    label: 'Stone',
    light: { fill: '#d6d9de', text: INK },
    dark: { fill: '#41474f', text: CHALK },
  },
  {
    name: 'white',
    label: 'Paper',
    light: { fill: '#ffffff', text: INK },
    dark: { fill: '#e6e2d8', text: INK },
  },
]

/** WCAG 2.x relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`)
  const n = Number.parseInt(m[1] as string, 16)
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

/** WCAG contrast ratio (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The theme with Draftroom's note fills/texts. Only noteFill/noteText of the 13 named colours change;
 * everything else (shape colours, UI colours, fonts) is kept. Returns a new object; never mutates.
 */
export function withNotePalette(theme: TLTheme): TLTheme {
  const patch = (mode: 'light' | 'dark') => {
    const colors = { ...theme.colors[mode] } as Record<string, unknown>
    for (const swatch of NOTE_PALETTE) {
      const current = colors[swatch.name]
      if (typeof current !== 'object' || current === null) continue
      colors[swatch.name] = { ...current, noteFill: swatch[mode].fill, noteText: swatch[mode].text }
    }
    return colors as unknown as TLTheme['colors'][typeof mode]
  }
  return { ...theme, colors: { light: patch('light'), dark: patch('dark') } }
}

/** True when the theme already carries this palette (so re-applying is a no-op). */
export function hasNotePalette(theme: TLTheme): boolean {
  return NOTE_PALETTE.every((s) =>
    (['light', 'dark'] as const).every((mode) => {
      const c = (theme.colors[mode] as unknown as Record<string, { noteFill?: string; noteText?: string }>)[
        s.name
      ]
      return c?.noteFill === s[mode].fill && c?.noteText === s[mode].text
    }),
  )
}
