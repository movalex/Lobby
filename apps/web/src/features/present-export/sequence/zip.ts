// OWNER: WS3 (wave T). A store-only ZIP writer for the browser (the design §3.2): the image sequence's PNGs are already
// compressed, so every entry is STORED (method 0) with its CRC-32 and sizes in its local header (no data descriptor),
// then the central directory and its end record. No dependency: packages/board-archive's writer is Node's (node:zlib),
// this one only needs a CRC table. UTF-8 names (general-purpose bit 11), no ZIP64 (at most ZIP_MAX_ENTRIES entries
// and 4 GiB - 1 of offsets, far above an animatic's frames), no encryption, no comment.
//
// Memory: an entry's bytes are read once for its CRC, then only the Blob is kept (the browser may page it out); the
// file is a Blob of the headers and those Blobs.

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
/** 1.0: stored entries only */
const VERSION = 10
const FLAG_UTF8 = 0x0800
const MAX_U32 = 0xffff_ffff
export const ZIP_MAX_ENTRIES = 65_534

let table: Uint32Array | null = null
function crcTable(): Uint32Array {
  if (table) return table
  table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
}

/** CRC-32 (IEEE 802.3, as ZIP and PNG use it) of `bytes`, continuing from `crc`. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  const t = crcTable()
  let c = (crc ^ MAX_U32) >>> 0
  for (let i = 0; i < bytes.length; i++) c = (t[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8)
  return (c ^ MAX_U32) >>> 0
}

/** MS-DOS time and date fields of `at` (UTC, two-second resolution, 1980..2107). */
export function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107)
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2)
  const date = ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate()
  return { time, date }
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

interface Written {
  name: Uint8Array
  flags: number
  crc: number
  size: number
  offset: number
}

const encoder = new TextEncoder()

/** An entry name: a relative path of `/`-separated parts, none empty, `.` or `..`, no backslash or NUL. */
function entryName(name: string): { bytes: Uint8Array; utf8: boolean } {
  const parts = name.split('/')
  if (
    !name ||
    name.length > 1024 ||
    /[\\\0]/.test(name) ||
    name.startsWith('/') ||
    parts.some((p) => !p || p === '.' || p === '..')
  )
    throw new ZipError(`invalid entry name: ${name}`)
  return { bytes: encoder.encode(name), utf8: !/^[\x20-\x7e]*$/.test(name) }
}

/** Builds a ZIP of stored entries, one `add` at a time, then `finish`. */
export class StoreZip {
  private readonly parts: BlobPart[] = []
  private readonly written: Written[] = []
  private readonly names = new Set<string>()
  private offset = 0
  private readonly time: number
  private readonly date: number

  constructor(at: Date = new Date()) {
    const d = dosDateTime(at)
    this.time = d.time
    this.date = d.date
  }

  /** Adds one file (its bytes, or a Blob read once for its CRC). Names are unique. */
  async add(name: string, data: Uint8Array | Blob): Promise<void> {
    if (this.names.has(name)) throw new ZipError(`duplicate entry name: ${name}`)
    if (this.written.length >= ZIP_MAX_ENTRIES) throw new ZipError('too many entries')
    const { bytes: nameBytes, utf8 } = entryName(name)
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer())
    const size = bytes.length
    if (this.offset + 30 + nameBytes.length + size > MAX_U32) throw new ZipError('the archive is too large')
    const crc = crc32(bytes)
    const flags = utf8 ? FLAG_UTF8 : 0
    const head = new Uint8Array(30 + nameBytes.length)
    const v = new DataView(head.buffer)
    v.setUint32(0, LOCAL_SIG, true)
    v.setUint16(4, VERSION, true)
    v.setUint16(6, flags, true)
    v.setUint16(8, 0, true) // stored
    v.setUint16(10, this.time, true)
    v.setUint16(12, this.date, true)
    v.setUint32(14, crc, true)
    v.setUint32(18, size, true)
    v.setUint32(22, size, true)
    v.setUint16(26, nameBytes.length, true)
    v.setUint16(28, 0, true)
    head.set(nameBytes, 30)
    this.parts.push(head, data instanceof Blob ? data : (bytes as BlobPart))
    this.written.push({ name: nameBytes, flags, crc, size, offset: this.offset })
    this.names.add(name)
    this.offset += head.length + size
  }

  /** The ZIP file. */
  finish(): Blob {
    const start = this.offset
    let dirSize = 0
    for (const w of this.written) {
      const rec = new Uint8Array(46 + w.name.length)
      const v = new DataView(rec.buffer)
      v.setUint32(0, CENTRAL_SIG, true)
      v.setUint16(4, VERSION, true) // made by: MS-DOS, 1.0
      v.setUint16(6, VERSION, true)
      v.setUint16(8, w.flags, true)
      v.setUint16(10, 0, true)
      v.setUint16(12, this.time, true)
      v.setUint16(14, this.date, true)
      v.setUint32(16, w.crc, true)
      v.setUint32(20, w.size, true)
      v.setUint32(24, w.size, true)
      v.setUint16(28, w.name.length, true)
      v.setUint16(30, 0, true)
      v.setUint16(32, 0, true)
      v.setUint16(34, 0, true)
      v.setUint16(36, 0, true)
      v.setUint32(38, 0, true)
      v.setUint32(42, w.offset, true)
      rec.set(w.name, 46)
      this.parts.push(rec)
      dirSize += rec.length
    }
    if (start + dirSize > MAX_U32) throw new ZipError('the archive is too large')
    const end = new Uint8Array(22)
    const v = new DataView(end.buffer)
    v.setUint32(0, EOCD_SIG, true)
    v.setUint16(4, 0, true)
    v.setUint16(6, 0, true)
    v.setUint16(8, this.written.length, true)
    v.setUint16(10, this.written.length, true)
    v.setUint32(12, dirSize, true)
    v.setUint32(16, start, true)
    v.setUint16(20, 0, true)
    this.parts.push(end)
    return new Blob(this.parts, { type: 'application/zip' })
  }
}
