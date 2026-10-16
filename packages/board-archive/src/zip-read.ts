// A ZIP reader over byte ranges (wave R, WS4; docs/WAVE-R-CONTRACTS.md §5). Lifted from the worker's
// apps/worker/src/office-zip.ts (which keeps its copy) and made stricter, because a restore reads a file anybody can
// make. It never trusts a size it has not checked against the file, and reads a bounded number of bytes at offsets
// the file states:
//   - the end-of-central-directory record must be the file's last 22 bytes (no comment: a fake record hidden in a
//     comment cannot be picked), single disk, no ZIP64 (markers, sizes or its locator), the central directory at most
//     `maxCentralDirectoryBytes` and ending exactly where that record starts, at most `maxEntries` entries;
//   - every name passes `acceptName` and the generic rules (no NUL, backslash, absolute path, drive letter, `.` or
//     `..` segment, control character), and appears once;
//   - no encryption (bit 0, bit 6), methods 0 and 8 only, a STORED entry's two sizes equal, each declared size under
//     its cap, their sum under `maxTotalBytes`, and a deflated entry above `ratioFloorBytes` no more than `maxRatio`
//     times its compressed size (a bomb is refused before anything is inflated);
//   - the first entry starts at byte 0 (nothing hidden in front), entries do not overlap and each lies before the
//     central directory;
//   - when an entry is read, its local header must agree with the central directory (signature, name, method,
//     encryption, and the CRC and sizes unless bit 3 defers them), the bytes must fit before the next entry, inflating
//     stops at the declared size (an understated size is refused after at most that many bytes), and the size and
//     CRC-32 of what came out must be the declared ones.

import { open } from 'node:fs/promises'
import { crc32, inflateRawSync } from 'node:zlib'

export class ZipFormatError extends Error {
  /** 'limit': a cap was exceeded (too large, not broken). */
  readonly kind: 'invalid' | 'limit'
  constructor(message: string, kind: 'invalid' | 'limit' = 'invalid') {
    super(message)
    this.name = 'ZipFormatError'
    this.kind = kind
  }
}

/** Random access to the archive's bytes: a buffer, a file, or ranges of a stored object. */
export interface RangeSource {
  readonly size: number
  /** exactly `length` bytes from `start` (throws when the source has fewer) */
  read(start: number, length: number): Promise<Buffer>
  /** `length` bytes from `start` as chunks (may end early at the end of the source) */
  stream(start: number, length: number): AsyncIterable<Buffer>
}

export function bufferSource(buf: Buffer): RangeSource {
  return {
    size: buf.length,
    async read(start, length) {
      if (start < 0 || length < 0 || start + length > buf.length)
        throw new ZipFormatError('unexpected end of file')
      return buf.subarray(start, start + length)
    },
    async *stream(start, length) {
      const end = Math.min(buf.length, start + length)
      for (let p = start; p < end; p += 64 * 1024) yield buf.subarray(p, Math.min(end, p + 64 * 1024))
    },
  }
}

/** A file on disk as a RangeSource (tests, local tools); close it when done. */
export async function fileSource(path: string): Promise<RangeSource & { close(): Promise<void> }> {
  const fh = await open(path, 'r')
  const size = (await fh.stat()).size
  const read = async (start: number, length: number) => {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, start)
    if (bytesRead !== length) throw new ZipFormatError('unexpected end of file')
    return buf
  }
  return {
    size,
    read,
    async *stream(start, length) {
      let pos = start
      let left = Math.min(length, size - start)
      while (left > 0) {
        const n = Math.min(left, 64 * 1024)
        const buf = Buffer.alloc(n)
        const { bytesRead } = await fh.read(buf, 0, n, pos)
        if (bytesRead === 0) return
        yield buf.subarray(0, bytesRead)
        pos += bytesRead
        left -= bytesRead
      }
    },
    close: () => fh.close(),
  }
}

export interface ZipEntry {
  readonly name: string
  /** general-purpose bit flags */
  readonly flags: number
  /** 0 stored, 8 deflated */
  readonly method: number
  readonly crc32: number
  readonly compressedSize: number
  readonly size: number
  readonly localHeaderOffset: number
  /** where the next entry (or the central directory) starts: this entry's bytes must end before it */
  readonly boundary: number
}

export interface ZipReadLimits {
  maxEntries: number
  maxCentralDirectoryBytes: number
  /** the declared uncompressed sizes together */
  maxTotalBytes: number
  /** the cap of one entry's declared uncompressed size */
  maxEntryBytes(name: string): number
  /** whether a name may be in this kind of archive at all */
  acceptName(name: string): boolean
  /** a deflated entry may be at most this many times its compressed size … */
  maxRatio: number
  /** … once it declares more than this many bytes */
  ratioFloorBytes: number
}

const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const EOCD_LEN = 22
const FLAG_ENCRYPTED = 0x0001
const FLAG_DESCRIPTOR = 0x0008
const FLAG_STRONG_ENCRYPTION = 0x0040
const FLAG_UTF8 = 0x0800
const MAX_U32 = 0xffff_ffff

