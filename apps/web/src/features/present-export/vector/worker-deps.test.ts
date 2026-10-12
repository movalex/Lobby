// Wave N.1: a glyph picture is drawn with the line's own font list first (as the board draws a character its face
// lacks: the next family), then the emoji fonts; generic families unquoted, names quoted, quotes never doubled.
import { describe, expect, it } from 'vitest'
import { pictureFonts } from './worker-deps.ts'

describe('pictureFonts', () => {
  it('the line’s families, then the emoji fonts', () => {
    expect(pictureFonts('Nunito, sans-serif, Segoe UI Emoji')).toBe(
      '"Nunito", sans-serif, "Segoe UI Emoji", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", ' +
        '"Segoe UI Symbol", sans-serif',
    )
    expect(pictureFonts('"Lilita One", ui-sans-serif')).toMatch(
      /^"Lilita One", ui-sans-serif, "Segoe UI Emoji"/,
    )
  })
  it('no list: the emoji fonts alone; a stray quote or backslash never breaks the CSS', () => {
    expect(pictureFonts(undefined)).toBe(pictureFonts(''))
    expect(pictureFonts(undefined).startsWith('"Segoe UI Emoji"')).toBe(true)
    expect(pictureFonts('A"b\\c')).toMatch(/^"Abc", /)
  })
})
