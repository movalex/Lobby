import { searchBoard } from '@draftroom/board-ops'
import {
  arrow,
  fileCard,
  frame,
  geo,
  image,
  imageAsset,
  note,
  PAGE,
  page,
  sid,
  validateAll,
} from '@draftroom/board-ops/test-fixtures'
import { shapeTagMetaKey, type TagDef } from '@draftroom/contracts'
import type { TLRecord } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { boardTagMap } from './model.ts'
import { parseTagQuery, searchBoardWithTags, textOfQuery } from './search.ts'

const T = (key: string, name: string, color: TagDef['color'] = 'blue'): TagDef => ({ key, name, color })
const tagsMeta = (...tags: TagDef[]) =>
  Object.fromEntries(tags.map((t) => [shapeTagMetaKey(t.key), { name: t.name, color: t.color }]))
const RESEARCH = T('research', 'Research')
const IDEA = T('idea', 'Idea', 'green')
const USER_RESEARCH = T('user-research', 'User research', 'violet')

const records: TLRecord[] = [
  page(PAGE, 'Page 1'),
  frame('f', 'Discovery', { x: 1000, y: 0 }),
  note('n1', 'Interview with Dana', { x: 0, y: 400, meta: tagsMeta(RESEARCH) }),
  note('n2', 'Checkout is slow', { x: 0, y: 0, meta: tagsMeta(RESEARCH, IDEA) }),
  note('n3', 'Research budget', { x: 500, y: 0 }), // the word, no tag
  note('n4', '', { x: 20, y: 20, parentId: sid('f'), meta: tagsMeta(USER_RESEARCH) }), // page y = 20
  fileCard('c1', 'survey.pdf', { x: 900, y: 900, meta: tagsMeta(IDEA) }),
  arrow('g1', 'Research', { x: 0, y: 900, meta: tagsMeta(RESEARCH) }), // arrows carry no tags
]
const board = boardTagMap([RESEARCH, IDEA, USER_RESEARCH])
const run = (query: string, tag: string | null = null) =>
  searchBoardWithTags(records, query, { limit: 50, tag, board }).map((h) => h.shapeId)

describe('search by tag', () => {
  it('the fixtures are valid tldraw records (meta keys per tag are plain JSON)', () => {
    expect(() => validateAll(records)).not.toThrow()
  })

  it('splits #terms from words', () => {
    expect(parseTagQuery('  #Res  slow #  #idea ')).toEqual({ text: 'slow', tagTerms: ['res', 'idea'] })
    expect(textOfQuery('#research checkout')).toBe('checkout')
  })

  it('without tags it is exactly searchBoard', () => {
    const plain = searchBoard(records, 'checkout', { limit: 50 }).map((h) => h.shapeId)
    expect(run('checkout')).toEqual(plain)
    expect(run('')).toEqual([])
  })

  it('a word also finds notes and cards by tag name (text matches first)', () => {
    // searchBoard's own ranking first (the geo's exact label, then n3), then tagged shapes found by tag name
    expect(run('research')).toEqual([sid('g1'), sid('n3'), sid('n1'), sid('n2'), sid('n4')])
    const viaTag = searchBoardWithTags(records, 'interview research', { limit: 50, tag: null, board })
    expect(viaTag.map((h) => h.shapeId)).toEqual([sid('n1')])
    expect(viaTag[0]?.snippet).toBe('Interview with Dana · #Research')
  })

  it('#term matches tag names by prefix, never text; several must all match', () => {
    expect(run('#res')).toEqual([sid('n2'), sid('n4'), sid('n1')]) // reading order: n4 is at page y 20 (in its frame)
    expect(run('#research #idea')).toEqual([sid('n2')])
    expect(run('#user')).toEqual([sid('n4')])
    expect(run('#nothing')).toEqual([])
    expect(run('#RÉSEARCH')).toEqual(run('#research')) // case and accents folded
  })

  it('#term plus words: words must match text or tags of a tagged shape', () => {
    expect(run('#idea slow')).toEqual([sid('n2')])
    expect(run('#idea survey')).toEqual([sid('c1')])
    expect(run('#research budget')).toEqual([]) // n3 says it but carries no tag
  })

  it('the tag filter alone lists every note and card carrying it, in reading order', () => {
    expect(run('', 'idea')).toEqual([sid('n2'), sid('c1')])
    expect(run('', 'research')).toEqual([sid('n2'), sid('n1')])
    expect(run('checkout', 'research')).toEqual([sid('n2')])
    expect(run('dana', 'idea')).toEqual([])
  })

  it('tag-only hits carry a snippet: the text, or the tag names for an empty note', () => {
    const hits = searchBoardWithTags(records, '#user', { limit: 50, tag: null, board })
    expect(hits[0]).toMatchObject({
      shapeId: sid('n4'),
      type: 'note',
      snippet: '#User research',
      pageId: PAGE,
    })
  })

  it('the board list’s name decides what #terms match (renamed on the board, stale copy on the note)', () => {
    const renamed = boardTagMap([T('research', 'Findings'), IDEA])
    const ids = searchBoardWithTags(records, '#find', { limit: 50, tag: null, board: renamed }).map(
      (h) => h.shapeId,
    )
    expect(ids).toEqual([sid('n2'), sid('n1')])
  })

  it('F2 / R8: images and mind-map topics (geo) carry tags too, for the filter and #terms', () => {
    const WARM = T('warm', 'Warm', 'orange')
    const mood: TLRecord[] = [
      page(PAGE, 'Page 1'),
      imageAsset('a1'),
      image('i1', 'asset:a1', { x: 0, y: 0, meta: tagsMeta(WARM) }),
      image('i2', 'asset:a1', { x: 400, y: 0 }),
      geo('t1', 'Stabilise CI', { x: 0, y: 400, meta: { drMindmap: { rootId: 'r' }, ...tagsMeta(WARM) } }),
    ]
    expect(() => validateAll(mood)).not.toThrow()
    const opts = { limit: 50, board: boardTagMap([WARM]) }
    expect(searchBoardWithTags(mood, '', { ...opts, tag: 'warm' }).map((h) => h.shapeId)).toEqual([
      sid('i1'),
      sid('t1'),
    ])
    expect(searchBoardWithTags(mood, '#warm', { ...opts, tag: null }).map((h) => h.shapeId)).toEqual([
      sid('i1'),
      sid('t1'),
    ])
  })

  it('respects the limit', () => {
    expect(searchBoardWithTags(records, '#res', { limit: 1, tag: null, board })).toHaveLength(1)
  })
})