/** The generic name rules (on top of `acceptName`): nothing a file system could read as a path out. */
export function unsafeEntryName(name: string): boolean {
  if (!name || name.length > 1024) return true
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (/[\u0000-\u001f\u007f\\:]/.test(name)) return true
  if (name.startsWith('/')) return true
  return name.split('/').some((s) => s === '' || s === '.' || s === '..')
}

/** The central directory, checked (see the top of this file). Throws ZipFormatError. */
export async function readZipDirectory(src: RangeSource, limits: ZipReadLimits): Promise<ZipEntry[]> {
  const size = src.size
  if (size < EOCD_LEN) throw new ZipFormatError('too small for a ZIP')
  const eocdAt = size - EOCD_LEN
  const eocd = await src.read(eocdAt, EOCD_LEN)
  if (eocd.readUInt32LE(0) !== EOCD_SIG) throw new ZipFormatError('no end of central directory at the end')
  if (eocd.readUInt16LE(20) !== 0) throw new ZipFormatError('an archive comment')
  const disk = eocd.readUInt16LE(4)
  const cdDisk = eocd.readUInt16LE(6)
  const entriesHere = eocd.readUInt16LE(8)
  const count = eocd.readUInt16LE(10)
  const cdSize = eocd.readUInt32LE(12)
  const cdOffset = eocd.readUInt32LE(16)
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== count) throw new ZipFormatError('a multi-disk ZIP')
  if (count === 0xffff || cdSize === MAX_U32 || cdOffset === MAX_U32) throw new ZipFormatError('ZIP64')
  if (eocdAt >= 20) {
    const locator = await src.read(eocdAt - 20, 4)
    if (locator.readUInt32LE(0) === ZIP64_LOCATOR_SIG) throw new ZipFormatError('ZIP64')
  }
  if (count > limits.maxEntries) throw new ZipFormatError(`too many entries (${count})`, 'limit')
  if (cdSize > limits.maxCentralDirectoryBytes)
    throw new ZipFormatError('the central directory is too large', 'limit')
  if (cdOffset + cdSize !== eocdAt) throw new ZipFormatError('the central directory is not where it says')
  const cd = await src.read(cdOffset, cdSize)
  const raw: Omit<ZipEntry, 'boundary'>[] = []
  const names = new Set<string>()
  let total = 0
  let p = 0
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CD_SIG)
      throw new ZipFormatError('a bad central directory entry')
    const flags = cd.readUInt16LE(p + 8)
    const method = cd.readUInt16LE(p + 10)
    const crc = cd.readUInt32LE(p + 16)
    const compressedSize = cd.readUInt32LE(p + 20)
    const uncompressed = cd.readUInt32LE(p + 24)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    const diskStart = cd.readUInt16LE(p + 34)
    const localHeaderOffset = cd.readUInt32LE(p + 42)
    const end = p + 46 + nameLen + extraLen + commentLen
    if (end > cd.length) throw new ZipFormatError('a bad central directory entry')
    if (compressedSize === MAX_U32 || uncompressed === MAX_U32 || localHeaderOffset === MAX_U32)
      throw new ZipFormatError('ZIP64')
    if (diskStart !== 0) throw new ZipFormatError('a multi-disk ZIP')
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen)
    // bit 11: UTF-8; otherwise only plain ASCII is read (CP437 above 0x7f is refused rather than guessed)
    if (!(flags & FLAG_UTF8) && nameBytes.some((b) => b > 0x7f))
      throw new ZipFormatError('a name that is not ASCII')
    const name = nameBytes.toString('utf8')
    if (Buffer.byteLength(name, 'utf8') !== nameLen) throw new ZipFormatError('a name that is not UTF-8')
    if (unsafeEntryName(name) || !limits.acceptName(name))
      throw new ZipFormatError('an entry name that is not allowed')
    if (names.has(name)) throw new ZipFormatError('a duplicate entry name')
    names.add(name)
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw new ZipFormatError('an encrypted entry')
    if (method !== 0 && method !== 8) throw new ZipFormatError(`compression method ${method}`)
    if (method === 0 && compressedSize !== uncompressed)
      throw new ZipFormatError('a stored entry with two sizes')
    if (uncompressed > limits.maxEntryBytes(name)) throw new ZipFormatError('an entry is too large', 'limit')
    const ratio = uncompressed > compressedSize * limits.maxRatio
    if (method === 8 && uncompressed > limits.ratioFloorBytes && ratio)
      throw new ZipFormatError('an entry compresses too well to be real', 'limit')
    total += uncompressed
    if (total > limits.maxTotalBytes) throw new ZipFormatError('the entries are too large together', 'limit')
    raw.push({ name, flags, method, crc32: crc, compressedSize, size: uncompressed, localHeaderOffset })
    p = end
  }
  if (p !== cd.length) throw new ZipFormatError('the central directory has bytes after its entries')
  // order by position: no prefix, no overlap, all before the central directory
  const sorted = [...raw].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset)
  if (sorted.length && sorted[0]?.localHeaderOffset !== 0)
    throw new ZipFormatError('bytes before the first entry')
  const boundaries = new Map<string, number>()
  for (const [i, e] of sorted.entries()) {
    const boundary = sorted[i + 1]?.localHeaderOffset ?? cdOffset
    const nameLen = Buffer.byteLength(e.name, 'utf8')
    const descriptor = e.flags & FLAG_DESCRIPTOR ? 12 : 0
    if (e.localHeaderOffset + 30 + nameLen + e.compressedSize + descriptor > boundary)
      throw new ZipFormatError('entries overlap')
    boundaries.set(e.name, boundary)
  }
  return raw.map((e) => ({ ...e, boundary: boundaries.get(e.name) as number }))
}

