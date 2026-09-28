import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import { describe, expect, it } from 'vitest'
import { SEARCH_FILTERS } from './search-filter.ts'
import {
  categoryOf,
  countCategories,
  keepOnlyChoices,
  pickCategory,
  type ShapeLite,
  TYPE_CATEGORIES,
} from './select-by-type.ts'

const s = (id: string, type: string, extra: Partial<ShapeLite> = {}): ShapeLite => ({
  id,
  type,
  ancestors: [],
  locked: false,
  ...extra,
})

describe('categories', () => {
  it('are board search’s type filters, notes / images / text / connectors first', () => {
    expect(TYPE_CATEGORIES.map((c) => c.id)).toEqual([
      'notes',
      'images',
      'text',
      'connectors',
      'shapes',
      'frames',
      'files',
    ])
    for (const c of TYPE_CATEGORIES) {
      expect(c.types).toEqual(SEARCH_FILTERS.find((f) => f.id === c.id)?.types)
    }
  })

  it('maps shape types', () => {
    expect(categoryOf('note')).toBe('notes')
    expect(categoryOf('image')).toBe('images')
    expect(categoryOf('video')).toBe('images')
    expect(categoryOf('arrow')).toBe('connectors')
    expect(categoryOf(FILE_CARD_TYPE)).toBe('files')
    expect(categoryOf('group')).toBeNull()
    expect(categoryOf('draw')).toBeNull()
  })
})

describe('pickCategory', () => {
  const page = [
    s('n1', 'note'),
    s('n2', 'note', { ancestors: ['f1'] }),
    s('n3', 'note', { locked: true }),
    s('n4', 'note', { hidden: true }),
    s('f1', 'frame'),
    s('f2', 'frame', { ancestors: ['f1'] }),
    s('i1', 'image', { ancestors: ['g1'] }),
    s('v1', 'video'),
    s('a1', 'arrow'),
    s('t1', 'text'),
    s('g1', 'group'),
  ]

  it('skips locked and hidden shapes, keeps notes inside frames', () => {
    expect(pickCategory(page, 'notes')).toEqual(['n1', 'n2'])
    expect(pickCategory(page, 'images')).toEqual(['i1', 'v1'])
  })

  it('never returns a shape together with a frame around it', () => {
    expect(pickCategory(page, 'frames')).toEqual(['f1'])
  })

  it('counts what can be selected, omitting empty categories', () => {
    expect(countCategories(page)).toEqual([
      { id: 'notes', label: 'Notes', count: 2 },
      { id: 'images', label: 'Images', count: 2 },
      { id: 'text', label: 'Text', count: 1 },
      { id: 'connectors', label: 'Connectors', count: 1 },
      { id: 'frames', label: 'Frames', count: 1 },
    ])
  })
})

describe('keepOnlyChoices', () => {
  it('offers each type in a mixed selection', () => {
    const sel = [s('n1', 'note'), s('i1', 'image'), s('a1', 'arrow')]
    expect(keepOnlyChoices(sel, sel).map((c) => c.id)).toEqual(['notes', 'images', 'connectors'])
  })

  it('offers nothing when the selection is already one type', () => {
    const sel = [s('n1', 'note'), s('n2', 'note')]
    expect(keepOnlyChoices(sel, sel)).toEqual([])
  })

  it('looks inside a selected frame: its notes, not the frame', () => {
    const frame = s('f1', 'frame')
    const inside = [frame, s('n1', 'note', { ancestors: ['f1'] }), s('n2', 'note', { ancestors: ['f1'] })]
    expect(keepOnlyChoices([frame], inside)).toEqual([{ id: 'notes', label: 'Notes', count: 2 }])
    expect(pickCategory(inside, 'notes')).toEqual(['n1', 'n2'])
  })
})
