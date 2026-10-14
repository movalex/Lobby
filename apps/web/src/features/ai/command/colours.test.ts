// W3 (wave M, M3-4, FTU-3): plain-language commands know the colour names people see. "make the yellow notes blue"
// finds the default (Butter) notes, "pink" is Blush and Coral, and a colour word that is also a frame's name still goes
// to the frame. P-012 (wave P): the replies say the colours in the person's own words ("Make 6 yellow notes blue"),
// never the palette's internal names (Butter, Iris).
import { describe, expect, it } from 'vitest'
import { NOTE_PALETTE, noteColourName } from '../../canvas-ux/palette.ts'
import { COLOR_LABELS } from '../../canvas-ux/ported/style-vocabulary.ts'
import { COLOUR_WORDS, colourWord, destinationIn, listWords } from './colours.ts'
import { applyCompiled, compileCommand } from './compile.ts'
import { boardFacts } from './facts.ts'
import { type BoardFacts, type FactItem, grammar } from './grammar.ts'
import { fakeBoard, note, updatedIds } from './test-kit.ts'

const box = (x: number, y: number, w = 200, h = 200) => ({ x, y, w, h })
const item = (id: string, over: Partial<FactItem>): FactItem => ({
  id,
  kind: 'note',
  color: null,
  frameId: null,
  tags: [],
  text: '',
  bounds: box(0, 0),
  ...over,
})
const ids = (r: ReturnType<typeof grammar>) => (r?.ok ? r.ops.flatMap((o) => [...o.ids]).sort() : [])

/** Six default notes: Butter, which Lobby stores as `black` (the colour name of tldraw's default note). */
const DEFAULT_NOTES: BoardFacts = {
  frames: [],
  items: Array.from({ length: 6 }, (_, i) =>
    item(`d${i}`, { color: 'black', text: `Note ${i}`, bounds: box(i * 250, 0) }),
  ),
  selection: [],
}

describe('the colour words', () => {
  it('are generated from the picker: every swatch label is a word for exactly its swatch', () => {
    for (const s of NOTE_PALETTE) {
      const w = colourWord(s.label.toLowerCase())
      expect(w, s.label).not.toBeNull()
      expect(w?.note, s.label).toEqual([s.name])
      // a label that is no stroke colour ("Butter") names none
      if (!(s.label.toLowerCase() in { grey: 1, white: 1 })) expect(w?.stroke, s.label).toEqual([])
    }
  })

  it('include the hue families with their swatches in picker order, and the older names', () => {
    expect(colourWord('yellow')).toMatchObject({ note: ['black', 'yellow'], stroke: ['yellow'] })
    expect(colourWord('pink')).toMatchObject({ note: ['light-red', 'red'] })
    expect(colourWord('purple')).toMatchObject({ note: ['violet', 'light-violet'] })
    expect(colourWord('blue')).toMatchObject({ note: ['blue', 'light-blue'] })
    expect(colourWord('green')).toMatchObject({ note: ['green', 'light-green'] })
    expect(colourWord('light red')).toMatchObject({ note: ['light-red'], stroke: ['light-red'] })
    expect(colourWord('lime')).toMatchObject({ note: ['light-green'] })
    expect(colourWord('gray')).toMatchObject({ note: ['grey'], stroke: ['grey'] })
    // ink is no colour of a note
    expect(colourWord('black')).toMatchObject({ note: [], stroke: ['black'] })
    expect(colourWord('chartreuse')).toBeNull()
  })

  it('are listed longest first (a pattern must try "light blue" before "blue")', () => {
    const words = COLOUR_WORDS.map((w) => w.word)
    expect(words.indexOf('light blue')).toBeLessThan(words.indexOf('blue'))
    expect(words.indexOf('sky blue')).toBeLessThan(words.indexOf('sky'))
    expect(new Set(words).size).toBe(words.length)
  })

  it('tell a list of labels in words', () => {
    expect(listWords(['pink'], 'or')).toBe('pink')
    expect(listWords(['pink', 'red'], 'or')).toBe('pink or red')
    expect(listWords(['notes', 'shapes', 'text'], 'and')).toBe('notes, shapes and text')
  })
})

