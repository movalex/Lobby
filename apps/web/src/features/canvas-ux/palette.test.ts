// P-012 follow-up: the note colour picker says plain colours (the words the AI and the command palette use), not the
// palette's internal names (Butter, Iris, ...). One shared map: NOTE_PALETTE's `plain`, read by the picker, and by
// the grammar (ai/command/colours.ts), which takes each plain name as a word for its swatch. Stored values unchanged.
import { describe, expect, it } from 'vitest'
import { NOTE_PALETTE, noteColourName } from './palette.ts'

describe('the note colour picker’s plain names', () => {
  it('names the 13 swatches in plain colours, in picker order', () => {
    expect(NOTE_PALETTE.map((s) => [s.name, noteColourName(s.name)])).toEqual([
      ['black', 'Yellow'],
      ['yellow', 'Gold'],
      ['orange', 'Orange'],
      ['light-red', 'Pink'],
      ['red', 'Red'],
      ['light-violet', 'Lavender'],
      ['violet', 'Purple'],
      ['blue', 'Blue'],
      ['light-blue', 'Light blue'],
      ['green', 'Green'],
      ['light-green', 'Light green'],
      ['grey', 'Grey'],
      ['white', 'White'],
    ])
  })

  it('no two swatches share a name, and none is an internal name', () => {
    const plain = NOTE_PALETTE.map((s) => noteColourName(s.name))
    expect(new Set(plain.map((p) => p.toLowerCase())).size).toBe(13)
    for (const s of NOTE_PALETTE) expect(plain, s.label).not.toContain(s.label)
  })

  it('keeps the stored colour values (the names stored on a note, and the fills)', () => {
    expect(NOTE_PALETTE.map((s) => s.name)).toEqual([
      'black',
      'yellow',
      'orange',
      'light-red',
      'red',
      'light-violet',
      'violet',
      'blue',
      'light-blue',
      'green',
      'light-green',
      'grey',
      'white',
    ])
    expect(NOTE_PALETTE[0]?.light.fill).toBe('#f8e48f')
    expect(NOTE_PALETTE[7]?.light.fill).toBe('#a7b7f6')
  })
})
