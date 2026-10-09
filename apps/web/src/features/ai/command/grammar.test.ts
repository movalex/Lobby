// W3 (wave L, L3-3): the local grammar on a fixed board. Each phrase either resolves to exactly these ops on
// exactly these elements (no call at all), or says why it cannot, or is not understood (null: the palette
// offers AI for it). Negatives include every destructive verb and other languages, which never parse.
import { describe, expect, it } from 'vitest'
import {
  type BoardFacts,
  type FactItem,
  grammar,
  normalizeCommand,
  parseCommand,
  parseTarget,
} from './grammar.ts'

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

/**
 * The board: frames Ideas, Retro and Launch plan; notes in Ideas (two red, one yellow), in Retro (one red, one
 * blue, tagged Finance), loose ones; a shape, a text, two connectors, an image and a file card.
 */
const FACTS: BoardFacts = {
  frames: [
    { id: 'f-ideas', name: 'Ideas' },
    { id: 'f-retro', name: 'Retro' },
    { id: 'f-plan', name: 'Launch plan' },
  ],
  items: [
    item('f-ideas', { kind: 'frame', text: 'Ideas', bounds: box(0, 0, 1000, 800) }),
    item('f-retro', { kind: 'frame', text: 'Retro', bounds: box(1200, 0, 1000, 800) }),
    item('f-plan', { kind: 'frame', text: 'Launch plan', bounds: box(2400, 0, 1000, 800) }),
    item('n1', { color: 'red', frameId: 'f-ideas', text: 'Budget for Q3', bounds: box(10, 10) }),
    item('n2', { color: 'red', frameId: 'f-ideas', text: 'Pricing page', bounds: box(300, 40) }),
    item('n3', { color: 'yellow', frameId: 'f-ideas', text: 'Hire a designer', bounds: box(600, 20) }),
    item('n4', { color: 'red', frameId: 'f-retro', text: 'Too many meetings', bounds: box(1210, 10) }),
    item('n5', {
      color: 'blue',
      frameId: 'f-retro',
      tags: ['Finance'],
      text: 'Cut tooling costs',
      bounds: box(1500, 100),
    }),
    item('n6', { color: 'light-red', text: 'Loose pink note', bounds: box(0, 1000) }),
    item('n7', { color: 'yellow', tags: ['Finance'], text: 'Budget review', bounds: box(300, 1000) }),
    item('s1', { kind: 'shape', color: 'black', bounds: box(0, 1400) }),
    item('t1', { kind: 'text', color: 'black', text: 'Agenda', bounds: box(400, 1400) }),
    item('c1', { kind: 'connector', color: 'black', bounds: box(0, 1700, 300, 2) }),
    item('c2', { kind: 'connector', color: 'red', bounds: box(0, 1800, 300, 2) }),
    item('i1', { kind: 'image', bounds: box(800, 1400) }),
    item('x1', { kind: 'file', text: 'brief.pdf', bounds: box(1100, 1400) }),
  ],
  selection: ['n1', 'n2', 'n3'],
}

type Expect =
  | null
  | { readonly error: RegExp }
  | {
      readonly ops: readonly { readonly op: string; readonly ids: readonly string[] }[]
      readonly find?: boolean
    }

const refs = (...ids: string[]) => ids.map((id) => `shape:${id}`)
const op = (o: string, ids: string[], more: Record<string, unknown> = {}) => ({
  op: o,
  ids: refs(...ids),
  ...more,
})
const ALL_NOTES = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']
const ALL_ITEMS = ['f-ideas', 'f-retro', 'f-plan', ...ALL_NOTES, 's1', 't1', 'c1', 'c2', 'i1', 'x1']

