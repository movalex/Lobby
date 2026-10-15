// Wave Q (WS1): the icon search over the real generated index (about 6,500 icons): ranking by name, then words,
// tags and category, the set and category filters, and the time a search takes.
import { pinnedIcons } from '@draftroom/icon-sets/generate'
import { beforeAll, describe, expect, it } from 'vitest'
import { iconCatalogOf } from './catalog.ts'
import { createIconSearch, type IconSearch, type IconSearchOptions, normalizeQuery } from './search.ts'

let search: IconSearch
let total: number

beforeAll(() => {
  const catalog = iconCatalogOf(pinnedIcons().index, () => Promise.reject(new Error('no fetch here')))
  search = createIconSearch(catalog.entries)
  total = catalog.entries.length
  // the generation: about 4 s alone, more under the full suite's load
}, 120_000)

const keys = (q: string, opts?: IconSearchOptions) => search.search(q, opts).map((e) => e.key)

describe('icon search', () => {
  it('puts the exact name first, then names that start with the query, then names with a word that does', () => {
    const arrow = keys('arrow-right')
    expect(arrow.slice(0, 2).sort()).toEqual(['lucide:arrow-right', 'tabler:arrow-right'])
    // spaces read as dashes
    expect(keys('Arrow Right').slice(0, 2).sort()).toEqual(['lucide:arrow-right', 'tabler:arrow-right'])
    const heart = keys('heart')
    expect(heart[0]).toBe('lucide:heart')
    expect(heart[1]).toBe('tabler:heart')
    // a prefix match ranks above a word match: heart-* before *-heart
    const firstWord = heart.findIndex((k) => /:[a-z0-9-]+-heart/.test(k) && !/:heart/.test(k))
    const lastPrefix = heart.findLastIndex((k) => /:heart-/.test(k))
    expect(firstWord).toBeGreaterThan(lastPrefix)
  })

  it('finds icons by their tags and by category words, below the name matches', () => {
    // "love" is a tag of the hearts, in neither set's names
    const love = keys('love')
    expect(love).toContain('lucide:heart')
    expect(love).toContain('tabler:heart')
    // a multi-word query matches words anywhere: arrow-big-right has both
    expect(keys('arrow right', { limit: 400 })).toContain('tabler:arrow-big-right')
    // nothing matches nonsense
    expect(keys('zzqqxx')).toEqual([])
  })

  it('filters by set and by category; an empty query lists them in index order', () => {
    expect(keys('arrow', { set: 'tabler' }).every((k) => k.startsWith('tabler:'))).toBe(true)
    const arrows = search.search('', { category: 'Arrows', limit: 10_000 })
    expect(arrows.length).toBeGreaterThan(100)
    expect(arrows.every((e) => e.category === 'Arrows' && e.set === 'tabler')).toBe(true)
    const everything = search.search('', { limit: 10_000 })
    expect(everything).toHaveLength(total)
    expect(keys('', { limit: 5 })).toEqual(everything.slice(0, 5).map((e) => e.key))
    expect(search.search('a', {}).length).toBeLessThanOrEqual(200)
    const cats = search.categories('tabler')
    expect(cats.map((c) => c.name)).toContain('Arrows')
    expect(cats.some((c) => c.name === 'Brand')).toBe(false)
    expect(search.categories('lucide')).toEqual([])
  })

  it('normalises queries: case, accents, separators', () => {
    expect(normalizeQuery('  Café--AU_lait ')).toBe('cafe au lait')
    expect(normalizeQuery('x'.repeat(200))).toHaveLength(64)
  })

  it('is fast enough to run on every keystroke over the whole index', () => {
    const queries = ['a', 'ar', 'arr', 'arrow', 'arrow r', 'arrow ri', 'user', 'chart bar', 'file', 'zz', 'e']
    // warm up
    for (const q of queries) search.search(q)
    const started = performance.now()
    const rounds = 10
    for (let n = 0; n < rounds; n++) for (const q of queries) search.search(q)
    const perSearch = (performance.now() - started) / (rounds * queries.length)
    // measured about 1-3 ms on the dev laptop; the budget leaves room for a slow CI machine
    expect(perSearch).toBeLessThan(25)
  })
})
