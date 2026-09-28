// A11Y-11: placeholder text is the only visible hint in several fields (Search boards, Search templates,
// Checkpoint name, the brainstorm Prompt, Invite), so it must meet 4.5:1 in both themes. Read from
// styles.css itself, like theme/tokens.test.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, customProperties } from '../theme/contrast.ts'

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
const themes = {
  light: customProperties(css, ':root'),
  dark: customProperties(css, ':root[data-theme="dark"]'),
}
/** What fields and the chips holding them are drawn on. */
const BACKGROUNDS = ['--dr-surface', '--dr-inset', '--dr-paper', '--dr-hover', '--dr-chip']

describe('A11Y-11: placeholder contrast', () => {
  for (const [mode, tokens] of Object.entries(themes) as [string, Record<string, string>][]) {
    it(`--dr-placeholder is 4.5:1 or more on every field background (${mode})`, () => {
      const fg = tokens['--dr-placeholder']
      expect(fg, `--dr-placeholder in ${mode}`).toBeTruthy()
      for (const bg of BACKGROUNDS) {
        const value = tokens[bg]
        expect(value, bg).toBeTruthy()
        expect(
          contrastRatio(fg as string, value as string),
          `${mode}: placeholder on ${bg}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    })
  }

  it('every placeholder uses the token, fully opaque (Firefox dims it by default)', () => {
    const rule = /(^|\n)::placeholder\s*\{([^}]*)\}/.exec(css)?.[2] ?? ''
    expect(rule).toMatch(/color:\s*var\(--dr-placeholder\)/)
    expect(rule).toMatch(/opacity:\s*1/)
  })
})
