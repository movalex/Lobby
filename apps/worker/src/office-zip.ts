// Structural checks of an Office document's container, before LibreOffice sees it (office.ts):
//   - OOXML and ODF are ZIP files: the central directory must be intact, the entry count and the sum of
//     the declared uncompressed sizes are capped (a zip bomb is refused without inflating anything), the
//     parts a document needs must be there, and then no entry may inflate past its declared size (a
//     bomb that understates its sizes is refused after inflating at most what it declared);
//   - a password-protected ODF file says so in META-INF/manifest.xml (encryption-data);
//   - a password-protected OOXML file is not a ZIP at all but an MS-CFB compound file holding the
//     streams EncryptionInfo and EncryptedPackage.
// Everything here reads a bounded number of bytes at offsets the file itself states, and is checked
// against the real file size first.
import { type FileHandle, open } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw, inflateRawSync } from 'node:zlib'

export class ZipFormatError extends Error {
  /** 'limit': a cap was exceeded (too big, not broken). */
  readonly kind: 'invalid' | 'limit'
  constructor(message: string, kind: 'invalid' | 'limit' = 'invalid') {
    super(message)
    this.name = 'ZipFormatError'
    this.kind = kind
  }
}

export interface ZipEntry {
  name: string
  /** General-purpose bit flags (bit 0: encrypted). */
  flags: number
  /** 0 stored, 8 deflated. */
  method: number
  compressedSize: number
  size: number
  localHeaderOffset: number
}

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const EOCD_MIN = 22
const MAX_COMMENT = 0xffff
/** A central directory above this is not an Office document (10,000 entries with long names is ~1 MB). */
const MAX_CD_BYTES = 16 * 1024 * 1024

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fh.read(buf, 0, length, position)
  if (bytesRead !== length) throw new ZipFormatError('unexpected end of file')
  return buf
}

/** The central directory of a ZIP file. Throws ZipFormatError for anything that is not a plain, single-disk ZIP. */
export async function readZipDirectory(path: string, maxEntries: number): Promise<ZipEntry[]> {
  const fh = await open(path, 'r')
  try {
    const size = (await fh.stat()).size
    if (size < EOCD_MIN) throw new ZipFormatError('too small for a ZIP')
    const tailLen = Math.min(size, EOCD_MIN + MAX_COMMENT)
    const tail = await readAt(fh, size - tailLen, tailLen)
    // The end-of-central-directory record, found from the end; its comment must reach exactly to EOF.
    let eocd = -1
    for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG && i + EOCD_MIN + tail.readUInt16LE(i + 20) === tail.length) {
        eocd = i
        break
      }
    }
    if (eocd === -1) throw new ZipFormatError('no end of central directory (truncated or not a ZIP)')
    const disk = tail.readUInt16LE(eocd + 4)
    const cdDisk = tail.readUInt16LE(eocd + 6)
    const entriesHere = tail.readUInt16LE(eocd + 8)
    const entries = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (disk !== 0 || cdDisk !== 0 || entriesHere !== entries) throw new ZipFormatError('multi-disk ZIP')
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ZipFormatError('ZIP64 is not supported')
    }
    if (entries > maxEntries) throw new ZipFormatError(`too many entries (${entries})`, 'limit')
    const eocdAbs = size - tailLen + eocd
    if (cdSize > MAX_CD_BYTES || cdOffset + cdSize > eocdAbs)
      throw new ZipFormatError('bad central directory')
    const cd = await readAt(fh, cdOffset, cdSize)
    const out: ZipEntry[] = []
    let p = 0
    for (let n = 0; n < entries; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CD_SIG)
        throw new ZipFormatError('bad central directory entry')
      const flags = cd.readUInt16LE(p + 8)
      const method = cd.readUInt16LE(p + 10)
      const compressedSize = cd.readUInt32LE(p + 20)
      const uncompressed = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const localHeaderOffset = cd.readUInt32LE(p + 42)
      const end = p + 46 + nameLen + extraLen + commentLen
      if (end > cd.length) throw new ZipFormatError('bad central directory entry')
      if (compressedSize === 0xffffffff || uncompressed === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new ZipFormatError('ZIP64 is not supported')
      }
      if (localHeaderOffset + 30 > cdOffset) throw new ZipFormatError('entry outside the archive')
      // Bit 11: UTF-8 name. Otherwise CP437, which matches ASCII for every name an Office document uses.
      const raw = cd.subarray(p + 46, p + 46 + nameLen)
      const name = flags & 0x800 ? raw.toString('utf8') : raw.toString('latin1')
      out.push({ name, flags, method, compressedSize, size: uncompressed, localHeaderOffset })
      p = end
    }
    return out
  } finally {
    await fh.close()
  }
}

/** One entry's bytes, inflated, refusing more than `maxBytes` of output. */
export async function readZipEntry(path: string, entry: ZipEntry, maxBytes: number): Promise<Buffer> {
  if (entry.flags & 1) throw new ZipFormatError('encrypted entry')
  if (entry.size > maxBytes || entry.compressedSize > Math.max(maxBytes, 1024) * 2) {
    throw new ZipFormatError('entry too large', 'limit')
  }
  const fh = await open(path, 'r')
  try {
    const head = await readAt(fh, entry.localHeaderOffset, 30)
    if (head.readUInt32LE(0) !== LOCAL_SIG) throw new ZipFormatError('bad local header')
    const start = entry.localHeaderOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
    const data = await readAt(fh, start, entry.compressedSize)
    if (entry.method === 0) return data
    if (entry.method !== 8) throw new ZipFormatError(`unsupported compression method ${entry.method}`)
    try {
      return inflateRawSync(data, { maxOutputLength: maxBytes })
    } catch {
      throw new ZipFormatError('entry does not inflate')
    }
  } finally {
    await fh.close()
  }
}

