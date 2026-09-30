// The matching half of B8's content-leak search (leak-check.ts, docs/EXCALIDRAW-MIGRATION.md §8.6.7): the
// forms a board string can take in an output, and how many of them a text holds. Pure (no file, no
// board): leak-check.ts feeds it the restored boards' strings and the outputs' text, and prints counts.
//
// V3 (part-3 round) found the first version matched only a staging line copied verbatim and whole. It
// missed a JSON-escaped copy (a report or log that serialises it: `\"`, `\n`), an HTML-escaped one (`&quot;`,
// `&amp;`), a partial one (a few of its words) and one the engine wrapped (line breaks inserted), and a
// 4-character string matched inside any longer word. Now:
//  - every output is also read NORMALIZED: JSON string escapes and HTML entities decoded, whitespace runs
//    (real or escaped line breaks included) collapsed to one space; a board string is normalized the same
//    way, so an escaped or wrapped copy is found like a verbatim one;
//  - a partial copy is found by its word windows: every 4 consecutive words of at least 18 characters, and
//    every 3 of at least 22 (shorter windows are ordinary phrases, "the same time");
//  - a string shorter than SHORT_TOKEN (8) characters matches only as a whole token (not inside a word),
//    and is counted apart: a short label ("Todo", "Q3 plan") cannot be told from an ordinary word, so it
//    is reported, never gating;
//  - a string that also occurs in the repo's own sources (template text, converter fixtures: public, not
//    board content) is counted apart as repo-shared.

/** Strings shorter than this match only as whole tokens and are counted apart (never gating). */
export const SHORT_TOKEN = 8
/** Word windows: [words, minimum characters]. */
export const WINDOWS: readonly (readonly [number, number])[] = [
  [4, 18],
  [3, 22],
]

const HTML_NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** JSON string escapes and HTML entities decoded, whitespace collapsed to single spaces, trimmed. */
export function normalizeText(text: string): string {
  const unJson = text.replace(
    /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g,
    (_m, hex: string | undefined, c: string) => {
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16))
      return c === 'n' || c === 'r' || c === 't' || c === 'b' || c === 'f' ? ' ' : c
    },
  )
  const unHtml = unJson.replace(
    /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|([a-zA-Z]{2,6}));/g,
    (m, dec, hex, name) => {
      if (dec) return String.fromCodePoint(Number(dec))
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16))
      return HTML_NAMED[(name as string).toLowerCase()] ?? m
    },
  )
  return unHtml.replace(/\s+/gu, ' ').trim()
}

export interface Needles {
  /** each board string, normalized, of SHORT_TOKEN characters or more */
  readonly long: readonly string[]
  /** each shorter one, normalized (whole-token matches, reported apart) */
  readonly short: readonly string[]
  /** word windows of the long strings, not themselves one of them */
  readonly windows: readonly string[]
}

/** The needles of `strings` (board strings, already filtered of ids, enums and numbers). */
export function needlesOf(strings: Iterable<string>): Needles {
  const long = new Set<string>()
  const short = new Set<string>()
  for (const raw of strings) {
    const s = normalizeText(raw)
    if (!s) continue
    if (s.length >= SHORT_TOKEN) long.add(s)
    else short.add(s)
  }
  const windows = new Set<string>()
  for (const s of long) {
    const words = s.split(' ')
    for (const [n, min] of WINDOWS)
      for (let i = 0; i + n <= words.length; i++) {
        const w = words.slice(i, i + n).join(' ')
        if (w.length >= min && w !== s && !long.has(w)) windows.add(w)
      }
  }
  return { long: [...long], short: [...short], windows: [...windows] }
}

const WORD = /[\p{L}\p{N}_]/u
/** `needle` occurs in `hay` as a whole token (no letter, digit or underscore right before or after it). */
export function hasToken(hay: string, needle: string): boolean {
  let at = hay.indexOf(needle)
  while (at >= 0) {
    const before = at > 0 ? hay[at - 1] : ''
    const after = hay[at + needle.length] ?? ''
    if (!(before && WORD.test(before)) && !(after && WORD.test(after))) return true
    at = hay.indexOf(needle, at + 1)
  }
  return false
}

export interface MatchCount {
  /** long board strings and word windows found in the text: the gate (must be 0) */
  readonly strings: number
  /** short strings found as whole tokens (reported, not gating) */
  readonly short: number
  /** matches of strings that also occur in the repo's sources (reported apart, not gating) */
  readonly repoShared: number
}

/**
 * How many needles `text` holds, in any of the forms above: each long string and each window found counts
 * once. `isRepoShared(needle)` says whether a needle also occurs in the repo's own sources.
 */
export function countMatches(
  text: string,
  n: Needles,
  isRepoShared: (needle: string) => boolean = () => false,
): MatchCount {
  const hay = normalizeText(text)
  let strings = 0
  let short = 0
  let repoShared = 0
  const found = (needle: string) => hay.includes(needle)
  for (const s of n.long)
    if (found(s)) {
      if (isRepoShared(s)) repoShared++
      else strings++
    }
  for (const w of n.windows)
    if (found(w)) {
      if (isRepoShared(w)) repoShared++
      else strings++
    }
  for (const s of n.short) if (hasToken(hay, s)) short++
  return { strings, short, repoShared }
}
