// What the api keeps of what a browser sends as feedback (wave J5). Pure: no I/O, no clock. Feedback is
// plain text that people read in the inbox and that the lead's tooling reads: it must not carry control
// characters (a terminal escape, a NUL that Postgres refuses), bidirectional overrides (text that reads
// backwards, an address that reads as another one) or lone surrogates (invalid UTF-16, which JSON and
// jsonb refuse). Nothing here is HTML: the web renders the text as text.
//
// The context block is parsed field by field: a field that is not valid is dropped or defaulted, never a
// reason to refuse the person's message.

import type { FeedbackContext } from '@draftroom/contracts'

/**
 * Code point ranges removed from every field: the controls except tab and newline (NUL included), DEL, the
 * C1 controls, the Arabic letter mark, the Mongolian vowel separator, the zero-width space, the left-to-right
 * and right-to-left marks, the bidi embeddings and overrides, the word joiner, the bidi isolates and the
 * byte-order mark. Zero-width joiners and non-joiners stay: emoji sequences and several scripts need them.
 * Written as numbers (not escapes) so no invisible character ever sits in this file.
 */
export const STRIPPED_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  [0x007f, 0x009f],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200b],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2060],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
]

const inClass = ([from, to]: readonly [number, number]) =>
  from === to ? String.fromCodePoint(from) : `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`

/** The ranges above (a class built from the table), and any surrogate that is not half of a pair. */
const STRIP = new RegExp(`[${STRIPPED_RANGES.map(inClass).join('')}]`, 'gu')
const LONE_SURROGATE = /\p{Cs}/gu

/** Line and paragraph separators and NEL: line breaks for our purposes (CRLF counts once). */
const BREAKS = new RegExp(`\r\n|[\r${String.fromCodePoint(0x85, 0x2028, 0x2029)}]`, 'g')

/** The number of characters (code points) of a string, as the limits count them. */
export function codePoints(s: string): number {
  let n = 0
  for (const _ of s) n++
  return n
}

/** The first `max` characters (code points) of a string: never splits a surrogate pair. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s // a string of `max` units has at most `max` characters
  return Array.from(s).slice(0, max).join('')
}

const strip = (s: string) => s.replace(STRIP, '').replace(LONE_SURROGATE, '')

/** Multi-line plain text: line breaks normalised, blank runs capped at two lines, edges trimmed. */
export function cleanText(raw: string): string {
  return strip(raw.replace(BREAKS, '\n'))
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

/** One line of plain text: any run of whitespace is one space. */
export function cleanLine(raw: string): string {
  return strip(raw.replace(BREAKS, ' ')).replace(/\s+/g, ' ').trim()
}

const BOARD_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/
const BUILD = /^[A-Za-z0-9._+-]{1,40}$/
const ISO_START = /^\d{4}-\d\d-\d\dT/
const UNKNOWN_PATH = '(unknown)'

/**
 * The page path, never a query string or fragment. `/invite/<token>` is the one path that carries a
 * secret, so its token is replaced.
 */
export function cleanPath(raw: unknown): string {
  if (typeof raw !== 'string') return UNKNOWN_PATH
  let p = cleanLine(raw.slice(0, 2_000))
  const cut = p.search(/[?#]/)
  if (cut >= 0) p = p.slice(0, cut)
  p = p.replaceAll(String.fromCharCode(92), '/') // a backslash reads as a slash
  if (!p.startsWith('/') || p.startsWith('//')) return UNKNOWN_PATH
  p = p.replace(/^\/invite\/[^/]*/, '/invite/:token')
  return truncate(p, 200)
}

const asObject = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const dimension = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(20_000, Math.round(v))) : 0

/**
 * The context block as it is stored. `fallbackAt` (the api's own clock, ISO) stands in for a missing or
 * unreadable time.
 */
export function cleanContext(raw: unknown, fallbackAt: string): FeedbackContext {
  const c = asObject(raw)
  const viewport = asObject(c.viewport)
  const boardId = typeof c.boardId === 'string' && BOARD_ID.test(c.boardId) ? c.boardId : null
  const title =
    boardId !== null && typeof c.boardTitle === 'string' ? truncate(cleanLine(c.boardTitle), 120) : ''
  const build = typeof c.build === 'string' ? cleanLine(c.build) : ''
  const sentAt = typeof c.at === 'string' ? c.at.slice(0, 64) : ''
  const at = ISO_START.test(sentAt) ? new Date(sentAt) : null
  return {
    path: cleanPath(c.path),
    boardId,
    boardTitle: title || null,
    userAgent: typeof c.userAgent === 'string' ? truncate(cleanLine(c.userAgent), 300) : '',
    viewport: { width: dimension(viewport.width), height: dimension(viewport.height) },
    build: BUILD.test(build) ? build : 'unknown',
    at: at && Number.isFinite(at.getTime()) ? at.toISOString() : fallbackAt,
  }
}
