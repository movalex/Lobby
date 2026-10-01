// The matching half of B8's content-leak search (leak-check.ts, docs/EXCALIDRAW-MIGRATION.md §8.6.7): the
// forms a board string can take in an output, and how many of them a text holds. Pure (no file, no
// board): leak-check.ts feeds it the restored boards' strings and the outputs' text, and prints counts.
//
// V3 (part-3 round) found the first version matched only a staging line copied verbatim and whole. It
// missed a JSON-escaped copy (a report or log that serialises it: `\"`, `\n`), an HTML-escaped one (`&quot;`,
// `&amp;`), a partial one (a few of its words) and one the engine wrapped (line breaks inserted), and a
// 4-character string matched inside any longer word. V3's re-check (wave 5, 2B) found it still missed a
// percent-encoded copy (a URL or a form body), an upper-cased one, one with zero-width or ANSI colour codes
// between its words, one cut short after fewer than 4 words, and a base64 one. Now:
//  - every output is also read NORMALIZED: ANSI escape sequences and zero-width characters (and soft
//    hyphens) removed, JSON string escapes and HTML entities decoded, Unicode NFKC, whitespace runs (real
//    or escaped line breaks included) collapsed to one space, and case folded; a board string is
//    normalized the same way, so an escaped, wrapped, coloured or upper-cased copy is found like a
//    verbatim one;
//  - besides the text itself, its percent-decoded form (`%20` and, for form bodies, `+` as a space) and the
//    decoded text of every base64 run of 16 characters or more are searched too;
//  - a partial copy is found by its word windows: every 4 consecutive words of at least 18 characters, and
//    every 3 of at least 22 (shorter windows are ordinary phrases, "the same time");
//  - a copy cut short (a log line truncated at a character limit, `…`) is found by its cuts: the first and
//    the last CUT_CHARS characters of every string of at least CUT_MIN characters, when they hold two words;
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
/** A truncated copy: the first / last CUT_CHARS characters of strings of CUT_MIN characters or more. */
export const CUT_CHARS = 16
export const CUT_MIN = 24
/** A base64 run this long or longer is decoded and searched. */
export const BASE64_MIN = 16

const HTML_NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are what it removes
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g
const ZERO_WIDTH = /[­᠎​-‏‪-‮⁠-⁤﻿]/g

/**
 * ANSI codes and zero-width characters removed, JSON string escapes and HTML entities decoded, NFKC,
 * whitespace collapsed to single spaces, trimmed, case folded.
 */
export function normalizeText(text: string): string {
  const plain = text.replace(ANSI, '').replace(ZERO_WIDTH, '')
  const unJson = plain.replace(
    /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g,
    (_m, hex: string | undefined, c: string) => {
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16))
      return c === 'n' || c === 'r' || c === 't' || c === 'b' || c === 'f' ? ' ' : c
    },
  )
  const unHtml = unJson.replace(
    /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|([a-zA-Z]{2,6}));/g,
    (m, dec, hex, name) => {
      const cp = dec ? Number(dec) : hex ? Number.parseInt(hex, 16) : null
      if (cp !== null) return cp <= 0x10ffff ? String.fromCodePoint(cp) : m
      return HTML_NAMED[(name as string).toLowerCase()] ?? m
    },
  )
  return unHtml.replace(ZERO_WIDTH, '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
}

/** Every `%XX` run decoded as UTF-8 where it is valid (`plus`: a `+` is a space, as in a form body). */
export function percentDecoded(text: string, plus: boolean): string {
  const t = plus ? text.replace(/\+/g, ' ') : text
  return t.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run
    }
  })
}

/** The decoded text of every base64 run (standard or URL alphabet) that decodes to readable UTF-8. */
export function base64Decoded(text: string): string[] {
  const out: string[] = []
  const re = new RegExp(`[A-Za-z0-9+/_-]{${BASE64_MIN},}={0,2}`, 'g')
  for (const m of text.matchAll(re)) {
    const run = m[0].replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Buffer.from(run, 'base64')
    if (bytes.length < 8) continue
    const s = bytes.toString('utf8')
    // mostly printable: a real encoded text, not a hash or an id read as base64
    const printable = [...s].filter((c) => c >= ' ' && c !== '�').length
    if (printable >= s.length * 0.9) out.push(s)
  }
  return out
}

/** The forms of an output that are searched (normalized each): the text, percent-decoded, base64 decoded. */
export function hayForms(text: string): string[] {
  const forms = new Set<string>([normalizeText(text)])
  if (/%[0-9a-fA-F]{2}/.test(text)) {
    forms.add(normalizeText(percentDecoded(text, false)))
    forms.add(normalizeText(percentDecoded(text, true)))
  }
  const decoded = base64Decoded(text)
  if (decoded.length) forms.add(normalizeText(decoded.join(' ')))
  return [...forms]
}

export interface Needles {
  /** each board string, normalized, of SHORT_TOKEN characters or more */
  readonly long: readonly string[]
  /** each shorter one, normalized (whole-token matches, reported apart) */
  readonly short: readonly string[]
  /** word windows of the long strings, not themselves one of them */
  readonly windows: readonly string[]
  /** the cuts of the long strings (a truncated copy), not themselves one of them */
  readonly cuts: readonly string[]
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
  const cuts = new Set<string>()
  for (const s of long) {
    const words = s.split(' ')
    for (const [n, min] of WINDOWS)
      for (let i = 0; i + n <= words.length; i++) {
        const w = words.slice(i, i + n).join(' ')
        if (w.length >= min && w !== s && !long.has(w)) windows.add(w)
      }
    if (s.length >= CUT_MIN)
      for (const c of [s.slice(0, CUT_CHARS).trim(), s.slice(-CUT_CHARS).trim()])
        if (c.includes(' ') && !long.has(c) && !windows.has(c)) cuts.add(c)
  }
  return { long: [...long], short: [...short], windows: [...windows], cuts: [...cuts] }
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
  /** long board strings, word windows and cuts found in the text: the gate (must be 0) */
  readonly strings: number
  /** short strings found as whole tokens (reported, not gating) */
  readonly short: number
  /** matches of strings that also occur in the repo's sources (reported apart, not gating) */
  readonly repoShared: number
}

/**
 * How many needles `text` holds, in any of the forms above: each long string, window and cut found counts
 * once. `isRepoShared(needle)` says whether a needle also occurs in the repo's own sources. `seen` (the
 * chunks of one file): a needle already counted there is not counted again, and the ones found are added.
 */
export function countMatches(
  text: string,
  n: Needles,
  isRepoShared: (needle: string) => boolean = () => false,
  seen: Set<string> = new Set(),
): MatchCount {
  const hays = hayForms(text)
  let strings = 0
  let short = 0
  let repoShared = 0
  const found = (needle: string) => hays.some((h) => h.includes(needle))
  for (const s of [...n.long, ...n.windows, ...n.cuts]) {
    if (seen.has(s) || !found(s)) continue
    seen.add(s)
    if (isRepoShared(s)) repoShared++
    else strings++
  }
  for (const s of n.short) {
    const key = `\u0000short:${s}`
    if (seen.has(key) || !hays.some((h) => hasToken(h, s))) continue
    seen.add(key)
    short++
  }
  return { strings, short, repoShared }
}
