// Messages between ops/extract-text.ts (the runner) and ops/pdf-text-child.ts (the isolated reader), and the one text
// rule both apply (wave W, WS3). Request on stdin; the pages go to `output` (a JSON array of {page, body}, ascending);
// one small JSON response on stdout.

export interface PdfTextRequest {
  /** worker-chosen path of the PDF (never a user file name) */
  input: string
  /** worker-chosen path the child writes the pages to */
  output: string
  /** read pages 1..min(pageCount, maxPages) */
  maxPages: number
  /** characters kept per page (after cleaning) */
  maxPageChars: number
  /** UTF-8 bytes kept in all; past it the child stops (truncated) */
  maxBytes: number
}

export type PdfTextResponse =
  | { ok: true; pageCount: number; pages: number; bytes: number; truncated: boolean }
  | { ok: false; reason: 'encrypted' | 'invalid'; name: string }

/**
 * The invisible code points cleanText removes (apps/api features/ai/sources.ts, the "cleanText rules"): C0 and C1
 * controls but the line break, the soft hyphen, zero-width and bidi controls, invisible operators and the byte-order
 * mark. Built from the numbers (no such character is ever written into this source).
 */
const INVISIBLE: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
]
const uEscape = (cp: number) => `\\u${cp.toString(16).padStart(4, '0')}`
const INVISIBLE_RE = new RegExp(
  `[${INVISIBLE.map(([a, b]) => (a === b ? uEscape(a) : `${uEscape(a)}-${uEscape(b)}`)).join('')}]+`,
  'gu',
)

/**
 * A page's text as stored: tabs as spaces, invisible characters removed, spaces collapsed within lines, at most two
 * line breaks in a row, trimmed, and cut at `max` UTF-16 units (the contract's `body.max(8000)` counts those; never half
 * a surrogate pair). '' when nothing is left.
 */
export function cleanPageText(raw: string, max: number): string {
  let s = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(INVISIBLE_RE, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (s.length > max)
    s = s
      .slice(0, max)
      .replace(/[\uD800-\uDBFF]$/, '')
      .trimEnd()
  return s
}