/** The local header of `entry`, checked against its central directory record; returns where its bytes start. */
function checkLocalHeader(head: Buffer, entry: ZipEntry): number {
  if (head.length < 30 || head.readUInt32LE(0) !== LOCAL_SIG) throw new ZipFormatError('a bad local header')
  const flags = head.readUInt16LE(6)
  const method = head.readUInt16LE(8)
  const nameLen = head.readUInt16LE(26)
  const extraLen = head.readUInt16LE(28)
  if (method !== entry.method) throw new ZipFormatError('a local header disagrees with the directory')
  if ((flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0)
    throw new ZipFormatError('an encrypted entry')
  if ((flags & FLAG_DESCRIPTOR) !== (entry.flags & FLAG_DESCRIPTOR))
    throw new ZipFormatError('a local header disagrees with the directory')
  if (!(flags & FLAG_DESCRIPTOR)) {
    if (
      head.readUInt32LE(14) !== entry.crc32 ||
      head.readUInt32LE(18) !== entry.compressedSize ||
      head.readUInt32LE(22) !== entry.size
    )
      throw new ZipFormatError('a local header disagrees with the directory')
  }
  if (nameLen !== Buffer.byteLength(entry.name, 'utf8') || head.length < 30 + nameLen)
    throw new ZipFormatError('a local header disagrees with the directory')
  if (head.subarray(30, 30 + nameLen).toString('utf8') !== entry.name)
    throw new ZipFormatError('a local header disagrees with the directory')
  const start = entry.localHeaderOffset + 30 + nameLen + extraLen
  if (start + entry.compressedSize > entry.boundary) throw new ZipFormatError('entries overlap')
  return start
}

/** The local header and the name it should carry, in one read (the directory check made room for both). */
const localHeader = (src: RangeSource, entry: ZipEntry) =>
  src.read(entry.localHeaderOffset, 30 + Buffer.byteLength(entry.name, 'utf8'))

/** One entry's bytes (inflated when deflated), checked: its size and CRC-32 are the declared ones. */
export async function readZipEntry(src: RangeSource, entry: ZipEntry): Promise<Buffer> {
  const start = checkLocalHeader(await localHeader(src, entry), entry)
  const data = await src.read(start, entry.compressedSize)
  let out: Buffer
  if (entry.method === 0) out = data
  else if (entry.size === 0) {
    out = Buffer.alloc(0)
    try {
      if (inflateRawSync(data, { maxOutputLength: 1 }).length !== 0) throw new Error('not empty')
    } catch {
      throw new ZipFormatError('an entry inflates past its declared size', 'limit')
    }
  } else {
    try {
      out = inflateRawSync(data, { maxOutputLength: entry.size })
    } catch (e) {
      if ((e as { code?: unknown })?.code === 'ERR_BUFFER_TOO_LARGE')
        throw new ZipFormatError('an entry inflates past its declared size', 'limit')
      throw new ZipFormatError('an entry does not inflate')
    }
  }
  if (out.length !== entry.size) throw new ZipFormatError('an entry is not its declared size')
  if (crc32(out) !== entry.crc32) throw new ZipFormatError('an entry fails its CRC check')
  return out
}

/**
 * A STORED entry's bytes as chunks, read in one range from its local header to its boundary. Checked as they pass:
 * the generator throws (ZipFormatError) after the last chunk when the size or CRC-32 is not the declared one, so a
 * consumer must treat everything it got as unconfirmed until the generator finished.
 */
export async function* streamZipEntry(
  src: RangeSource,
  entry: ZipEntry,
): AsyncGenerator<Buffer, void, undefined> {
  if (entry.method !== 0) throw new ZipFormatError('only stored entries are streamed')
  const start = checkLocalHeader(await localHeader(src, entry), entry)
  let crc = 0
  let seen = 0
  for await (const chunk of src.stream(start, entry.compressedSize)) {
    const take = chunk.subarray(0, Math.max(0, entry.compressedSize - seen))
    if (!take.length) break
    seen += take.length
    crc = crc32(take, crc)
    yield take
    if (seen >= entry.compressedSize) break
  }
  if (seen !== entry.size) throw new ZipFormatError('an entry is shorter than its declared size')
  if (crc !== entry.crc32) throw new ZipFormatError('an entry fails its CRC check')
}
