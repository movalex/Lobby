import type { TLRecord } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { richTextFrom, searchBoard } from './deps.ts'
import { highlightParts, matchesFilter, stepIndex, typeLabel } from './search-filter.ts'

const note = (id: string, text: string) =>
  ({
    id: `shape:${id}`,
    typeName: 'shape',
    type: 'note',
    parentId: 'page:page',
    index: 'a1',
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { richText: richTextFrom(text) },
  }) as unknown as TLRecord
const frame = (id: string, name: string) =>
  ({
    id: `shape:${id}`,
    typeName: 'shape',
    type: 'frame',
    parentId: 'page:page',
    index: 'a2',
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { w: 100, h: 100, name },
  }) as unknown as TLRecord

describe('board search filters', () => {
  const records = [note('n1', 'Launch plan for Café'), frame('f1', 'Launch'), note('n2', 'Budget')]

  it('narrows searchBoard hits by type', () => {
    const hits = searchBoard(records, 'launch')
    expect(hits.map((h) => h.shapeId).sort()).toEqual(['shape:f1', 'shape:n1'])
    expect(hits.filter((h) => matchesFilter(h.type, 'notes')).map((h) => h.shapeId)).toEqual(['shape:n1'])
    expect(hits.filter((h) => matchesFilter(h.type, 'frames')).map((h) => h.shapeId)).toEqual(['shape:f1'])
    expect(hits.filter((h) => matchesFilter(h.type, 'all'))).toHaveLength(2)
    expect(matchesFilter('dr-file-card', 'files')).toBe(true)
    expect(matchesFilter('image', 'images')).toBe(true)
  })

  it('labels types in plain words', () => {
    expect(typeLabel('arrow')).toBe('Connector')
    expect(typeLabel('geo')).toBe('Shape')
    expect(typeLabel('something')).toBe('Object')
  })
})

describe('result navigation', () => {
  it('wraps Enter / Shift+Enter', () => {
    expect(stepIndex(-1, 3, 1)).toBe(0)
    expect(stepIndex(-1, 3, -1)).toBe(2)
    expect(stepIndex(2, 3, 1)).toBe(0)
    expect(stepIndex(0, 3, -1)).toBe(2)
    expect(stepIndex(0, 0, 1)).toBe(-1)
  })
})

describe('highlightParts', () => {
  it('marks every term, ignoring case and accents', () => {
    expect(highlightParts('Launch plan for Café', 'cafe PLAN')).toEqual([
      { text: 'Launch ', match: false },
      { text: 'plan', match: true },
      { text: ' for ', match: false },
      { text: 'Café', match: true },
    ])
    expect(highlightParts('abc', '')).toEqual([{ text: 'abc', match: false }])
  })
})
