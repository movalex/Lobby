// OWNER: WS3 (wave V, the join card; docs/WAVE-V-CONTRACTS.md §3.3). The one place Lobby touches the QR library
// (qrcode-generator 2.0.4, MIT, no dependencies; pinned in the catalog), so it can be replaced and is unit-tested by
// golden matrices. Only its module matrix is used: the card draws the SVG itself (QrCard.tsx), never the library's
// createDataURL / createImgTag / createSvgTag / renderTo2dContext, so no `data:` or `blob:` URL, canvas or external
// reference is ever made. Pure: no DOM, no request.
import qrcode from 'qrcode-generator'

export type QrErrorLevel = 'L' | 'M' | 'Q' | 'H'

/** The quiet zone around the modules, in modules (the QR standard's 4). */
export const QR_QUIET_ZONE = 4
/** Longest text the card encodes (a join URL is ~45 characters; an invite URL ~80). */
export const QR_TEXT_MAX = 512

/**
 * The QR's dark modules (true = dark), row by row, without the quiet zone. The smallest version that holds `text` at
 * `ec` (M by default: about 15% of the code may be damaged or covered and it still reads). Byte mode, UTF-8.
 */
export function qrMatrix(text: string, ec: QrErrorLevel = 'M'): boolean[][] {
  if (typeof text !== 'string' || text.length === 0 || text.length > QR_TEXT_MAX)
    throw new Error('qrMatrix: 1 to 512 characters')
  const qr = qrcode(0, ec)
  qr.addData(utf8Latin1(text), 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  const rows: boolean[][] = []
  for (let r = 0; r < n; r++) {
    const row: boolean[] = []
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c))
    rows.push(row)
  }
  return rows
}

/**
 * The text as UTF-8 bytes in a string of code units 0-255: the library's Byte mode takes each code unit as one byte
 * (its default stringToBytes), so anything outside ASCII is encoded exactly once, as UTF-8.
 */
function utf8Latin1(text: string): string {
  let out = ''
  for (const b of new TextEncoder().encode(text)) out += String.fromCharCode(b)
  return out
}

/** The QR version of an n×n matrix (21 → 1, 25 → 2, …). */
export const qrVersion = (matrix: readonly (readonly boolean[])[]) => (matrix.length - 17) / 4

/**
 * One SVG path of every dark module, in module units, shifted by the quiet zone: runs of dark modules in a row are one
 * rectangle each (`M x y h w v 1 h -w z`), so a version 3 code is a few hundred short commands.
 */
export function qrPath(matrix: readonly (readonly boolean[])[], quiet = QR_QUIET_ZONE): string {
  const parts: string[] = []
  matrix.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (!row[x]) {
        x++
        continue
      }
      let w = 1
      while (row[x + w]) w++
      parts.push(`M${x + quiet} ${y + quiet}h${w}v1h-${w}z`)
      x += w
    }
  })
  return parts.join('')
}

/** The side of the drawn square in modules, the quiet zone on both sides included. */
export const qrSide = (matrix: readonly (readonly boolean[])[], quiet = QR_QUIET_ZONE) =>
  matrix.length + 2 * quiet
