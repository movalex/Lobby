import type { TLRecord } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { extractSearchableText, foldForSearch, searchBoard } from './index.ts'
import {
  arrow,
  arrowBinding,
  documentRecord,
  fileCard,
  frame,
  geo,
  group,
  image,
  imageAsset,
  note,
  PAGE,
  PAGE_2,
  page,
  sid,
  text,
  validateAll,
} from './test-fixtures.ts'

const longText = `${'Background context sentence. '.repeat(6)}The needle is here in the middle. ${'Trailing filler words. '.repeat(6)}`

function board(): TLRecord[] {
  const records: TLRecord[] = [
    documentRecord(),
    page(PAGE, 'Café planning', 'a1'),
    page(PAGE_2, 'Second', 'a2'),
    frame('research', 'Research', { x: 0, y: 0, w: 1200, h: 800 }),
    note('cafe', 'Café meeting notes', { parentId: sid('research'), x: 20, y: 60 }),
    note('phrase', 'User research interview', { parentId: sid('research'), x: 260, y: 60, index: 'a2' }),
    note('words', 'research on user needs', { parentId: sid('research'), x: 500, y: 60, index: 'a3' }),
    note('substr', 'superuser researchers', { parentId: sid('research'), x: 740, y: 60, index: 'a4' }),
    note('long', longText, { x: 0, y: 1000 }),
    text('quarterly', 'Quarterly plan', { x: 0, y: 1300 }),
    text('planning', 'Planning session', { x: 0, y: 1400, index: 'a2' }),
    text('explain', 'explanation', { x: 0, y: 1500, index: 'a3' }),
    geo('decision', 'Decision: go', { x: 1400, y: 0 }),
    arrow('link', 'depends on', { x: 1400, y: 200 }),
    arrowBinding('b1', sid('link'), sid('decision'), 'end'),
    frame('launch', 'Launch plan', { x: 0, y: 0, parentId: PAGE_2 }),
    note('launch-review', 'Launch plan review', { x: 0, y: 400, parentId: PAGE_2 }),
    group('grp', { x: 0, y: 2000 }),
    fileCard('brief', 'brief-café.pdf', { parentId: sid('grp') }),
    imageAsset('photo'),
    image('team', 'asset:photo', { altText: 'Team photo at the café', x: 0, y: 2400 }),
    note('orphan', 'Café orphan', { parentId: sid('missing-parent') }),
  ]
  validateAll(records)
  return records
}

const ids = (hits: { shapeId: string }[]) => hits.map((hit) => hit.shapeId)

describe('extractSearchableText', () => {
  const b = new Map(board().map((r) => [r.id, r]))
  const get = (name: string) => b.get(sid(name)) as never
  it('reads the user-visible text of each shape type', () => {
    expect(extractSearchableText(get('cafe'))).toBe('Café meeting notes')
    expect(extractSearchableText(get('quarterly'))).toBe('Quarterly plan')
    expect(extractSearchableText(get('decision'))).toBe('Decision: go')
    expect(extractSearchableText(get('link'))).toBe('depends on')
    expect(extractSearchableText(get('research'))).toBe('Research')
    expect(extractSearchableText(get('brief'))).toBe('brief-café.pdf')
    expect(extractSearchableText(get('team'))).toBe('Team photo at the café')
    expect(extractSearchableText(get('grp'))).toBe('')
  })
  it('never throws on malformed shapes', () => {
    expect(extractSearchableText({ type: 'note', props: null } as never)).toBe('')
    expect(extractSearchableText({ type: 'frame' } as never)).toBe('')
    expect(
      extractSearchableText({ type: 'custom', props: { richText: { type: 'doc', content: [] } } } as never),
    ).toBe('')
  })
})

