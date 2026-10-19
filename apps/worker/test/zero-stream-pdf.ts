// The wave W review's M3 file, generated at run time (no binary fixture is committed): a one-page PDF whose page
// content stream, or whose font program, is a FlateDecode-compressed block of zeros. About 1.5 MB on disk, it inflates
// to about 1.5 GB inside pdf.js, outside the V8 heap. Node built-ins only: test/rss-cap-check.ts imports this inside
// the worker image (prod dependencies only, no pdf-lib).

import { constants, createDeflate } from 'node:zlib'

export type ZeroStreamWhere = 'content' | 'font'

/** zlib (RFC 1950) of `bytes` zeros, streamed in 16 MiB chunks so the zeros never sit in memory at once. */
export async function deflatedZeros(bytes: number): Promise<Buffer> {
  const z = createDeflate({ level: constants.Z_BEST_COMPRESSION, memLevel: 9 })
  const out: Buffer[] = []
  z.on('data', (b: Buffer) => out.push(b))
  const done = new Promise<void>((resolve, reject) => {
    z.on('end', () => resolve())
    z.on('error', reject)
  })
  const chunk = Buffer.alloc(16 * 1024 * 1024)
  let left = bytes
  while (left > 0) {
    const n = Math.min(left, chunk.length)
    left -= n
    if (!z.write(n === chunk.length ? chunk : chunk.subarray(0, n)))
      await new Promise<void>((r) => z.once('drain', () => r()))
  }
  z.end()
  await done
  return Buffer.concat(out)
}

/**
 * The PDF: `where` = 'content' puts the zeros in the page's content stream; 'font' in a TrueType font's FontFile2 that
 * the page uses. `inflatedBytes` defaults to 1.5 GiB (about 1.5 MB compressed, the review's file).
 */
export async function zeroStreamPdf(
  where: ZeroStreamWhere,
  inflatedBytes = 1536 * 1024 * 1024,
): Promise<Buffer> {
  const zeros = await deflatedZeros(inflatedBytes)
  const parts: Buffer[] = []
  const offsets: number[] = []
  let length = 0
  const push = (b: Buffer | string) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b
    parts.push(buf)
    length += buf.length
  }
  const obj = (n: number, body: string, stream?: Buffer) => {
    offsets[n] = length
    push(`${n} 0 obj\n${body}\n`)
    if (stream) {
      push('stream\n')
      push(stream)
      push('\nendstream\n')
    }
    push('endobj\n')
  }
  push('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  )
  obj(
    4,
    where === 'font'
      ? '<< /Type /Font /Subtype /TrueType /BaseFont /LobbyZero /FirstChar 32 /LastChar 126 /FontDescriptor 6 0 R >>'
      : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  )
  if (where === 'content') {
    obj(5, `<< /Length ${zeros.length} /Filter /FlateDecode >>`, zeros)
  } else {
    const text = Buffer.from('BT /F1 24 Tf 72 700 Td (Zero font) Tj ET', 'latin1')
    obj(5, `<< /Length ${text.length} >>`, text)
    obj(
      6,
      '<< /Type /FontDescriptor /FontName /LobbyZero /Flags 32 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>',
    )
    obj(7, `<< /Length ${zeros.length} /Filter /FlateDecode >>`, zeros)
  }
  return finish(parts, offsets, length, push)
}

/** A plain one-page PDF that says `text` in Helvetica (the control: a normal file under the same caps). */
export function plainPdf(text = 'Hello Lobby'): Buffer {
  const parts: Buffer[] = []
  const offsets: number[] = []
  let length = 0
  const push = (b: Buffer | string) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b
    parts.push(buf)
    length += buf.length
  }
  const obj = (n: number, body: string) => {
    offsets[n] = length
    push(`${n} 0 obj\n${body}\nendobj\n`)
  }
  const content = `BT /F1 24 Tf 72 700 Td (${text.replace(/[()\\]/g, '')}) Tj ET`
  push('%PDF-1.7\n')
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  )
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  return finish(parts, offsets, length, push)
}

function finish(parts: Buffer[], offsets: number[], length: number, push: (b: string) => void): Buffer {
  const count = offsets.length
  push(`xref\n0 ${count}\n0000000000 65535 f \n`)
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`)
  return Buffer.concat(parts)
}
