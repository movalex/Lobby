// Wave M (M8-2): a question read as a search for ANY of its meaningful words (search/query.ts parseQuestion).
import { describe, expect, it } from 'vitest'
import { parseQuery, parseQuestion, QUESTION_MAX_TERMS } from '../../../src/features/search/query.ts'

describe('parseQuestion', () => {
  it('keeps the topic words, drops the words of a question, and ORs them as prefixes', () => {
    expect(parseQuestion('What did we decide about the launch pricing?')).toEqual({
      terms: ['decide', 'launch', 'pricing'],
      simple: "'decide':* | 'launch':* | 'pricing':*",
      english: "'decide':* | 'launch':* | 'pricing':*",
    })
    // a search box is unchanged: every word must match
    expect(parseQuery('launch pricing').simple).toBe("'launch':* & 'pricing':*")
  })

  it('folds accents for the simple reading and keeps the original for the english one', () => {
    const q = parseQuestion('Which Café menus?')
    expect(q.terms).toEqual(['cafe', 'menus'])
    expect(q.simple).toBe("'cafe':* | 'menus':*")
    expect(q.english).toBe("'café':* | 'menus':*")
  })

  it('nothing to look for: only question words, one letter, or punctuation', () => {
    for (const q of ['What did we say about it?', 'a b c', '?!…', ''])
      expect(parseQuestion(q)).toEqual({ terms: [], simple: '', english: '' })
  })

  it('never lets tsquery syntax through, repeats once, and stops at the term cap', () => {
    const q = parseQuestion(`pricing' | ! & :* (x) "pricing" PRICING ${'w'.repeat(200)}`)
    expect(q.terms[0]).toBe('pricing')
    expect(q.terms.filter((t) => t === 'pricing')).toHaveLength(1)
    for (const t of q.terms) expect(t).toMatch(/^[\p{L}\p{N}]+$/u)
    expect(q.terms.at(-1)?.length).toBe(64)
    const many = parseQuestion(Array.from({ length: 30 }, (_, i) => `topic${i}`).join(' '))
    expect(many.terms).toHaveLength(QUESTION_MAX_TERMS)
    expect(many.simple.split(' | ')).toHaveLength(QUESTION_MAX_TERMS)
  })
})
