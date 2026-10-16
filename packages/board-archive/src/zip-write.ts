// A streaming ZIP writer on node:zlib (wave R, WS4; docs/WAVE-R-CONTRACTS.md §5). No dependency: `zlib.crc32` (Node
// ≥ 22.2) and `deflateRawSync`. What it writes is the plain, single-disk ZIP every unzip tool reads:
//   - an in-memory entry (`data`) is STORED (method 0) or DEFLATED (method 8) with its CRC and sizes in its local
//     header;
//   - a streamed entry (`stream`, an original file) is STORED with general-purpose bit 3: its local header carries
//     zeros, and a data descriptor (signature, CRC-32, sizes) follows the bytes, because the CRC is known only once
//     they went through. Its size is stated up front and must be exactly what the stream yields (else the write
//     fails, and the caller ends the response: a short or long file never becomes a "valid" backup);
//   - no ZIP64, no encryption, no comment, no extra fields: past 65,534 entries or 4 GiB − 1 of offsets the write
//     fails (BACKUP_LIMITS keep a backup far below both).
// Memory is one chunk of a streamed entry, plus the in-memory entries and the central directory.

import { crc32, deflateRawSync } from 'node:zlib'

const LOCAL_SIG = 0x04034b50
const DESCRIPTOR_SIG = 0x08074b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
/** 2.0: deflate and data descriptors */
const VERSION = 20
const FLAG_DESCRIPTOR = 0x0008
const FLAG_UTF8 = 0x0800
const MAX_U32 = 0xffff_ffff

/** The most entries a ZIP without ZIP64 can say it has (0xffff marks ZIP64). */
export const ZIP_MAX_ENTRIES = 65_534

export class ZipWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipWriteError'
  }
}

export type ZipWriteEntry =
  | { readonly name: string; readonly data: Uint8Array; readonly method: 0 | 8 }
  | { readonly name: string; readonly stream: AsyncIterable<Uint8Array>; readonly size: number }

interface Written {
  name: Buffer
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  offset: number
}

/** MS-DOS time and date fields (local time is not meaningful here: UTC, two-second resolution). */
export function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107)
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2)
  const date = ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate()
  return { time, date }
}

function nameBytes(name: string): { bytes: Buffer; utf8: boolean } {
  if (!name || name.length > 1024 || name.includes('\0')) throw new ZipWriteError('invalid entry name')
  const bytes = Buffer.from(name, 'utf8')
  return { bytes, utf8: !/^[\x20-\x7e]*$/.test(name) }
}

function localHeader(
  e: Omit<Written, 'offset'>,
  stamp: { time: number; date: number },
  descriptor: boolean,
): Buffer {
  const b = Buffer.alloc(30)
  b.writeUInt32LE(LOCAL_SIG, 0)
  b.writeUInt16LE(VERSION, 4)
  b.writeUInt16LE(e.flags, 6)
  b.writeUInt16LE(e.method, 8)
  b.writeUInt16LE(stamp.time, 10)
  b.writeUInt16LE(stamp.date, 12)
  b.writeUInt32LE(descriptor ? 0 : e.crc, 14)
  b.writeUInt32LE(descriptor ? 0 : e.compressedSize, 18)
  b.writeUInt32LE(descriptor ? 0 : e.size, 22)
  b.writeUInt16LE(e.name.length, 26)
  b.writeUInt16LE(0, 28)
  return Buffer.concat([b, e.name])
}

function centralEntry(e: Written, stamp: { time: number; date: number }): Buffer {
  const b = Buffer.alloc(46)
  b.writeUInt32LE(CENTRAL_SIG, 0)
  b.writeUInt16LE(VERSION, 4) // made by: MS-DOS, 2.0
  b.writeUInt16LE(VERSION, 6)
  b.writeUInt16LE(e.flags, 8)
  b.writeUInt16LE(e.method, 10)
  b.writeUInt16LE(stamp.time, 12)
  b.writeUInt16LE(stamp.date, 14)
  b.writeUInt32LE(e.crc, 16)
  b.writeUInt32LE(e.compressedSize, 20)
  b.writeUInt32LE(e.size, 24)
  b.writeUInt16LE(e.name.length, 28)
  // extra, comment, disk, internal and external attributes: 0
  b.writeUInt32LE(e.offset, 42)
  return Buffer.concat([b, e.name])
}

/**
 * The ZIP of `entries`, in order, as chunks. Fails (throws from the generator) when an entry is invalid, a streamed
 * entry yields another number of bytes than its `size`, or the archive would need ZIP64.
 */
export async function* zipStream(
  entries: Iterable<ZipWriteEntry> | AsyncIterable<ZipWriteEntry>,
  opts: { at?: Date } = {},
): AsyncGenerator<Buffer, void, undefined> {
  const stamp = dosDateTime(opts.at ?? new Date())
  const written: Written[] = []
  const names = new Set<string>()
  let offset = 0
  const room = (bytes: number) => {
    if (offset + bytes > MAX_U32) throw new ZipWriteError('the archive would need ZIP64')
  }
  for await (const entry of entries) {
    if (written.length >= ZIP_MAX_ENTRIES) throw new ZipWriteError('too many entries')
    if (names.has(entry.name)) throw new ZipWriteError('duplicate entry name')
    names.add(entry.name)
    const { bytes: name, utf8 } = nameBytes(entry.name)
    if ('data' in entry) {
      const data = entry.method === 8 ? deflateRawSync(entry.data) : Buffer.from(entry.data)
      const e: Written = {
        name,
        flags: utf8 ? FLAG_UTF8 : 0,
        method: entry.method,
        crc: crc32(entry.data),
        compressedSize: data.length,
        size: entry.data.length,
        offset,
      }
      const head = localHeader(e, stamp, false)
      room(head.length + data.length)
      written.push(e)
      offset += head.length + data.length
      yield head
      if (data.length) yield data
      continue
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new ZipWriteError('invalid entry size')
    const e: Written = {
      name,
      flags: FLAG_DESCRIPTOR | (utf8 ? FLAG_UTF8 : 0),
      method: 0,
      crc: 0,
      compressedSize: entry.size,
      size: entry.size,
      offset,
    }
    const head = localHeader(e, stamp, true)
    room(head.length + entry.size + 16)
    offset += head.length
    yield head
    let crc = 0
    let seen = 0
    for await (const chunk of entry.stream) {
      seen += chunk.length
      if (seen > entry.size) throw new ZipWriteError('a file is longer than its stated size')
      crc = crc32(chunk, crc)
      yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    }
    if (seen !== entry.size) throw new ZipWriteError('a file is shorter than its stated size')
    e.crc = crc
    const d = Buffer.alloc(16)
    d.writeUInt32LE(DESCRIPTOR_SIG, 0)
    d.writeUInt32LE(crc, 4)
    d.writeUInt32LE(entry.size, 8)
    d.writeUInt32LE(entry.size, 12)
    offset += entry.size + 16
    written.push(e)
    yield d
  }
  const central = Buffer.concat(written.map((e) => centralEntry(e, stamp)))
  room(central.length + 22)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD_SIG, 0)
  // disk numbers: 0
  end.writeUInt16LE(written.length, 8)
  end.writeUInt16LE(written.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  // comment length: 0
  yield central
  yield end
}

/** Collects a ZIP into one buffer (tests and small archives). */
export async function zipToBuffer(
  entries: Iterable<ZipWriteEntry> | AsyncIterable<ZipWriteEntry>,
  opts: { at?: Date } = {},
): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const part of zipStream(entries, opts)) parts.push(part)
  return Buffer.concat(parts)
}
