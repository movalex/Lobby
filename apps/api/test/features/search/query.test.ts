// Search terms, tsquery text, snippets and the freshness rules (pure functions).
import { SEARCH_MAX_TERMS } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  HIGHLIGHT_STOP as E,
  foldText,
  highlightWords,
  parseQuery,
  HIGHLIGHT_START as S,
  simpleIndexText,
  snippetFromHeadline,
} from '../../../src/features/search/query.ts'
import { freshness } from '../../../src/features/search/scope.ts'

describe('parseQuery', () => {
  it('keeps words of letters and digits, folded, deduplicated, at least two characters', () => {
    expect(parseQuery('  Café  Zebra-crossing  a  Q3 café ')).toEqual({
      terms: ['cafe', 'zebra', 'crossing', 'q3'],
      simple: "'cafe':* & 'zebra':* & 'crossing':* & 'q3':*",
      english: "'café':* & 'zebra':* & 'crossing':* & 'q3':*",
    })
    expect(parseQuery('Straße ØRE').terms).toEqual(['strasse', 'ore'])
    expect(parseQuery('東京タワー').terms).toEqual(['東京タワー'])
  })

  it('never lets tsquery syntax through', () => {
    for (const q of [
      "'",
      '"quoted"',
      'a & b | !c',
      "zebra':* | 'x",
      '(nested) <-> phrase',
      'x:*A',
      '\\\\',
      "'; DROP TABLE boards; --",
      '<script>alert(1)</script>',
    ]) {
      const p = parseQuery(q)
      for (const s of [p.simple, p.english])
        expect(s).toMatch(/^('[\p{L}\p{N}]+':\*( & '[\p{L}\p{N}]+':\*)*)?$/u)
    }
    expect(parseQuery("'; DROP TABLE boards; --").terms).toEqual(['drop', 'table', 'boards'])
  })

  it('has no terms for one-letter or symbol-only input, and caps words and their length', () => {
    expect(parseQuery('a b c ! ?')).toEqual({ terms: [], simple: '', english: '' })
    expect(parseQuery('🎉🎉').terms).toEqual([])
    const many = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ')
    expect(parseQuery(many).terms).toHaveLength(SEARCH_MAX_TERMS)
    expect(parseQuery('x'.repeat(300)).terms[0]).toHaveLength(64)
  })
})

describe('foldText', () => {
  it('lowercases and removes accents like the in-board search', () => {
    expect(foldText('Crème Brûlée ÆON Łódź ﬁnance')).toBe('creme brulee aeon lodz finance')
  })
})

describe('snippets', () => {
  it('reads the highlight markers Postgres put in', () => {
    const body = 'We plan the zebra crossing next week'
    const s = snippetFromHeadline(`plan the ${S}zebra${E} crossing`, body, ['zebra'])
    expect(s).toEqual({
      parts: [
        { text: 'plan the ', hit: false },
        { text: 'zebra', hit: true },
        { text: ' crossing', hit: false },
      ],
      cutStart: true,
      cutEnd: true,
    })
    const whole = snippetFromHeadline(`${S}Zebra${E} crossing`, 'Zebra crossing', ['zebra'])
    expect(whole.cutStart).toBe(false)
    expect(whole.cutEnd).toBe(false)
  })

  it('marks folded prefix matches itself when Postgres marked nothing', () => {
    const s = snippetFromHeadline('Meet at the Café Zébrâ', 'Meet at the Café Zébrâ', ['cafe', 'zeb'])
    expect(s.parts).toEqual([
      { text: 'Meet at the ', hit: false },
      { text: 'Café', hit: true },
      { text: ' ', hit: false },
      { text: 'Zébrâ', hit: true },
    ])
    expect(highlightWords('no match here', ['zebra'])).toEqual([{ text: 'no match here', hit: false }])
  })

  it('cuts around the first matching word when the headline holds no match at all', () => {
    const body = `${'😀'.repeat(40)} lead ${'x '.repeat(40)}the Café is here${' y'.repeat(100)}`
    const s = snippetFromHeadline('😀😀 lead x x x', body, ['cafe'])
    const text = s.parts.map((p) => p.text).join('')
    expect(s.parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['Café'])
    expect(s).toMatchObject({ cutStart: true, cutEnd: true })
    expect(text.startsWith('x ')).toBe(true) // cut at a space, never inside a word
    expect(text.endsWith('y')).toBe(true)
    expect(text.length).toBeLessThan(220)
    // A match near the start keeps the start; a surrogate pair is never split.
    const short = snippetFromHeadline('nothing', `😀 Café ${'😀'.repeat(200)}`, ['cafe'])
    const shortText = short.parts.map((p) => p.text).join('')
    expect(short.cutStart).toBe(false)
    expect(shortText).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(() => encodeURIComponent(shortText)).not.toThrow()
    // Nothing matches anywhere: the headline stays as it is.
    expect(snippetFromHeadline('plain words', 'plain words', ['zebra']).parts).toEqual([
      { text: 'plain words', hit: false },
    ])
  })

  it('keeps what Postgres marked (stems) and adds folded and in-word matches', () => {
    const s = snippetFromHeadline(`${S}runs${E} to the Café with brief.pdf`, 'x', ['running', 'cafe', 'pdf'])
    expect(s.parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['runs', 'Café', 'pdf'])
  })
})

