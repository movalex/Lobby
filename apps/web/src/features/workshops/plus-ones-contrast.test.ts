// W5-49: the "+1" pill on notes (both boards: workshops.css is shared) reads in both themes. Its text and
// fill come from the theme's tokens, read from styles.css and workshops.css themselves (not copies); a raw
// colour is checked as it is. The dark theme's ink on the pill's old near-white fill was 1.03:1.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, customProperties } from '../../theme/contrast.ts'

const tokensCss = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8')
const workshopsCss = readFileSync(new URL('./workshops.css', import.meta.url), 'utf8')
const themes = {
  light: customProperties(tokensCss, ':root'),
  dark: customProperties(tokensCss, ':root[data-theme="dark"]'),
} as const
type Mode = keyof typeof themes

/** The declarations of the rule whose selector is exactly `selector` (comments dropped). */
function declarations(css: string, selector: string): Record<string, string> {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\r\n/g, '\n')
  const head = `\n${selector} {`
  const at = bare.indexOf(head)
  if (at < 0) throw new Error(`no "${selector} {" rule in workshops.css`)
  const body = bare.slice(at + head.length, bare.indexOf('}', at))
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) out[m[1] as string] = (m[2] as string).trim()
  return out
}

const hex2 = (n: number) =>
  Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, '0')

/**
 * A colour value as #rrggbb in `mode`: a token, a hex colour, or `rgb(r g b / a%)` laid over `under` (the
 * pill floats over notes and the canvas, so a see-through fill is checked over white and over black).
 */
function resolve(value: string, mode: Mode, under: string): string {
  const v = value.trim()
  const token = /^var\((--[\w-]+)\)$/.exec(v)
  if (token) {
    const t = (themes[mode] as Record<string, string>)[token[1] as string]
    if (!t) throw new Error(`${token[1]} is not defined in the ${mode} theme`)
    return resolve(t, mode, under)
  }
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase()
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[/,]\s*([\d.]+)(%?))?\s*\)$/.exec(v)
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : Number(rgb[4]) / (rgb[5] ? 100 : 1)
    const base = Number.parseInt(under.slice(1), 16)
    const mix = (c: number, shift: number) => c * a + ((base >> shift) & 255) * (1 - a)
    return `#${hex2(mix(Number(rgb[1]), 16))}${hex2(mix(Number(rgb[2]), 8))}${hex2(mix(Number(rgb[3]), 0))}`
  }
  throw new Error(`cannot read the colour "${value}"`)
}

/** The worst contrast of a rule's text on its fill, over a white and a black backdrop. */
function worst(mode: Mode, text: string, fill: string): number {
  return Math.min(
    ...['#ffffff', '#000000'].map((under) =>
      contrastRatio(resolve(text, mode, under), resolve(fill, mode, under)),
    ),
  )
}

describe('the +1 pill on notes (W5-49)', () => {
  const base = declarations(workshopsCss, '.dr-wk-plusone')
  const pressed = declarations(workshopsCss, '.dr-wk-plusone[aria-pressed="true"]')
  const disabled = declarations(workshopsCss, '.dr-wk-plusone[aria-disabled="true"]')
  const fill = base.background ?? base['background-color'] ?? ''
  const states: [string, string, string][] = [
    ['resting', base.color ?? '', fill],
    ['pressed (mine)', pressed.color ?? '', pressed.background ?? pressed['background-color'] ?? fill],
    ['disabled (a viewer)', disabled.color ?? base.color ?? '', fill],
  ]

  for (const mode of ['light', 'dark'] as const)
    it(`text meets WCAG AA (4.5:1) on its fill in the ${mode} theme, in every state`, () => {
      const low = states
        .map(([state, text, bg]) => ({ state, ratio: worst(mode, text, bg) }))
        .filter((s) => s.ratio < 4.5)
        .map((s) => `${s.state}: ${s.ratio.toFixed(2)}:1`)
      expect(low).toEqual([])
    })
})
