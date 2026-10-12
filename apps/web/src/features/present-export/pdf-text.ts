// The PDF's title and text helpers that need no PDF library (wave N, N6-1): the page imports these alone, so the
// PDF library (@cantoo/pdf-lib, in the worker's chunk) never loads on the board's thread unless workers are
// unavailable. pdf-build.ts re-exports them.

// Windows-1252 (what the standard PDF fonts encode): ASCII, Latin-1 and these 27 code points.
const WIN_ANSI_EXTRA = new Set(
  [0x20ac, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x17d]
    .concat([0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153])
    .concat([0x17e, 0x178]),
)

/** Whether the standard PDF font can show all of `text` (else the browser draws it as an image). */
export function isWinAnsi(text: string): boolean {
  for (const ch of text.normalize('NFC')) if (!isWinAnsiCodePoint(ch.codePointAt(0) ?? 0)) return false
  return true
}

/** Whether the standard PDF fonts encode this code point (the vector page's text runs read the same table). */
export function isWinAnsiCodePoint(cp: number): boolean {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp)
}

/** Single-line, bounded title text ('' when nothing is left). */
export function cleanTitle(title: string): string {
  const clean = String(title ?? '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters do not belong in a title
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(clean)
  return chars.length > 200 ? `${chars.slice(0, 199).join('')}…` : clean
}

/** Bookmark titles: trimmed, bounded, never empty. */
export function bookmarkTitle(title: string, index: number): string {
  return cleanTitle(title) || `Page ${index + 1}`
}

export const FALLBACK_DOCUMENT_TITLE = 'Lobby board'
