// W3 (wave M, M3-4, FTU-3): plain-language commands know the colour names people see. "make the yellow notes blue"
// finds the default (Butter) notes, "pink" is Blush and Coral, the replies name colours by the pickers' labels, and a
// colour word that is also a frame's name still goes to the frame.
import { describe, expect, it } from 'vitest'
import { NOTE_PALETTE } from '../../canvas-ux/palette.ts'
import { COLOR_LABELS } from '../../canvas-ux/ported/style-vocabulary.ts'
import { COLOUR_WORDS, colourWord, listWords, PICKER_LABELS } from './colours.ts'
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
    expect(listWords(['Blush'], 'or')).toBe('Blush')
    expect(listWords(['Blush', 'Coral'], 'or')).toBe('Blush or Coral')
    expect(listWords(['Butter', 'Marigold', 'Apricot'], 'and')).toBe('Butter, Marigold and Apricot')
    expect(PICKER_LABELS).toEqual(expect.arrayContaining(['Butter', 'Paper', 'Light red', 'Black']))
  })
})

describe('plain-language commands know the colour names people see (M3-4, FTU-3)', () => {
  it('"make the yellow notes blue" on default notes is six recolours, named by their labels', () => {
    const r = grammar('make the yellow notes blue', DEFAULT_NOTES)
    expect(r?.ok).toBe(true)
    if (!r?.ok) return
    expect(r.ops).toHaveLength(1)
    expect(r.ops[0]).toMatchObject({ op: 'recolor', color: 'blue' })
    expect(ids(r)).toEqual(Array.from({ length: 6 }, (_, i) => `shape:d${i}`).sort())
    // the labels of the pickers (Butter is what the picker calls the default note), never "black" or "yellow"
    expect(r.title).toBe('Make 6 Butter notes Iris')
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
    expect(b.steps[0]?.label).toBe('Make 6 Butter notes Iris')
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

  it('"make the butter notes sky" understands the picker’s own names', () => {
    const r = grammar('make the butter notes sky', DEFAULT_NOTES)
    expect(r?.ok && r.title).toBe('Make 6 Butter notes Sky')
    expect(r?.ok && r.ops[0]).toMatchObject({ op: 'recolor', color: 'light-blue' })
  })

  it('"make all pink notes yellow" on a board without pink says which colours it looked for', () => {
    const r = grammar('make all pink notes yellow', DEFAULT_NOTES)
    expect(r?.ok).toBe(false)
    if (r && !r.ok) expect(r.reason).toBe('No Blush or Coral notes on this board.')
    // one colour: no "or"
    const one = grammar('select the sky notes', DEFAULT_NOTES)
    expect(one?.ok === false && one.reason).toBe('No Sky notes on this board.')
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
    expect(notes?.ok && notes.title).toBe('Select 2 Butter and Marigold notes')
    // a shape’s black is ink, not Butter: "yellow" never picks it, and "black" never picks a note
    const shapes = grammar('select the yellow shapes', board)
    expect(ids(shapes)).toEqual(['shape:x'])
    expect(shapes?.ok && shapes.title).toBe('Select 1 Yellow shape')
    expect(ids(grammar('select the black shapes', board))).toEqual(['shape:k'])
    const blackNotes = grammar('select the black notes', board)
    expect(blackNotes?.ok === false && blackNotes.reason).toBe('No Black notes on this board.')
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
    expect(r.title).toBe('Make 2 items Butter / Yellow')
    // the same stored name for both is one op
    const violet = grammar('make everything violet', board)
    expect(violet?.ok && violet.ops).toHaveLength(1)
  })

  it('ink is no colour of a note: "make the notes black" leaves them as they are, and says so', () => {
    const notes: BoardFacts = { frames: [], items: [item('n', { color: 'red' })], selection: [] }
    const r = grammar('make the red notes black', notes)
    expect(r?.ok).toBe(false)
    if (r && !r.ok) expect(r.reason).toBe('Notes do not come in Black.')
    // shapes and connectors take it; a note beside them is left as it is
    const mixed: BoardFacts = {
      frames: [],
      items: [item('n', { color: 'red' }), item('s', { kind: 'shape', color: 'red' })],
      selection: [],
    }
    const m = grammar('make everything black', mixed)
    expect(m?.ok && m.ops).toEqual([{ op: 'recolor', ids: ['shape:s'], color: 'black' }])
    expect(m?.ok && m.title).toBe('Make 1 item Black')
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
      expect(r?.ok && r.title, s.label).toBe(`Select 1 ${s.label} note`)
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
    expect(colour?.ok && colour.title).toBe('Zoom to 1 Sky item')
    // nothing of either: the same reply as for any colour, not a frame error
    const none = grammar('zoom to sky', { frames: [], items: [], selection: [] })
    expect(none?.ok === false && none.reason).toBe('No Sky items on this board.')
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

  it('no reply names a colour any other way than by a picker label (every colour word, on several boards)', () => {
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
    // a word of the reply that is a stored colour name: it must be one of the pickers' labels, capitalised
    const stored =
      /\b(?:light[ -])?(?:red|blue|green|violet|yellow|orange|grey|gray|black|white|pink|purple)\b/gi
    let replies = 0
    for (const board of boards) {
      for (const phrase of phrases) {
        const r = grammar(phrase, board)
        if (!r) continue
        const text = r.ok ? r.title : r.reason
        replies++
        for (const m of text.matchAll(stored))
          expect(PICKER_LABELS, `${JSON.stringify(phrase)} → ${text}`).toContain(m[0])
      }
    }
    expect(replies).toBeGreaterThan(400)
  })
})
