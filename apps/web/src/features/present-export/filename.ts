// Download file names built from the board title (user-controlled text): safe on Windows, macOS and
// Linux, no path parts, no control or bidi-override characters, bounded length.

export type ExportExtension = 'png' | 'svg' | 'pdf' | 'csv'

export const FALLBACK_FILENAME = 'Draftroom board'
/** Code points kept from the base name (before " - qualifier.ext"). */
export const MAX_BASE_CHARS = 80
/** UTF-8 bytes for the whole name: common filesystems cap a name at 255 bytes. */
export const MAX_NAME_BYTES = 240

// C0/C1 controls, DEL, BOM, zero-width and bidi controls (U+202E can make "gnp.exe" read as "exe.png").
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g
const SEPARATORS = /[\\/|]/g
const RESERVED = /[<>:"*?]/g
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length

/** Cuts to `maxChars` code points (never splitting a surrogate pair). */
function truncateChars(s: string, maxChars: number): string {
  const chars = Array.from(s)
  return chars.length <= maxChars ? s : chars.slice(0, maxChars).join('')
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
}

/**
 * One file-name component from free text. Path separators become "-", characters Windows forbids are
 * dropped, whitespace collapses, leading dots (hidden files) and trailing dots/spaces (invalid on
 * Windows) go, device names (CON, NUL, COM1…) get a "_" prefix. Empty results use `fallback`.
 */
export function sanitizeFilename(
  raw: string,
  fallback = FALLBACK_FILENAME,
  maxChars = MAX_BASE_CHARS,
): string {
  const cleaned = tidy(
    String(raw ?? '')
      .normalize('NFC')
      .replace(/[\t\n\v\f\r]/g, ' ')
      .replace(INVISIBLE, '')
      .replace(SEPARATORS, '-')
      .replace(RESERVED, ''),
  )
  let name = tidy(truncateChars(cleaned, maxChars))
  if (!name) return fallback
  if (WINDOWS_DEVICE.test(name)) name = `_${name}`
  return name
}

/**
 * `<board title>[ - <qualifier>].<ext>`, e.g. "Spring campaign - Moodboard.png". The whole name stays
 * under MAX_NAME_BYTES of UTF-8 by shortening the title first, then the qualifier.
 */
export function exportFilename(boardTitle: string, ext: ExportExtension, qualifier?: string): string {
  let base = sanitizeFilename(boardTitle)
  let extra = qualifier === undefined ? '' : sanitizeFilename(qualifier, '', 60)
  const build = () => `${base}${extra ? ` - ${extra}` : ''}.${ext}`
  while (utf8Bytes(build()) > MAX_NAME_BYTES && Array.from(base).length > 1) {
    base = tidy(truncateChars(base, Array.from(base).length - 1)) || 'Board'
  }
  while (utf8Bytes(build()) > MAX_NAME_BYTES && extra) {
    extra = tidy(truncateChars(extra, Array.from(extra).length - 1))
  }
  return build()
}
