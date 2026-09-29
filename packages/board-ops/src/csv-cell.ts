// Engine-neutral CSV cells (RFC 4180 quoting, formula neutralization), moved here unchanged from csv.ts so
// the tldraw CSV (./csv.ts) and the element CSV (./elements/csv.ts) write the same cells.

export const CSV_HEADER = ['id', 'type', 'text', 'frame', 'color', 'x', 'y'] as const

/**
 * Formula triggers (OWASP CSV injection: `=` `+` `-` `@`, plus their fullwidth forms, which some
 * spreadsheet locales treat alike), also after leading whitespace (spreadsheets and "trim spaces"
 * import options can drop it), and a leading tab / CR.
 */
const FORMULA_PREFIX = /^(?:[\t\r]|\s*[=+\-@\uff1d\uff0b\uff0d\uff20])/u
const NEEDS_QUOTES = /[",\r\n]/

/**
 * One RFC 4180 field for a user-controlled string. Cells that a spreadsheet could evaluate as a formula
 * (first non-whitespace character `=`, `+`, `-`, `@` or a fullwidth form of them, or a leading tab or
 * CR) get a leading `'`; CR/CRLF inside text become LF; fields with a comma, quote or line break are
 * quoted with inner quotes doubled.
 */
export function csvTextCell(value: string): string {
  let cell = FORMULA_PREFIX.test(value) ? `'${value}` : value
  cell = cell.replace(/\r\n?/g, '\n')
  return NEEDS_QUOTES.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
}

export function csvNumberCell(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return Object.is(rounded, -0) ? '0' : String(rounded)
}