const TABLE: readonly (readonly [string, Expect])[] = [
  // ---- recolour ----
  ['make all red notes yellow', { ops: [op('recolor', ['n1', 'n2', 'n4'], { color: 'yellow' })] }],
  ['Make all the red notes yellow.', { ops: [op('recolor', ['n1', 'n2', 'n4'], { color: 'yellow' })] }],
  ['make the red notes in Ideas yellow', { ops: [op('recolor', ['n1', 'n2'], { color: 'yellow' })] }],
  ['make the red notes in the Ideas frame green', { ops: [op('recolor', ['n1', 'n2'], { color: 'green' })] }],
  ['turn the notes in retro blue', { ops: [op('recolor', ['n4', 'n5'], { color: 'blue' })] }],
  ['colour every note grey', { ops: [op('recolor', ALL_NOTES, { color: 'grey' })] }],
  ['color all notes gray', { ops: [op('recolor', ALL_NOTES, { color: 'grey' })] }],
  ['paint these orange', { ops: [op('recolor', ['n1', 'n2', 'n3'], { color: 'orange' })] }],
  ['make these light red', { ops: [op('recolor', ['n1', 'n2', 'n3'], { color: 'light-red' })] }],
  ['make them purple', { ops: [op('recolor', ['n1', 'n2', 'n3'], { color: 'violet' })] }],
  ['make it pink', { ops: [op('recolor', ['n1', 'n2', 'n3'], { color: 'light-red' })] }],
  [
    'change the colour of the yellow notes to blue',
    { ops: [op('recolor', ['n3', 'n7'], { color: 'blue' })] },
  ],
  ['change the pink notes to light blue', { ops: [op('recolor', ['n6'], { color: 'light-blue' })] }],
  ['please make the notes tagged Finance red', { ops: [op('recolor', ['n5', 'n7'], { color: 'red' })] }],
  ['make #finance notes white', { ops: [op('recolor', ['n5', 'n7'], { color: 'white' })] }],
  ['make the red connectors black', { ops: [op('recolor', ['c2'], { color: 'black' })] }],
  [
    'make everything violet',
    { ops: [op('recolor', [...ALL_NOTES, 's1', 't1', 'c1', 'c2'], { color: 'violet' })] },
  ],
  ['make the selected notes yellow', { ops: [op('recolor', ['n1', 'n2', 'n3'], { color: 'yellow' })] }],
  ['make the notes containing "budget" green', { ops: [op('recolor', ['n1', 'n7'], { color: 'green' })] }],
  [
    'make all red notes on the board yellow',
    { ops: [op('recolor', ['n1', 'n2', 'n4'], { color: 'yellow' })] },
  ],
  ['make the images red', { error: /Nothing here takes a colour/ }],
  ['make the green notes red', { error: /No green notes on this board/ }],
  ['make the notes in Backlog yellow', { error: /No frame on this board is called “backlog”/ }],
  // ---- select, find, zoom ----
  ['select all red notes', { ops: [op('select', ['n1', 'n2', 'n4'])], find: true }],
  ['select all', { ops: [op('select', ALL_ITEMS)], find: true }],
  ['select every frame', { ops: [op('select', ['f-ideas', 'f-retro', 'f-plan'])], find: true }],
  ['select the notes tagged finance', { ops: [op('select', ['n5', 'n7'])], find: true }],
  ['select the connectors', { ops: [op('select', ['c1', 'c2'])], find: true }],
  ['highlight the images', { ops: [op('select', ['i1'])], find: true }],
  ['pick the yellow notes in ideas', { ops: [op('select', ['n3'])], find: true }],
  ['select the notes that say "pricing"', { ops: [op('select', ['n2'])], find: true }],
  ['select notes that are blue', { ops: [op('select', ['n5'])], find: true }],
  [
    'find the red notes',
    { ops: [op('select', ['n1', 'n2', 'n4']), op('zoomTo', ['n1', 'n2', 'n4'])], find: true },
  ],
  ['show me the files', { ops: [op('select', ['x1']), op('zoomTo', ['x1'])], find: true }],
  ['zoom to Retro', { ops: [op('zoomTo', ['f-retro'])], find: true }],
  ['go to the retro frame', { ops: [op('zoomTo', ['f-retro'])], find: true }],
  ['jump to launch', { ops: [op('zoomTo', ['f-plan'])], find: true }],
  ['zoom to the notes in Ideas', { ops: [op('zoomTo', ['n1', 'n2', 'n3'])], find: true }],
  ['select Retro', { ops: [op('select', ['f-retro'])], find: true }],
  ['go to frame Backlog', { error: /No frame on this board is called “backlog”/ }],
  // ---- align, distribute, grid ----
  ['line these up', { ops: [op('align', ['n1', 'n2', 'n3'], { edge: 'middle' })] }],
  ['line up the notes in retro', { ops: [op('align', ['n4', 'n5'], { edge: 'middle' })] }],
  ['line these up in a column', { ops: [op('align', ['n1', 'n2', 'n3'], { edge: 'center' })] }],
  ['align these to the left', { ops: [op('align', ['n1', 'n2', 'n3'], { edge: 'left' })] }],
  ['align the selection top', { ops: [op('align', ['n1', 'n2', 'n3'], { edge: 'top' })] }],
  ['align left', { ops: [op('align', ['n1', 'n2', 'n3'], { edge: 'left' })] }],
  ['align the red notes in ideas to the bottom', { ops: [op('align', ['n1', 'n2'], { edge: 'bottom' })] }],
  ['align these vertically', { ops: [op('align', ['n1', 'n2', 'n3'], { edge: 'middle' })] }],
  ['distribute these horizontally', { ops: [op('distribute', ['n1', 'n2', 'n3'], { axis: 'horizontal' })] }],
  ['space these out evenly', { ops: [op('distribute', ['n1', 'n2', 'n3'], { axis: 'horizontal' })] }],
  [
    'space out the notes in ideas vertically',
    { ops: [op('distribute', ['n1', 'n2', 'n3'], { axis: 'vertical' })] },
  ],
  ['distribute vertically', { ops: [op('distribute', ['n1', 'n2', 'n3'], { axis: 'vertical' })] }],
  ['spread out the notes in retro', { error: /three or more/ }],
  ['arrange these as a grid', { ops: [op('arrangeGrid', ['n1', 'n2', 'n3'])] }],
  ['arrange the notes in retro in a grid', { ops: [op('arrangeGrid', ['n4', 'n5'])] }],
  ['tidy up', { ops: [op('arrangeGrid', ['n1', 'n2', 'n3'])] }],
  ['tidy up the notes in Ideas', { ops: [op('arrangeGrid', ['n1', 'n2', 'n3'])] }],
  ['clean these up', { ops: [op('arrangeGrid', ['n1', 'n2', 'n3'])] }],
  ['put all notes into a grid', { ops: [op('arrangeGrid', ALL_NOTES)] }],
  ['arrange the files as a grid', { error: /two or more/ }],
  // ---- lock, frame, tag ----
  ['lock these', { ops: [op('lock', ['n1', 'n2', 'n3'])] }],
  ['lock all frames', { ops: [op('lock', ['f-ideas', 'f-retro', 'f-plan'])] }],
  ['lock everything in retro', { ops: [op('lock', ['n4', 'n5'])] }],
  ['put these in a frame', { ops: [op('wrapInFrame', ['n1', 'n2', 'n3'], { name: 'Frame' })] }],
  [
    'put these in a new frame called plan b',
    { ops: [op('wrapInFrame', ['n1', 'n2', 'n3'], { name: 'Plan b' })] },
  ],
  ['wrap the finance notes in a frame', null],
  [
    'wrap the notes tagged finance in a frame named Money',
    {
      ops: [op('wrapInFrame', ['n5', 'n7'], { name: 'Money' })],
    },
  ],
  ['frame these as Sprint', { ops: [op('wrapInFrame', ['n1', 'n2', 'n3'], { name: 'Sprint' })] }],
  ['tag these as urgent', { ops: [op('tag', ['n1', 'n2', 'n3'], { tag: 'urgent' })] }],
  ['add the tag Finance to the red notes', { ops: [op('tag', ['n1', 'n2', 'n4'], { tag: 'finance' })] }],
  // ---- not understood: AI's (or nobody's) ----
  ['select the notes about budget', null],
  ['make the notes about pricing yellow', null],
  ['find everything related to hiring', null],
  ['make it pop', null],
  ['make the notes bigger', null],
  ['summarize this board', null],
  ['what did we decide?', null],
  ['group the ideas into themes', null],
  ['zoom to fit', null],
  ['show grid', null],
  ['lock', null],
  ['align', null],
  ['tidy', null],
  ['delete all red notes', null],
  ['remove the yellow notes', null],
  ['erase everything', null],
  ['clear the board', null],
  ['unlock everything', null],
  ['ungroup these', null],
  ['rename the retro frame to review', null],
  ['move these into retro', null],
  ['duplicate the red notes', null],
  ['write a summary note', null],
  ['make all red notes yellow and delete the blue ones', null],
  ['mach alle roten Notizen gelb', null],
  ['rends les notes rouges jaunes', null],
  ['haz amarillas las notas rojas', null],
  ['tutte le note rosse gialle', null],
  ['赤い付箋を黄色にして', null],
  ['выделить все красные заметки', null],
  ['', null],
]

