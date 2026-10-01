// Engine-neutral text matching for board search: folding (case + diacritics) with a map back to the
// original string, per-term scoring and snippets. Moved here unchanged from search.ts, so the tldraw
// search (./search.ts) and the element search (./elements/search.ts) rank alike.

import { truncateText } from './common.ts'

/** Letters that NFKD does not decompose but users expect to match their ASCII look-alikes. */
const EXTRA_FOLDS: Record<string, string> = {
  ß: 'ss',
  ẞ: 'ss',
  ς: 'σ',
  ı: 'i',
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
}
const COMBINING_MARKS = /\p{M}/gu
const WHITESPACE = /\s/u
const WORD_CHAR = /[\p{L}\p{N}_]/u

interface Folded {
  /** Lowercased, NFKD without combining marks, whitespace runs collapsed to one space. */
  text: string
  /** `map[i]` = index in the original string of the code point that produced `text[i]`; `map[text.length]` = original length. */
  map: number[]
}

function foldChar(ch: string): string {
  const lower = ch.toLowerCase()
  const extra = Object.hasOwn(EXTRA_FOLDS, lower) ? EXTRA_FOLDS[lower] : undefined
  return extra ?? lower.normalize('NFKD').replace(COMBINING_MARKS, '')
}

function fold(input: string): Folded {
  let text = ''
  const map: number[] = []
  let i = 0
  while (i < input.length) {
    const cp = input.codePointAt(i) as number
    const ch = String.fromCodePoint(cp)
    if (WHITESPACE.test(ch)) {
      if (!text.endsWith(' ')) {
        text += ' '
        map.push(i)
      }
    } else {
      const folded = foldChar(ch)
      for (let k = 0; k < folded.length; k++) map.push(i)
      text += folded
    }
    i += ch.length
  }
  map.push(input.length)
  return { text, map }
}

/** Case- and diacritic-insensitive normal form used for matching (exported for callers that pre-index). */
export function foldForSearch(input: string): string {
  return fold(input).text.trim()
}

const MAX_QUERY_CHARS = 256
const MAX_TERMS = 12
/** Occurrences inspected per term when looking for a better (word-boundary) match. */
const MAX_OCCURRENCES = 256
export const DEFAULT_SEARCH_LIMIT = 50
const MAX_LIMIT = 1000
const SNIPPET_BEFORE = 40
const SNIPPET_AFTER = 80

const EXACT_SCORE = 1000
const PHRASE_SCORE = 100
const WHOLE_WORD_SCORE = 3
const WORD_START_SCORE = 2
const SUBSTRING_SCORE = 1

/** Best match of one term: its tier score and the first occurrence index. */
function matchTerm(text: string, term: string): { score: number; index: number } | null {
  let index = text.indexOf(term)
  if (index === -1) return null
  const first = index
  let best = 0
  for (let n = 0; index !== -1 && n < MAX_OCCURRENCES; n++) {
    const starts = index === 0 || !WORD_CHAR.test(text[index - 1] as string)
    const ends = index + term.length >= text.length || !WORD_CHAR.test(text[index + term.length] as string)
    const score = starts && ends ? WHOLE_WORD_SCORE : starts ? WORD_START_SCORE : SUBSTRING_SCORE
    if (score > best) best = score
    if (best === WHOLE_WORD_SCORE) break
    index = text.indexOf(term, index + 1)
  }
  return { score: best, index: first }
}

function makeSnippet(original: string, start: number, end: number): string {
  let from = Math.max(0, start - SNIPPET_BEFORE)
  let to = Math.min(original.length, end + SNIPPET_AFTER)
  // Prefer cutting at whitespace, and never inside a surrogate pair.
  if (from > 0) {
    const space = original.slice(from, start).search(/\s/u)
    if (space !== -1) from += space + 1
    if (/[\uDC00-\uDFFF]/.test(original[from] ?? '')) from++
  }
  if (to < original.length) {
    const tail = original.slice(end, to)
    const lastSpace = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('\n'), tail.lastIndexOf('\t'))
    if (lastSpace > 0) to = end + lastSpace
    if (/[\uD800-\uDBFF]/.test(original[to - 1] ?? '')) to--
  }
  const body = original.slice(from, to).replace(/\s+/gu, ' ').trim()
  return `${from > 0 ? '…' : ''}${body}${to < original.length ? '…' : ''}`
}

/** A parsed query: the folded phrase and its distinct terms (cut to 256 characters and 12 terms). */
export interface SearchQuery {
  phrase: string
  terms: string[]
}

/** Parses a query, or null when it has nothing to search for. */
export function parseSearchQuery(query: unknown): SearchQuery | null {
  if (typeof query !== 'string') return null
  const phrase = foldForSearch(truncateText(query, MAX_QUERY_CHARS))
  if (!phrase) return null
  return { phrase, terms: [...new Set(phrase.split(' ').filter(Boolean))].slice(0, MAX_TERMS) }
}

/** The result limit: `limit` floored and clamped to 0..1000, default 50. */
export function searchLimit(limit: unknown): number {
  return typeof limit === 'number' && Number.isFinite(limit)
    ? Math.min(MAX_LIMIT, Math.max(0, Math.floor(limit)))
    : DEFAULT_SEARCH_LIMIT
}

/**
 * Scores `text` against the query: every term must match (AND); whole text equals the query > text
 * contains the query as a phrase starting at a word boundary > per term (whole word 3, word start 2,
 * substring 1). Returns null when a term does not match, else the score and a snippet around the match.
 */
export function scoreText(text: string, query: SearchQuery): { score: number; snippet: string } | null {
  const { phrase, terms } = query
  const folded = fold(text)
  let score = 0
  let firstIndex = Number.POSITIVE_INFINITY
  let firstLength = 0
  for (const term of terms) {
    const match = matchTerm(folded.text, term)
    if (!match) return null
    score += match.score
    if (match.index < firstIndex) {
      firstIndex = match.index
      firstLength = term.length
    }
  }
  const phraseIndex = folded.text.indexOf(phrase)
  const phraseMatch = phraseIndex === -1 ? null : matchTerm(folded.text, phrase)
  if (folded.text.trim() === phrase) score += EXACT_SCORE
  else if (terms.length > 1 && phraseMatch && phraseMatch.score >= WORD_START_SCORE) score += PHRASE_SCORE
  const [at, length] = phraseIndex !== -1 ? [phraseIndex, phrase.length] : [firstIndex, firstLength]
  const start = folded.map[at] ?? 0
  const lastOriginal = folded.map[at + length - 1] ?? start
  const end = lastOriginal + ((text.codePointAt(lastOriginal) ?? 0) > 0xffff ? 2 : 1)
  return { score, snippet: makeSnippet(text, start, end) }
}