describe('simpleIndexText', () => {
  it('splits folded text into runs of letters and digits, like query words', () => {
    expect(simpleIndexText('Brief.PDF e-mail user@x.com Café_2')).toBe('brief pdf e mail user x com cafe 2')
  })
})

describe('freshness', () => {
  const now = new Date('2026-09-27T12:00:00Z')
  const at = (s: number) => new Date(now.getTime() + s * 1000)
  const opts = { recentMs: 120_000, recheckMs: 3_000 }
  const state = (over: object = {}) => ({
    canvasSourceAt: at(-600),
    canvasClock: 7,
    canvasIndexedAt: at(-600),
    canvasTruncated: false,
    commentsSourceAt: null,
    commentsTruncated: false,
    retryAt: null,
    ...over,
  })

  it('is stale when never indexed or when updated_at moved past what was indexed', () => {
    expect(freshness({ updatedAt: at(-900), commentsAt: null, state: null }, now, opts).canvasStale).toBe(
      true,
    )
    expect(freshness({ updatedAt: at(-600), commentsAt: null, state: state() }, now, opts).canvasStale).toBe(
      false,
    )
    expect(freshness({ updatedAt: at(-500), commentsAt: null, state: state() }, now, opts).canvasStale).toBe(
      true,
    )
  })

  it('re-checks recently changed boards, but not more than every recheckMs', () => {
    const recent = { updatedAt: at(-60), commentsAt: null }
    expect(
      freshness(
        { ...recent, state: state({ canvasSourceAt: at(-60), canvasIndexedAt: at(-10) }) },
        now,
        opts,
      ),
    ).toMatchObject({
      canvasStale: false,
      canvasRecent: true,
    })
    expect(
      freshness({ ...recent, state: state({ canvasSourceAt: at(-60), canvasIndexedAt: at(-1) }) }, now, opts)
        .canvasRecent,
    ).toBe(false)
    expect(freshness({ updatedAt: at(-600), commentsAt: null, state: state() }, now, opts).canvasRecent).toBe(
      false,
    )
  })

  it('backs off after failures and tracks comment threads separately', () => {
    expect(
      freshness({ updatedAt: at(-600), commentsAt: null, state: state({ retryAt: at(30) }) }, now, opts)
        .backoff,
    ).toBe(true)
    expect(
      freshness({ updatedAt: at(-600), commentsAt: at(-5), state: state() }, now, opts).commentsStale,
    ).toBe(true)
    expect(
      freshness(
        { updatedAt: at(-600), commentsAt: at(-5), state: state({ commentsSourceAt: at(-5) }) },
        now,
        opts,
      ).commentsStale,
    ).toBe(false)
  })
})