/** A resolution as the table states it (ids sorted within each op). */
function shape(r: ReturnType<typeof grammar>): Expect | 'ok-other' {
  if (r === null) return null
  if (!r.ok) return { error: new RegExp(r.reason) }
  return {
    ops: r.ops.map((o) => ({ ...o, ids: [...o.ids].sort() })),
    ...(r.find ? { find: true } : {}),
  }
}

describe('the local grammar (a table of phrases on a fixed board)', () => {
  it(`has at least 60 phrases, negatives and other languages among them (${TABLE.length})`, () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(60)
    expect(TABLE.filter(([, e]) => e === null).length).toBeGreaterThanOrEqual(20)
  })

  for (const [phrase, want] of TABLE) {
    it(`${JSON.stringify(phrase)} → ${want === null ? 'not understood' : 'error' in want ? 'says why' : want.ops.map((o) => o.op).join('+')}`, () => {
      const got = grammar(phrase, FACTS)
      if (want === null) {
        expect(got).toBeNull()
        return
      }
      if ('error' in want) {
        expect(got?.ok, JSON.stringify(got)).toBe(false)
        if (got && !got.ok) expect(got.reason).toMatch(want.error)
        return
      }
      expect(got?.ok, JSON.stringify(got)).toBe(true)
      const s = shape(got) as { ops: unknown[]; find?: boolean }
      expect(s.ops).toEqual(want.ops.map((o) => ({ ...o, ids: [...o.ids].sort() })))
      expect(s.find ?? false).toBe(want.find ?? false)
    })
  }

  it('says what it will do, in words', () => {
    const r = grammar('make the red notes in Ideas yellow', FACTS)
    expect(r?.ok && r.title).toBe('Make 2 red notes in “Ideas” yellow')
    const z = grammar('zoom to retro', FACTS)
    expect(z?.ok && z.title).toBe('Zoom to frame “Retro”')
    const l = grammar('lock these', FACTS)
    expect(l?.ok && l.title).toBe('Lock 3 selected items')
  })

  it('a deictic phrase with nothing selected asks for a selection', () => {
    const r = grammar('make these yellow', { ...FACTS, selection: [] })
    expect(r?.ok).toBe(false)
    if (r && !r.ok) expect(r.reason).toBe('Select something first.')
  })

  it('splits more than 200 ids into ops of at most 200 (AiCommandOp)', () => {
    const many = Array.from({ length: 450 }, (_, i) =>
      item(`m${i}`, { color: 'red', bounds: box(i * 10, 0) }),
    )
    const r = grammar('make all red notes yellow', { frames: [], items: many, selection: [] })
    expect(r?.ok).toBe(true)
    if (r?.ok) {
      expect(r.ops.map((o) => o.ids.length)).toEqual([200, 200, 50])
      expect(r.ops.every((o) => o.op === 'recolor')).toBe(true)
    }
  })

  it('normalizes politeness, case, curly quotes and closing punctuation; refuses anything over 200 characters', () => {
    expect(normalizeCommand('  Please, MAKE these “Yellow”!! ')).toBe('make these "yellow"')
    expect(normalizeCommand('Could you line these up please?')).toBe('line these up')
    expect(parseCommand(`make these yellow ${'x'.repeat(200)}`)).toBeNull()
  })

  it('targets: deictic, quantified, colour, kind, frame, tag, words; an unknown word is not understood', () => {
    expect(parseTarget('these')).toMatchObject({ selection: true })
    expect(parseTarget('the selected red notes')).toMatchObject({
      selection: true,
      color: 'red',
      kind: 'note',
    })
    expect(parseTarget('all light blue stickies in "launch plan"')).toMatchObject({
      selection: false,
      color: 'light-blue',
      kind: 'note',
      frame: 'launch plan',
    })
    expect(parseTarget('notes with tag finance containing budget')).toMatchObject({
      kind: 'note',
      tag: 'finance',
      text: 'budget',
    })
    expect(parseTarget('the wobbly notes')).toBeNull()
    expect(parseTarget('notes about money')).toBeNull()
  })
})
