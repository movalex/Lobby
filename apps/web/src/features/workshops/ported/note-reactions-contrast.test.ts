// OWNER: 3f (wave N, WS3; N3-3). The reaction row and its picker (workshops-ported.css, ./NoteReactions.tsx) read in
// both themes: every text colour meets WCAG AA (4.5:1) on the fill it sits on, in every state. Colours come from the
// theme tokens in styles.css (read here, not copied), as the +1 pill's check does (../plus-ones-contrast.test.ts).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, customProperties } from '../../../theme/contrast.ts'

const tokensCss = readFileSync(new URL('../../../styles.css', import.meta.url), 'utf8')
const css = readFileSync(new URL('./workshops-ported.css', import.meta.url), 'utf8')
const themes = {
  light: customProperties(tokensCss, ':root'),
  dark: customProperties(tokensCss, ':root[data-theme="dark"]'),
} as const
type Mode = keyof typeof themes

interface Rule {
  selectors: string[]
  body: Record<string, string>
}

/** The rules of the file, in order, outside any @media block (comments dropped). */
function rules(source: string): Rule[] {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Rule[] = []
  let depth = 0
  let head = ''
  let body = ''
  for (const ch of bare) {
    if (ch === '{') {
      depth++
      if (depth === 1) continue
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        const selectors = head
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const decl: Record<string, string> = {}
        // a block with rules inside (@media, @keyframes) has no direct declarations to read here
        if (!body.includes('{'))
          for (const m of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g))
            decl[m[1] as string] = (m[2] as string).trim()
        if (!head.trim().startsWith('@') && !body.includes('{')) out.push({ selectors, body: decl })
        head = ''
        body = ''
        continue
      }
    }
    if (depth === 0) head += ch
    else body += ch
  }
  return out
}

const ALL = rules(css)

/** What applies to an element matched by every selector of `chain`, later rules over earlier ones. */
function computed(...chain: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const selector of chain) {
    const hits = ALL.filter((r) => r.selectors.includes(selector))
    if (hits.length === 0) throw new Error(`no rule for "${selector}" in workshops-ported.css`)
    for (const h of hits) Object.assign(out, h.body)
  }
  return out
}

const hex2 = (n: number) =>
  Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, '0')

/** A colour value as #rrggbb in `mode`: a token, a hex colour, or rgb(r g b / a%) laid over `under`. */
function resolve(value: string, mode: Mode, under: string): string {
  const v = value.trim()
  const token = /^var\((--[\w-]+)\)$/.exec(v)
  if (token) {
    const t = (themes[mode] as Record<string, string>)[token[1] as string]
    if (!t) throw new Error(`${token[1]} is not defined in the ${mode} theme`)
    return resolve(t, mode, under)
  }
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase()
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[/,]\s*([\d.]+)(%?))?\s*\)$/.exec(v)
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : Number(rgb[4]) / (rgb[5] ? 100 : 1)
    const base = Number.parseInt(under.slice(1), 16)
    const mix = (c: number, shift: number) => c * a + ((base >> shift) & 255) * (1 - a)
    return `#${hex2(mix(Number(rgb[1]), 16))}${hex2(mix(Number(rgb[2]), 8))}${hex2(mix(Number(rgb[3]), 0))}`
  }
  throw new Error(`cannot read the colour "${value}"`)
}

const fillOf = (d: Record<string, string>) => d.background ?? d['background-color'] ?? ''

/** [state, text colour, fill] for every pair the row and the picker draw. */
const PAIRS: [string, Record<string, string>, string?][] = [
  ['chip', computed('.dr-wk-nr__chip')],
  ['chip, mine', computed('.dr-wk-nr__chip', '.dr-wk-nr__chip[data-mine="true"]')],
  ['add button', computed('.dr-wk-nr__add')],
  ['add button, hovered', computed('.dr-wk-nr__add', '.dr-wk-nr__add:hover')],
  ['names tooltip', computed('.dr-wk-nr__tip')],
  ['picker text', computed('.dr-wk-nr-picker')],
  [
    'picker emoji, pressed',
    {
      ...computed('.dr-wk-nr-picker__emoji', '.dr-wk-nr-picker__emoji[aria-pressed="true"]'),
      // color: inherit, from the picker
      color: computed('.dr-wk-nr-picker').color ?? '',
    },
  ],
  ['clear button', computed('.dr-wk-nr-picker__clear')],
  ['close button', computed('.dr-wk-nr-picker__close')],
  ['phone sheet heading', computed('.dr-wk-nr-picker__head'), fillOf(computed('.dr-wk-nr-picker'))],
]

describe('the reaction row and picker read in both themes (N3-3)', () => {
  for (const mode of ['light', 'dark'] as const)
    it(`text meets WCAG AA (4.5:1) on its fill in the ${mode} theme, in every state`, () => {
      const low: string[] = []
      for (const [state, d, under] of PAIRS) {
        const fill = under ?? fillOf(d)
        const text = d.color
        if (!text || !fill) throw new Error(`${state}: no colour or no fill (${text}, ${fill})`)
        // floating over notes and the canvas: a see-through fill is checked over white and over black
        const worst = Math.min(
          ...['#ffffff', '#000000'].map((bg) =>
            contrastRatio(resolve(text, mode, bg), resolve(fill, mode, bg)),
          ),
        )
        if (worst < 4.5) low.push(`${state}: ${worst.toFixed(2)}:1`)
      }
      expect(low).toEqual([])
    })

  it('the chips are at least 24 px tall, and bigger for a finger (WCAG 2.5.8)', () => {
    expect(computed('.dr-wk-nr__chip').height).toBe('24px')
    const touch = css.slice(css.indexOf('@media (pointer: coarse)'))
    expect(touch).toMatch(/\.dr-wk-nr__chip,\s*\.dr-wk-nr__add\s*\{[^}]*height:\s*32px/)
  })

  it('the phone sheet’s buttons are at least 44 px', () => {
    expect(computed('.dr-wk-nr-picker--sheet .dr-wk-nr-picker__clear')['min-height']).toBe('44px')
    expect(
      Number.parseInt(computed('.dr-wk-nr-picker--sheet .dr-wk-nr-picker__emoji').width ?? '0', 10),
    ).toBeGreaterThanOrEqual(44)
  })
})