/** `length` bytes from `start`, in chunks (ends early at EOF: the inflater then reports a truncated stream). */
async function* byteRange(fh: FileHandle, start: number, length: number) {
  let pos = start
  let left = length
  while (left > 0) {
    const buf = Buffer.alloc(Math.min(left, 64 * 1024))
    const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
    if (bytesRead === 0) return
    yield buf.subarray(0, bytesRead)
    pos += bytesRead
    left -= bytesRead
  }
}

/**
 * Inflates every entry, discarding the output, and refuses one that yields more bytes than it declares:
 * the declared sizes are what the zip-bomb cap was checked against, and a lying header must not get
 * past it. Stops each entry one byte past its declared size, so the work is bounded by the sum of the
 * declared sizes (already capped) and memory by zlib's window. Throws ZipFormatError ('limit' for an
 * entry that inflates past its declared size, 'invalid' for one that does not inflate at all).
 */
export async function checkInflatedSizes(path: string, entries: readonly ZipEntry[]): Promise<void> {
  const fh = await open(path, 'r')
  try {
    for (const entry of entries) {
      if (entry.method === 0) {
        if (entry.compressedSize !== entry.size) throw new ZipFormatError('stored entry size mismatch')
        continue
      }
      if (entry.method !== 8) continue // LibreOffice refuses other methods itself
      if (entry.compressedSize === 0) {
        if (entry.size !== 0) throw new ZipFormatError('entry does not inflate')
        continue
      }
      const head = await readAt(fh, entry.localHeaderOffset, 30)
      if (head.readUInt32LE(0) !== LOCAL_SIG) throw new ZipFormatError('bad local header')
      const start = entry.localHeaderOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
      const inflate = createInflateRaw()
      let out = 0
      let over = false
      inflate.on('data', (b: Buffer) => {
        out += b.length
        if (out > entry.size && !over) {
          over = true
          inflate.destroy()
        }
      })
      try {
        await pipeline(byteRange(fh, start, entry.compressedSize), inflate)
      } catch {
        if (!over) throw new ZipFormatError('entry does not inflate')
      }
      if (over) throw new ZipFormatError('an entry inflates past its declared size', 'limit')
    }
  } finally {
    await fh.close()
  }
}

// ---- MS-CFB (compound file): only as far as the directory entry names --------------------------------

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const END_OF_CHAIN = 0xfffffffe
/** Directory sectors followed before giving up (a 4096-byte sector holds 32 entries; Office files have a handful). */
const MAX_DIR_SECTORS = 64

/**
 * The stream and storage names in a compound file's directory. Follows the directory's FAT chain for at
 * most MAX_DIR_SECTORS sectors, using only the 109 FAT sectors the header lists (they map the first
 * ~7 MB of a file with 512-byte sectors, ~436 MB with 4096-byte ones). The first directory sector is
 * always read; the chain simply stops at a sector it cannot resolve.
 */
export async function cfbDirectoryNames(path: string): Promise<string[]> {
  const fh = await open(path, 'r')
  try {
    const size = (await fh.stat()).size
    if (size < 512) throw new ZipFormatError('too small for a compound file')
    const header = await readAt(fh, 0, 512)
    if (!header.subarray(0, 8).equals(CFB_MAGIC)) throw new ZipFormatError('not a compound file')
    const shift = header.readUInt16LE(0x1e)
    if (shift !== 9 && shift !== 12) throw new ZipFormatError('bad sector size')
    const sectorSize = 1 << shift
    const numFatSectors = header.readUInt32LE(0x2c)
    const firstDir = header.readUInt32LE(0x30)
    const sectorOffset = (s: number) => (s + 1) * sectorSize
    // The first 109 FAT sector numbers live in the header (DIFAT); that covers the directory chain of
    // every realistic document, and the loop below stops at anything it cannot resolve.
    const fatSectors: number[] = []
    for (let i = 0; i < Math.min(109, numFatSectors); i++) fatSectors.push(header.readUInt32LE(0x4c + i * 4))
    const perFat = sectorSize / 4
    const nextSector = async (s: number): Promise<number> => {
      const fatIndex = Math.floor(s / perFat)
      const fs = fatSectors[fatIndex]
      if (fs === undefined || sectorOffset(fs) + sectorSize > size) return END_OF_CHAIN
      const b = await readAt(fh, sectorOffset(fs) + (s % perFat) * 4, 4)
      return b.readUInt32LE(0)
    }
    const names: string[] = []
    const seen = new Set<number>()
    let s = firstDir
    for (let n = 0; n < MAX_DIR_SECTORS && s < 0xfffffffa && !seen.has(s); n++) {
      seen.add(s)
      if (sectorOffset(s) + sectorSize > size) break
      const sector = await readAt(fh, sectorOffset(s), sectorSize)
      for (let e = 0; e + 128 <= sector.length; e += 128) {
        const len = sector.readUInt16LE(e + 0x40) // bytes, including the UTF-16 terminator
        const type = sector[e + 0x42]
        if (type === 0 || len < 2 || len > 64) continue // unused entry
        names.push(sector.subarray(e, e + len - 2).toString('utf16le'))
      }
      s = await nextSector(s)
    }
    return names
  } finally {
    await fh.close()
  }
}
