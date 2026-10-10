// Search terms, tsquery text and snippets (docs/WAVE4-CONTRACTS.md "search"). Pure functions.
//
// Matching: every word must match (AND), each as a prefix, so results appear while the last word is
// still being typed. Two readings of the text are searched (OR): `simple` over the case- and
// accent-folded text ('cafe' finds 'Café', 'zeb' finds 'Zebras'), and `english` over the original
// (stemmed: 'running' finds 'run'). The tsquery text is built here from words that contain letters and
// digits only, so no user input ever reaches the tsquery parser's syntax (quotes, operators, weights).

import { SEARCH_MAX_TERMS, SEARCH_MIN_TERM_CHARS, type SnippetPart } from '@draftroom/contracts'

/** The longest word kept (longer ones are cut: a prefix of a word still matches it). */
export const MAX_TERM_CHARS = 64

/** Letters that NFKD does not decompose but people expect to match their plain look-alikes. */
const EXTRA_FOLDS: Readonly<Record<string, string>> = {
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
const EXTRA_RE = new RegExp(`[${Object.keys(EXTRA_FOLDS).join('')}]`, 'gu')
const MARKS_RE = /\p{M}/gu
const WORD_RE = /[\p{L}\p{N}]+/gu

/**
 * Lowercase, compatibility-decomposed, without combining marks (the same folding as the in-board
 * search in packages/board-ops, without its index map). Used for both the indexed text and the terms.
 */
export function foldText(s: string): string {
  return s
    .toLowerCase()
    .replace(EXTRA_RE, (c) => EXTRA_FOLDS[c] ?? c)
    .normalize('NFKD')
    .replace(MARKS_RE, '')
}

function words(s: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of s.matchAll(WORD_RE)) {
    let w = m[0]
    if ([...w].length < SEARCH_MIN_TERM_CHARS) continue
    if (w.length > MAX_TERM_CHARS) w = w.slice(0, MAX_TERM_CHARS).replace(/[\uD800-\uDBFF]$/, '')
    if (seen.has(w)) continue
    seen.add(w)
    out.push(w)
    if (out.length >= SEARCH_MAX_TERMS) break
  }
  return out
}

export interface ParsedQuery {
  /** Folded words (what `simple` matches, and what the response echoes). */
  terms: string[]
  /** `'w1':* & 'w2':*` over the folded words, for to_tsquery('simple', …); '' when there are none. */
  simple: string
  /** The same over the lowercased original words, for to_tsquery('english', …). */
  english: string
}

const prefixQuery = (ws: readonly string[]) => ws.map((w) => `'${w}':*`).join(' & ')

export function parseQuery(q: string): ParsedQuery {
  const folded = words(foldText(q))
  const original = words(q.toLowerCase())
  return { terms: folded, simple: prefixQuery(folded), english: prefixQuery(original) }
}

// ---- a question, not a search (wave M, M8-2: Ask across boards) -----------------------------------------
//
// A search box gets a few words that must ALL match. A question ("What did we decide about the launch
// pricing?") is a sentence: requiring every word would find nothing. So a question is read as ANY of its
// meaningful words (OR), each a prefix as in a search, with the common words of a question left out (they
// would match nearly every note through the `simple` reading, which keeps stop words). ts_rank_cd then ranks
// the entries that hold more of the words, closer together, first. The same word rule as parseQuery, so no
// input reaches the tsquery parser's syntax either.

/** The most words of one question that are looked for. */
export const QUESTION_MAX_TERMS = 12

/** Words that carry no topic in a question (folded forms), on top of English's own stop words. */
const QUESTION_STOP = new Set(
  (
    'a about above after again all also am an and any are as at be been before being both but by can could ' +
    'did do does doing done during each either else ever for from had has have having he her here hers him ' +
    'his how i if in into is it its just let me more most my no nor not now of off on once only or other ' +
    'our ours out over own same she should so some such than that the their theirs them then there these ' +
    'they this those through to too under until up us very was we were what when where which while who ' +
    'whom why will with would yet you your yours ' +
    // question words people type at a board
    'across board boards anything everything something tell know think say said says please give show ' +
    'find list get got anyone someone everyone thing things way ways kind'
  ).split(' '),
)

/**
 * A question as a search for any of its words: `'w1':* | 'w2':*` over the folded words that are not
 * QUESTION_STOP (at most QUESTION_MAX_TERMS, in order, without repeats), and the same over the lowercased
 * originals for the english reading. Empty strings when no word is left (nothing is searched then).
 */
export function parseQuestion(q: string): ParsedQuery {
  const terms: string[] = []
  const originals: string[] = []
  const seen = new Set<string>()
  for (const m of q.matchAll(WORD_RE)) {
    const original = m[0].toLowerCase()
    const folded = foldText(m[0])
    // A word folding into several (Straße → strasse) is still one word; the fold keeps letters and digits.
    if (!/^[\p{L}\p{N}]+$/u.test(folded) || !/^[\p{L}\p{N}]+$/u.test(original)) continue
    if ([...folded].length < SEARCH_MIN_TERM_CHARS || QUESTION_STOP.has(folded)) continue
    const cut = (w: string) =>
      w.length > MAX_TERM_CHARS ? w.slice(0, MAX_TERM_CHARS).replace(/[\uD800-\uDBFF]$/, '') : w
    const t = cut(folded)
    if (seen.has(t)) continue
    seen.add(t)
    terms.push(t)
    originals.push(cut(original))
    if (terms.length >= QUESTION_MAX_TERMS) break
  }
  const any = (ws: readonly string[]) => ws.map((w) => `'${w}':*`).join(' | ')
  return { terms, simple: any(terms), english: any(originals) }
}