describe('plain-language commands know the colour names people see (M3-4, FTU-3)', () => {
  it('"make the yellow notes blue" on default notes is six recolours, in the words the person typed', () => {
    const r = grammar('make the yellow notes blue', DEFAULT_NOTES)
    expect(r?.ok).toBe(true)
    if (!r?.ok) return
    expect(r.ops).toHaveLength(1)
    expect(r.ops[0]).toMatchObject({ op: 'recolor', color: 'blue' })
    expect(ids(r)).toEqual(Array.from({ length: 6 }, (_, i) => `shape:d${i}`).sort())
    // P-012: never the palette's own names (Butter, Iris) nor the stored ones ("black")
    expect(r.title).toBe('Make 6 yellow notes blue')
  })

  it('on a real board of six default notes it compiles to six recolours in one undo step', () => {
    const BUTTER = NOTE_PALETTE.find((s) => s.name === 'black')?.light.fill
    const b = fakeBoard(
      Array.from({ length: 6 }, (_, i) => note(`d${i}`, { x: i * 250, backgroundColor: BUTTER })).flat(),
    )
    const r = grammar('make the yellow notes blue', boardFacts(b.canvas))
    expect(r?.ok).toBe(true)
    if (!r?.ok) return
    const c = compileCommand(b.canvas, r.ops, 'do')
    applyCompiled(b.canvas, c, r.title)
    expect(b.steps).toHaveLength(1)
    expect(b.steps[0]?.label).toBe('Make 6 yellow notes blue')
    expect(
      updatedIds(b.steps[0])
        .filter((id) => !id.endsWith('-label'))
        .sort(),
    ).toEqual(Array.from({ length: 6 }, (_, i) => `d${i}`))
    const irisFill = NOTE_PALETTE.find((s) => s.name === 'blue')?.light.fill
    expect(b.steps[0]?.ops.find((o) => o[0] === 'update' && o[1] === 'd3')?.[2]).toMatchObject({
      backgroundColor: irisFill,
    })
  })

  it('"make the butter notes sky" understands the picker’s own names, and says them as typed', () => {
    const r = grammar('make the butter notes sky', DEFAULT_NOTES)
    expect(r?.ok && r.title).toBe('Make 6 butter notes sky')
    expect(r?.ok && r.ops[0]).toMatchObject({ op: 'recolor', color: 'light-blue' })
  })

  it('"make all pink notes yellow" on a board without pink says which colours it looked for', () => {
    const r = grammar('make all pink notes yellow', DEFAULT_NOTES)
    expect(r?.ok).toBe(false)
    if (r && !r.ok) expect(r.reason).toBe('No pink notes on this board.')
    // a word names one colour: no "or"
    const one = grammar('select the sky notes', DEFAULT_NOTES)
    expect(one?.ok === false && one.reason).toBe('No sky notes on this board.')
  })

  it('a family on the target side matches every swatch of it; the reply names the ones found', () => {
    const board: BoardFacts = {
      frames: [],
      items: [
        item('b', { color: 'black' }),
        item('m', { color: 'yellow' }),
        item('a', { color: 'orange' }),
        item('x', { kind: 'shape', color: 'yellow' }),
        item('k', { kind: 'shape', color: 'black' }),
      ],
      selection: [],
    }
    const notes = grammar('select the yellow notes', board)
    expect(ids(notes)).toEqual(['shape:b', 'shape:m'])
    expect(notes?.ok && notes.title).toBe('Select 2 yellow notes')
    // a shape’s black is ink, not Butter: "yellow" never picks it, and "black" never picks a note
    const shapes = grammar('select the yellow shapes', board)
    expect(ids(shapes)).toEqual(['shape:x'])
    expect(shapes?.ok && shapes.title).toBe('Select 1 yellow shape')
    expect(ids(grammar('select the black shapes', board))).toEqual(['shape:k'])
    const blackNotes = grammar('select the black notes', board)
    expect(blackNotes?.ok === false && blackNotes.reason).toBe('No black notes on this board.')
  })

  it('a family as a destination is its first swatch, per kind: Butter for a note, the yellow stroke for a shape', () => {
    const board: BoardFacts = {
      frames: [],
      items: [item('n', { color: 'red' }), item('s', { kind: 'shape', color: 'red' })],
      selection: [],
    }
    const r = grammar('make everything yellow', board)
    expect(r?.ok).toBe(true)
    if (!r?.ok) return
    expect(r.ops).toEqual([
      { op: 'recolor', ids: ['shape:n'], color: 'black' },
      { op: 'recolor', ids: ['shape:s'], color: 'yellow' },
    ])
    expect(r.title).toBe('Make 2 items yellow')
    // the same stored name for both is one op
    const violet = grammar('make everything violet', board)
    expect(violet?.ok && violet.ops).toHaveLength(1)
  })

  it('ink is no colour of a note: "make the notes black" leaves them as they are, and says so', () => {
    const notes: BoardFacts = { frames: [], items: [item('n', { color: 'red' })], selection: [] }
    const r = grammar('make the red notes black', notes)
    expect(r?.ok).toBe(false)
    if (r && !r.ok) expect(r.reason).toBe('Notes do not come in black.')
    // shapes and connectors take it; a note beside them is left as it is
    const mixed: BoardFacts = {
      frames: [],
      items: [item('n', { color: 'red' }), item('s', { kind: 'shape', color: 'red' })],
      selection: [],
    }
    const m = grammar('make everything black', mixed)
    expect(m?.ok && m.ops).toEqual([{ op: 'recolor', ids: ['shape:s'], color: 'black' }])
    expect(m?.ok && m.title).toBe('Make 1 item black')
  })

  it('every picker label is a word, and finds exactly its own swatch', () => {
    for (const s of NOTE_PALETTE) {
      const board: BoardFacts = {
        frames: [],
        items: NOTE_PALETTE.map((o) => item(o.name === s.name ? 'mine' : `o-${o.name}`, { color: o.name })),
        selection: [],
      }
      const r = grammar(`select the ${s.label.toLowerCase()} notes`, board)
      expect(ids(r), s.label).toEqual(['shape:mine'])
      expect(r?.ok && r.title, s.label).toBe(`Select 1 ${s.label.toLowerCase()} note`)
    }
  })

  it('a word that is a colour and a frame’s name goes to the frame first; a board without one takes the colour', () => {
    const withFrame: BoardFacts = {
      frames: [{ id: 'f-sky', name: 'Sky' }],
      items: [item('f-sky', { kind: 'frame', text: 'Sky' }), item('n', { color: 'light-blue' })],
      selection: [],
    }
    const frame = grammar('zoom to sky', withFrame)
    expect(frame?.ok && frame.title).toBe('Zoom to frame “Sky”')
    const colour = grammar('zoom to sky', { frames: [], items: withFrame.items.slice(1), selection: [] })
    expect(colour?.ok && colour.title).toBe('Zoom to 1 sky item')
    // nothing of either: the same reply as for any colour, not a frame error
    const none = grammar('zoom to sky', { frames: [], items: [], selection: [] })
    expect(none?.ok === false && none.reason).toBe('No sky items on this board.')
  })

  it('a frame found only because the words were a guess is marked, so the palette can rank it under a command', () => {
    const board: BoardFacts = {
      frames: [{ id: 'f', name: 'Grid ideas' }],
      items: [item('f', { kind: 'frame', text: 'Grid ideas' })],
      selection: [],
    }
    expect(grammar('show grid', board)).toMatchObject({ ok: true, guess: true })
    // named outright ("the grid ideas frame"), it is not a guess
    const named = grammar('show the grid ideas frame', board)
    expect(named?.ok).toBe(true)
    expect(named?.ok && named.guess).toBeUndefined()
  })

  it('P-012: no reply names a palette colour the person did not say (every colour word, on several boards)', () => {
    const words = [...NOTE_PALETTE.map((s) => s.label.toLowerCase()), ...COLOUR_WORDS.map((w) => w.word)]
    const everything: BoardFacts = {
      frames: [{ id: 'f', name: 'Retro' }],
      items: [
        item('f', { kind: 'frame', text: 'Retro' }),
        ...NOTE_PALETTE.map((s, i) => item(`n-${s.name}`, { color: s.name, bounds: box(i * 250, 0) })),
        ...(Object.keys(COLOR_LABELS) as (keyof typeof COLOR_LABELS)[]).flatMap((c, i) => [
          item(`s-${c}`, { kind: 'shape', color: c, bounds: box(i * 250, 400) }),
          item(`c-${c}`, { kind: 'connector', color: c, bounds: box(i * 250, 800, 200, 2) }),
        ]),
      ],
      selection: [],
    }
    const boards: BoardFacts[] = [DEFAULT_NOTES, everything, { frames: [], items: [], selection: [] }]
    const phrases = words.flatMap((w) => [
      `make the ${w} notes blue`,
      `make all ${w} notes yellow`,
      `select every ${w} note`,
      `find the ${w} shapes`,
      `make the ${w} connectors black`,
      `make everything ${w}`,
      `lock the ${w} notes`,
      `tag the ${w} notes as later`,
      `zoom to ${w}`,
    ])
    // the palette's own names (Butter, Iris…): only when the phrase said them itself; and no colour is capitalised
    const swatches = NOTE_PALETTE.map((s) => s.label)
    const capitalised =
      /\b(?:Light )?(?:Red|Blue|Green|Violet|Yellow|Orange|Grey|Gray|Black|White|Pink|Purple)\b/
    let replies = 0
    for (const board of boards) {
      for (const phrase of phrases) {
        const r = grammar(phrase, board)
        if (!r) continue
        const text = r.ok ? r.title : r.reason
        replies++
        const said = phrase.toLowerCase()
        for (const name of swatches)
          if (new RegExp(`\\b${name}\\b`, 'i').test(text))
            expect(said, `${JSON.stringify(phrase)} → ${text}`).toContain(name.toLowerCase())
        expect(text, `${JSON.stringify(phrase)} → ${text}`).not.toMatch(capitalised)
      }
    }
    expect(replies).toBeGreaterThan(400)
  })
})

describe('P-012: the picker’s plain names are the grammar’s words', () => {
  it('every swatch’s plain name is a colour word that, as a destination, is that very swatch', () => {
    for (const s of NOTE_PALETTE) {
      const w = colourWord(noteColourName(s.name).toLowerCase())
      expect(w, noteColourName(s.name)).not.toBeNull()
      expect(w ? destinationIn(w, 'note') : null, noteColourName(s.name)).toBe(s.name)
    }
  })
})