describe('searchBoard', () => {
  const records = board()

  it('is diacritic- and case-insensitive in both directions', () => {
    const plain = searchBoard(records, 'cafe')
    expect(ids(plain).sort()).toEqual([sid('brief'), sid('cafe'), sid('team')].sort())
    expect(ids(searchBoard(records, 'CAFÉ')).sort()).toEqual(ids(plain).sort())
    expect(foldForSearch('  Crème   Brûlée ')).toBe('creme brulee')
    expect(foldForSearch('Straße Øre')).toBe('strasse ore')
  })

  it('returns original text in the snippet and the page of each hit', () => {
    const hit = searchBoard(records, 'cafe meeting')[0]
    expect(hit).toMatchObject({
      shapeId: sid('cafe'),
      type: 'note',
      pageId: PAGE,
      text: 'Café meeting notes',
    })
    expect(hit?.snippet).toBe('Café meeting notes')
    const second = searchBoard(records, 'launch')
    expect(second.every((h) => h.pageId === PAGE_2)).toBe(true)
  })

  it('requires every term (AND)', () => {
    expect(ids(searchBoard(records, 'user research')).sort()).toEqual(
      [sid('phrase'), sid('substr'), sid('words')].sort(),
    )
    expect(searchBoard(records, 'user banana')).toEqual([])
  })

  it('ranks exact text > phrase > whole words/word starts > substrings', () => {
    const hits = searchBoard(records, 'user research')
    expect(ids(hits)).toEqual([sid('phrase'), sid('words'), sid('substr')])
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0)
    expect(hits[1]?.score).toBeGreaterThan(hits[2]?.score ?? 0)

    expect(ids(searchBoard(records, 'plan'))).toEqual([
      sid('launch'), // whole word, shortest text ("Launch plan")
      sid('quarterly'), // whole word ("Quarterly plan")
      sid('launch-review'), // whole word, longer text
      sid('planning'), // word start
      sid('explain'), // substring
      // "Café planning" is a page name, not a shape
    ])
    const exact = searchBoard(records, 'launch plan')
    expect(ids(exact)).toEqual([sid('launch'), sid('launch-review')])
    expect(exact[0]?.score).toBeGreaterThanOrEqual(1000)
    expect(exact[1]?.score).toBeGreaterThanOrEqual(100)
    expect(exact[1]?.score).toBeLessThan(1000)
  })

  it('cuts a snippet around the match in long text', () => {
    const hit = searchBoard(records, 'needle')[0]
    expect(hit?.shapeId).toBe(sid('long'))
    expect(hit?.snippet).toContain('The needle is here')
    expect(hit?.snippet.startsWith('…')).toBe(true)
    expect(hit?.snippet.endsWith('…')).toBe(true)
    expect(hit?.snippet.length).toBeLessThan(140)
    expect(hit?.text).toBe(longText)
  })

  it('honours limit', () => {
    expect(searchBoard(records, 'plan', { limit: 2 })).toHaveLength(2)
    expect(searchBoard(records, 'plan', { limit: 0 })).toEqual([])
    expect(searchBoard(records, 'plan', { limit: Number.NaN })).toHaveLength(5)
  })

  it('finds an image or video by the file name of its asset (F15), with or without alt text', () => {
    const extra: TLRecord[] = [
      { ...imageAsset('ref'), props: { ...imageAsset('ref').props, name: 'ref-01.jpg' } } as TLRecord,
      image('moodref', 'asset:ref', { x: 0, y: 2800 }),
    ]
    const all = [...records, ...extra]
    const hit = searchBoard(all, 'ref-01')
    expect(ids(hit)).toEqual([sid('moodref')])
    expect(hit[0]).toMatchObject({ type: 'image', text: 'ref-01.jpg', snippet: 'ref-01.jpg' })
    // alt text and file name together
    expect(searchBoard(all, 'team photo.png')[0]?.text).toBe('Team photo at the café · photo.png')
    // Without the asset records (or with no name), only the alt text is indexed.
    expect(searchBoard([...records, extra[1] as TLRecord], 'ref-01')).toEqual([])
    const shape = extra[1] as never
    expect(extractSearchableText(shape)).toBe('')
    expect(extractSearchableText(shape, (id) => (id === 'asset:ref' ? 'ref-01.jpg' : undefined))).toBe(
      'ref-01.jpg',
    )
  })

  it('ignores non-shape records, orphans, and empty queries', () => {
    // Page "Café planning", the asset record itself, the document and the binding are not results
    // (the image using asset "photo.png" is); the orphan note has no page.
    expect(ids(searchBoard(records, 'photo'))).toEqual([sid('team')])
    expect(ids(searchBoard(records, 'orphan'))).toEqual([])
    expect(searchBoard(records, 'board')).toEqual([])
    expect(searchBoard(records, '   ')).toEqual([])
    expect(searchBoard(records, undefined as never)).toEqual([])
  })

  it('accepts any iterable and tolerates junk records', () => {
    const junk = [
      null,
      42,
      { typeName: 'shape' },
      { typeName: 'shape', id: 'shape:x', parentId: PAGE, props: 7 },
    ]
    const set = new Set<unknown>([...records, ...junk])
    expect(ids(searchBoard(set as Iterable<TLRecord>, 'decision'))).toEqual([sid('decision')])
  })
})

describe('searchBoard adversarial review', () => {
  const records: TLRecord[] = [
    note('regex', 'Costs (Q3) are $5.00 + tax [est.] a*b ^start end$ backslash a|b {x}'),
    note('plain', 'Nothing special here', { x: 300, index: 'a2' }),
  ]

  it.each(['(Q3)', '$5.00', '+ tax', '[est.]', 'a*b', '^start', 'end$', 'backslash', 'a|b', '{x}', '.', '*'])(
    'matches regex metacharacters literally: %j',
    (query) => {
      expect(ids(searchBoard(records, query))).toEqual([sid('regex')])
    },
  )

  it('does not treat "." or ".*" as wildcards', () => {
    expect(searchBoard(records, '.*')).toEqual([])
    expect(searchBoard(records, 'N.thing')).toEqual([])
  })

  it('returns nothing for empty, whitespace-only and mark-only queries', () => {
    for (const query of ['', ' ', '\t\n', '\u00a0\u3000\u2003', '\u0301\u0308']) {
      expect(searchBoard(records, query)).toEqual([])
    }
  })

  it('cuts very long queries without throwing', () => {
    expect(searchBoard(records, 'special '.repeat(10_000))).toHaveLength(1)
    expect(searchBoard(records, 'x'.repeat(100_000))).toEqual([])
  })
})
