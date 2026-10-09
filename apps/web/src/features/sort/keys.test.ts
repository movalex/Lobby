// L8-1: the grouping of each sort key (the pure part): colours in palette order, authors by name with the
// anonymous ones last, a note's first tag in the board's order, votes with ties and the "0 votes" column, and
// no revealed vote (the option is unavailable).
import { describe, expect, it } from 'vitest'
import { NOTE_PALETTE } from '../canvas-ux/palette.ts'
import {
  ANONYMOUS,
  groupNotes,
  NO_VOTES,
  noteColourName,
  OTHER_COLOURS,
  type SortContext,
  type SortNote,
  sortKeyProblem,
  UNTAGGED,
} from './keys.ts'

const fillOf = (name: string) => NOTE_PALETTE.find((s) => s.name === name)?.light.fill ?? '#123456'

const note = (id: string, over: Partial<SortNote> = {}): SortNote => ({
  id,
  fill: fillOf('black'),
  author: null,
  tags: [],
  ...over,
})

const ctx = (over: Partial<SortContext> = {}): SortContext => ({
  names: new Map(),
  tagOrder: [],
  votes: null,
  ...over,
})

const summary = (g: ReturnType<typeof groupNotes>) => g?.map((x) => [x.label, [...x.ids]])

describe('sort by colour', () => {
  it('makes a column per colour in use, in the palette’s order, named as the palette names them', () => {
    const notes = [
      note('a', { fill: fillOf('light-blue') }),
      note('b', { fill: fillOf('black') }),
      note('c', { fill: fillOf('light-blue') }),
      note('d', { fill: fillOf('red') }),
      note('e', { fill: fillOf('black') }),
    ]
    expect(summary(groupNotes('colour', notes, ctx()))).toEqual([
      ['Butter', ['b', 'e']],
      ['Coral', ['d']],
      ['Sky', ['a', 'c']],
    ])
  })

  it('puts a fill outside the palette under "Other colours", last, and matches fills in any case', () => {
    const notes = [
      note('a', { fill: '#123456' }),
      note('b', { fill: fillOf('grey').toUpperCase() }),
      note('c', { fill: null }),
    ]
    expect(summary(groupNotes('colour', notes, ctx()))).toEqual([
      ['Stone', ['b']],
      [OTHER_COLOURS, ['a', 'c']],
    ])
    expect(noteColourName('#123456')).toBeNull()
    expect(noteColourName(undefined)).toBeNull()
  })

  it('is deterministic and keeps the order the notes came in', () => {
    const notes = ['n3', 'n1', 'n2'].map((id) => note(id))
    expect(groupNotes('colour', notes, ctx())).toEqual(groupNotes('colour', [...notes], ctx()))
    expect(groupNotes('colour', notes, ctx())?.[0]?.ids).toEqual(['n3', 'n1', 'n2'])
  })

  it('gives nothing for no notes', () => {
    expect(groupNotes('colour', [], ctx())).toEqual([])
  })
})

describe('sort by author', () => {
  const ann = { uid: 'usr_ann', name: 'Ann (at the time)' }
  const bo = { uid: 'usr_bo', name: 'Bo' }

  it('makes a column per person by name, and the notes nobody is credited with "Anonymous", last', () => {
    const notes = [
      note('a', { author: bo }),
      note('b', { author: null }),
      note('c', { author: ann }),
      note('d', { author: bo }),
      note('e', { author: null }),
    ]
    const names = new Map([['usr_ann', 'Ann Archer']])
    expect(summary(groupNotes('author', notes, ctx({ names })))).toEqual([
      ['Ann Archer', ['c']],
      ['Bo', ['a', 'd']],
      [ANONYMOUS, ['b', 'e']],
    ])
  })

  it('falls back to the name stamped on the note when the roster does not know the person', () => {
    expect(summary(groupNotes('author', [note('a', { author: ann })], ctx()))).toEqual([
      ['Ann (at the time)', ['a']],
    ])
  })

  it('keeps two people with the same name apart, and calls a nameless author "Unknown"', () => {
    const notes = [
      note('a', { author: { uid: 'usr_1', name: 'Sam' } }),
      note('b', { author: { uid: 'usr_2', name: 'Sam' } }),
      note('c', { author: { uid: 'usr_3', name: '  ' } }),
    ]
    const g = groupNotes('author', notes, ctx())
    expect(g?.map((x) => x.label)).toEqual(['Sam', 'Sam', 'Unknown'])
    expect(g?.map((x) => x.ids.length)).toEqual([1, 1, 1])
  })

  it('shows only "Anonymous" when every note is anonymous (a revealed private brainstorm)', () => {
    const g = groupNotes('author', [note('a'), note('b')], ctx())
    expect(summary(g)).toEqual([[ANONYMOUS, ['a', 'b']]])
  })
})

