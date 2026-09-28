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

/**
 * Turns a ts_headline result (with HIGHLIGHT_* markers) into snippet parts. Postgres marks what its
 * english dictionary matched (stems: 'running' marks 'runs'); words that match only through folding
 * ('cafe' → 'Café') or inside punctuation ('pdf' in 'brief.pdf') are marked here as well. `body` is
 * the indexed text, to tell whether the snippet was cut.
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