/** ts_headline markers: control characters, which indexed text never contains (see cleanIndexText). */
export const HIGHLIGHT_START = '\u0002'
export const HIGHLIGHT_STOP = '\u0003'
export const HEADLINE_OPTIONS = `StartSel="${HIGHLIGHT_START}", StopSel="${HIGHLIGHT_STOP}", MaxWords=24, MinWords=12, ShortWord=2, MaxFragments=1, FragmentDelimiter=" … "`

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove control characters
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/** What may be indexed: no control characters (they are the highlight markers), whitespace collapsed. */
export function cleanIndexText(raw: string, maxChars: number): string {
  let s = raw.replace(CONTROL_RE, ' ').replace(/\s+/gu, ' ').trim()
  if (s.length > maxChars)
    s = s
      .slice(0, maxChars)
      .replace(/[\uD800-\uDBFF]$/, '')
      .trimEnd()
  return s
}

export interface Snippet {
  parts: SnippetPart[]
  cutStart: boolean
  cutEnd: boolean
}

function merge(parts: SnippetPart[]): SnippetPart[] {
  const out: SnippetPart[] = []
  for (const p of parts) {
    if (!p.text) continue
    const last = out.at(-1)
    if (last && last.hit === p.hit) last.text += p.text
    else out.push({ ...p })
  }
  return out
}

/** Marks every word of `text` that starts with one of the (folded) terms. */
export function highlightWords(text: string, terms: readonly string[]): SnippetPart[] {
  if (!terms.length) return text ? [{ text, hit: false }] : []
  const parts: SnippetPart[] = []
  let at = 0
  for (const m of text.matchAll(WORD_RE)) {
    const start = m.index ?? 0
    const w = foldText(m[0])
    if (terms.some((t) => w.startsWith(t))) {
      parts.push({ text: text.slice(at, start), hit: false }, { text: m[0], hit: true })
      at = start + m[0].length
    }
  }
  parts.push({ text: text.slice(at), hit: false })
  return merge(parts)
}

/** Context kept around a match that only folding found (characters before and after it). */
const AROUND_BEFORE = 60
const AROUND_AFTER = 140

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff

/**
 * A snippet of `body` around its first word that starts with one of the terms, cut at spaces, or
 * null when no word does. For matches ts_headline cannot see: its english parser keeps 'Café' and
 * 'brief.pdf' whole, so with 'cafe' or 'pdf' it picks no fragment and returns the text's beginning.
 */
export function snippetAround(body: string, terms: readonly string[]): Snippet | null {
  if (!terms.length) return null
  for (const m of body.matchAll(WORD_RE)) {
    if (!terms.some((t) => foldText(m[0]).startsWith(t))) continue
    const at = m.index ?? 0
    const wordEnd = at + m[0].length
    let start = Math.max(0, at - AROUND_BEFORE)
    let end = Math.min(body.length, wordEnd + AROUND_AFTER)
    if (start > 0) {
      const space = body.indexOf(' ', start)
      start = space === -1 || space >= at ? at : space + 1
    }
    if (end < body.length) {
      const space = body.lastIndexOf(' ', end)
      if (space > wordEnd) end = space
    }
    if (start > 0 && isLow(body.charCodeAt(start))) start++ // never half a surrogate pair
    if (end < body.length && isHigh(body.charCodeAt(end - 1))) end--
    return {
      parts: highlightWords(body.slice(start, end), terms),
      cutStart: start > 0,
      cutEnd: end < body.length,
    }
  }
  return null
}

/**
 * Turns a ts_headline result (with HIGHLIGHT_* markers) into snippet parts. Postgres marks what its
 * english dictionary matched (stems: 'running' marks 'runs'); words that match only through folding
 * ('cafe' → 'Café') or inside punctuation ('pdf' in 'brief.pdf') are marked here as well, and when the
 * headline holds no match at all (Postgres could not see it), the snippet is cut around the first
 * matching word instead (snippetAround). `body` is the indexed text, to tell whether it was cut.
 */
export function snippetFromHeadline(headline: string, body: string, terms: readonly string[]): Snippet {
  const parts: SnippetPart[] = []
  let hit = false
  let buf = ''
  for (const ch of headline) {
    if (ch === HIGHLIGHT_START || ch === HIGHLIGHT_STOP) {
      parts.push({ text: buf, hit })
      buf = ''
      hit = ch === HIGHLIGHT_START
      continue
    }
    buf += ch
  }
  parts.push({ text: buf, hit })
  const out = merge(parts.flatMap((p) => (p.hit ? [p] : highlightWords(p.text, terms))))
  if (!out.some((p) => p.hit)) {
    const around = snippetAround(body, terms)
    if (around) return around
  }
  const trimmed = parts
    .map((p) => p.text)
    .join('')
    .trim()
  return {
    parts: out,
    cutStart: trimmed.length > 0 && !body.startsWith(trimmed),
    cutEnd: trimmed.length > 0 && !body.endsWith(trimmed),
  }
}

/**
 * The text the `simple` vector is built from: folded, and split into runs of letters and digits the
 * way query words are ('brief.pdf' → 'brief pdf', 'e-mail' → 'e mail'). The english vector keeps
 * Postgres' own tokens (URLs, e-mail addresses, file names) from the original text.
 */
export function simpleIndexText(body: string): string {
  return foldText(body).replace(/[^\p{L}\p{N}]+/gu, ' ')
}