describe('sort by tag', () => {
  const t = (key: string, name = key) => ({ key, name })
  const order = ['launch', 'ops', 'ux']

  it('groups a note by its first tag in the board’s order, and "Untagged" comes last', () => {
    const notes = [
      note('a', { tags: [t('ux', 'UX')] }),
      note('b', { tags: [t('ops', 'Ops'), t('launch', 'Launch')] }),
      note('c'),
      note('d', { tags: [t('launch', 'Launch')] }),
    ]
    expect(summary(groupNotes('tag', notes, ctx({ tagOrder: order })))).toEqual([
      ['Launch', ['b', 'd']],
      ['UX', ['a']],
      [UNTAGGED, ['c']],
    ])
  })

  it('a note with several tags is in one column only', () => {
    const notes = [note('a', { tags: [t('ux'), t('ops'), t('launch')] })]
    const g = groupNotes('tag', notes, ctx({ tagOrder: order }))
    expect(g).toHaveLength(1)
    expect(g?.[0]?.key).toBe('tag:launch')
  })

  it('puts a tag the board does not list after the listed ones, by name', () => {
    const notes = [
      note('a', { tags: [t('zeta', 'Zeta')] }),
      note('b', { tags: [t('alpha', 'Alpha')] }),
      note('c', { tags: [t('ops', 'Ops')] }),
    ]
    expect(summary(groupNotes('tag', notes, ctx({ tagOrder: order })))?.map((x) => x[0])).toEqual([
      'Ops',
      'Alpha',
      'Zeta',
    ])
  })
})

describe('sort by votes', () => {
  const votes = new Map([
    ['a', 5],
    ['b', 3],
    ['c', 3],
    ['d', 1],
  ])

  it('makes a column per count, most votes first, ties sharing a column, then "0 votes"', () => {
    const notes = ['e', 'b', 'a', 'c', 'f', 'd'].map((id) => note(id))
    expect(summary(groupNotes('votes', notes, ctx({ votes })))).toEqual([
      ['5 votes', ['a']],
      ['3 votes', ['b', 'c']],
      ['1 vote', ['d']],
      [NO_VOTES, ['e', 'f']],
    ])
  })

  it('counts a note the vote lists with 0 votes as having none', () => {
    const g = groupNotes('votes', [note('x')], ctx({ votes: new Map([['x', 0]]) }))
    expect(summary(g)).toEqual([[NO_VOTES, ['x']]])
  })

  it('is unavailable with no revealed vote, and says why', () => {
    expect(groupNotes('votes', [note('a')], ctx({ votes: null }))).toBeNull()
    expect(sortKeyProblem('votes', { votes: null })).toBe('Reveal a vote first')
    expect(sortKeyProblem('votes', { votes })).toBeNull()
    expect(sortKeyProblem('colour', { votes: null })).toBeNull()
  })

  it('still makes a group for a vote nobody voted in (every note under "0 votes")', () => {
    const g = groupNotes('votes', [note('a'), note('b')], ctx({ votes: new Map() }))
    expect(summary(g)).toEqual([[NO_VOTES, ['a', 'b']]])
  })
})
