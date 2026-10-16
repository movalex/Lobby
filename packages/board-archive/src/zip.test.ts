// The ZIP writer and reader (wave R, WS4): a round trip (and Info-ZIP's own `unzip -t` where it is installed), and
// the hostile archives the reader refuses: CRC and size lies, traversal and odd names, duplicates, ZIP64, encryption,
// unknown methods, an understated size (a bomb), a ratio bomb, an EOCD comment trick, truncation, a prefix,
// overlapping entries and too many entries.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  bufferSource,
  fileSource,
  type RangeSource,
  readZipDirectory,
  readZipEntry,
  streamZipEntry,
  type ZipEntry,
  ZipFormatError,
  type ZipReadLimits,
} from './zip-read.ts'
import { ZipWriteError, zipStream, zipToBuffer } from './zip-write.ts'

const LIMITS: ZipReadLimits = {
  maxEntries: 100,
  maxCentralDirectoryBytes: 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntryBytes: () => 32 * 1024 * 1024,
  acceptName: () => true,
  maxRatio: 250,
  ratioFloorBytes: 1024 * 1024,
}

const tmp = mkdtempSync(join(tmpdir(), 'board-archive-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const hasUnzip = spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0

async function* chunks(buf: Buffer, size = 7_000): AsyncGenerator<Uint8Array> {
  for (let p = 0; p < buf.length; p += size) yield buf.subarray(p, p + size)
}

const random = (n: number) => {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 2654435761) >>> 24
  return b
}

const sample = () =>
  zipToBuffer(
    [
      { name: 'manifest.json', data: Buffer.from('{"hello":"world"}'), method: 8 },
      { name: 'board.json', data: Buffer.from('x'.repeat(5_000)), method: 8 },
      { name: 'files/one', stream: chunks(random(100_000)), size: 100_000 },
      { name: 'empty', data: Buffer.alloc(0), method: 0 },
    ],
    { at: new Date('2026-10-16T12:00:00Z') },
  )

/** every occurrence of `from` replaced by `to` (same length) */
const swap = (buf: Buffer, from: string, to: string) => {
  expect(from.length).toBe(to.length)
  const out = Buffer.from(buf)
  const needle = Buffer.from(from, 'latin1')
  let at = out.indexOf(needle)
  expect(at).toBeGreaterThanOrEqual(0)
  while (at >= 0) {
    Buffer.from(to, 'latin1').copy(out, at)
    at = out.indexOf(needle, at + 1)
  }
  return out
}

const cdAt = (buf: Buffer) => buf.readUInt32LE(buf.length - 22 + 16)
/** offsets of each central directory record */
const cdRecords = (buf: Buffer) => {
  const out: number[] = []
  let p = cdAt(buf)
  const end = buf.length - 22
  while (p < end) {
    out.push(p)
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return out
}

const refused = async (buf: Buffer, kind: 'invalid' | 'limit' = 'invalid', limits = LIMITS) => {
  const err = await readZipDirectory(bufferSource(buf), limits).then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ZipFormatError)
  expect((err as ZipFormatError).kind).toBe(kind)
  return (err as ZipFormatError).message
}

const readAll = async (buf: Buffer, entries: ZipEntry[]) => {
  const src = bufferSource(buf)
  const out = new Map<string, Buffer>()
  for (const e of entries) {
    if (e.method === 0) {
      const parts: Buffer[] = []
      for await (const c of streamZipEntry(src, e)) parts.push(c)
      out.set(e.name, Buffer.concat(parts))
    } else out.set(e.name, await readZipEntry(src, e))
  }
  return out
}

describe('the ZIP writer and reader', () => {
  it('round trip: stored, deflated and streamed entries come back byte for byte', async () => {
    const zip = await sample()
    const entries = await readZipDirectory(bufferSource(zip), LIMITS)
    expect(entries.map((e) => [e.name, e.method, e.size])).toEqual([
      ['manifest.json', 8, 17],
      ['board.json', 8, 5_000],
      ['files/one', 0, 100_000],
      ['empty', 0, 0],
    ])
    const all = await readAll(zip, entries)
    expect(all.get('manifest.json')?.toString()).toBe('{"hello":"world"}')
    expect(all.get('board.json')?.toString()).toBe('x'.repeat(5_000))
    expect(all.get('files/one')?.equals(random(100_000))).toBe(true)
    expect(all.get('empty')?.length).toBe(0)
    // the same through a file on disk
    const path = join(tmp, 'sample.zip')
    writeFileSync(path, zip)
    const fsrc = await fileSource(path)
    try {
      const again = await readZipDirectory(fsrc, LIMITS)
      expect(again).toEqual(entries)
      const parts: Buffer[] = []
      for await (const c of streamZipEntry(fsrc, again[2] as ZipEntry)) parts.push(c)
      expect(Buffer.concat(parts).equals(random(100_000))).toBe(true)
    } finally {
      await fsrc.close()
    }
  })

  it.runIf(hasUnzip)('Info-ZIP’s unzip -t finds no error in what the writer makes', async () => {
    const path = join(tmp, 'unzip.zip')
    writeFileSync(path, await sample())
    const r = spawnSync('unzip', ['-t', path], { encoding: 'utf8' })
    expect(r.stdout).toContain('No errors detected')
    expect(r.status).toBe(0)
  })

  it('the writer refuses a streamed file that is shorter or longer than it said, and a duplicate name', async () => {
    const short = zipToBuffer([{ name: 'a', stream: chunks(random(10)), size: 11 }])
    await expect(short).rejects.toBeInstanceOf(ZipWriteError)
    const long = zipToBuffer([{ name: 'a', stream: chunks(random(12)), size: 11 }])
    await expect(long).rejects.toBeInstanceOf(ZipWriteError)
    const twice = zipToBuffer([
      { name: 'a', data: Buffer.from('1'), method: 0 },
      { name: 'a', data: Buffer.from('2'), method: 0 },
    ])
    await expect(twice).rejects.toBeInstanceOf(ZipWriteError)
    await expect(zipToBuffer([{ name: 'a\0b', data: Buffer.alloc(1), method: 0 }])).rejects.toBeInstanceOf(
      ZipWriteError,
    )
  })

  it('the writer streams: nothing past the first chunk is read before the first bytes go out', async () => {
    let pulled = 0
    async function* slow() {
      for (let i = 0; i < 4; i++) {
        pulled++
        yield Buffer.alloc(10, i)
      }
    }
    const it = zipStream([{ name: 'f', stream: slow(), size: 40 }])
    const first = await it.next()
    expect(first.done).toBe(false)
    expect(pulled).toBe(0) // the local header goes before any byte of the file is asked for
    for await (const _ of it) {
      // drain
    }
    expect(pulled).toBe(4)
  })

  it('a CRC that does not match refuses the entry (read and streamed)', async () => {
    const zip = await sample()
    const entries = await readZipDirectory(bufferSource(zip), LIMITS)
    const file = entries[2] as ZipEntry
    const bad = Buffer.from(zip)
    const at = file.localHeaderOffset + 30 + file.name.length + 500
    bad[at] = (bad[at] as number) ^ 0xff
    const stream = async () => {
      for await (const _ of streamZipEntry(bufferSource(bad), file)) {
        // drain
      }
    }
    await expect(stream()).rejects.toThrow('CRC')
    // the directory's CRC changed: it no longer matches the local header's
    const bad2 = Buffer.from(zip)
    const rec = (cdRecords(zip)[1] as number) + 16
    bad2.writeUInt32LE((bad2.readUInt32LE(rec) ^ 1) >>> 0, rec)
    const board = (await readZipDirectory(bufferSource(bad2), LIMITS))[1] as ZipEntry
    await expect(readZipEntry(bufferSource(bad2), board)).rejects.toThrow('disagrees')
  })

  it('names: traversal, absolute, backslash, drive letters, dot segments and control characters are refused', async () => {
    const zip = await zipToBuffer([
      { name: 'aaaaaaaa', data: Buffer.from('1'), method: 0 },
      { name: 'zzzz', data: Buffer.from('2'), method: 0 },
    ])
    const evils = [
      '../x/../',
      '/abs/olu',
      'files\\..',
      'C:/windo',
      'a/./bbbb',
      'a//bbbbb',
      'a\u0000bbbbbb',
      'a\u0007bbbbbb',
    ]
    for (const evil of evils) expect(await refused(swap(zip, 'aaaaaaaa', evil))).toContain('name')
    // and an archive's own rule (acceptName)
    expect(await refused(zip, 'invalid', { ...LIMITS, acceptName: (n) => n === 'zzzz' })).toContain('name')
  })

  it('a name used twice is refused', async () => {
    const zip = await zipToBuffer([
      { name: 'one1', data: Buffer.from('1'), method: 0 },
      { name: 'one2', data: Buffer.from('2'), method: 0 },
    ])
    expect(await refused(swap(zip, 'one2', 'one1'))).toContain('duplicate')
  })

  it('a non-UTF-8 or non-ASCII name without the UTF-8 flag is refused', async () => {
    const zip = await zipToBuffer([{ name: 'name', data: Buffer.from('1'), method: 0 }])
    expect(await refused(swap(zip, 'name', 'n\u00e9me'))).toContain('ASCII')
  })

  it('ZIP64 (the entry count marker, a size marker, the locator) is refused', async () => {
    const zip = await sample()
    const count = Buffer.from(zip)
    count.writeUInt16LE(0xffff, zip.length - 22 + 8)
    count.writeUInt16LE(0xffff, zip.length - 22 + 10)
    expect(await refused(count)).toContain('ZIP64')
    const size = Buffer.from(zip)
    size.writeUInt32LE(0xffffffff, (cdRecords(zip)[0] as number) + 24)
    expect(await refused(size)).toContain('ZIP64')
    const locator = Buffer.from(zip)
    locator.writeUInt32LE(0x07064b50, zip.length - 22 - 20)
    expect(await refused(locator)).toContain('ZIP64')
  })

  it('an encrypted entry and an unknown method are refused', async () => {
    const zip = await sample()
    const enc = Buffer.from(zip)
    const rec = cdRecords(zip)[0] as number
    enc.writeUInt16LE(enc.readUInt16LE(rec + 8) | 1, rec + 8)
    expect(await refused(enc)).toContain('encrypted')
    const strong = Buffer.from(zip)
    strong.writeUInt16LE(strong.readUInt16LE(rec + 8) | 0x40, rec + 8)
    expect(await refused(strong)).toContain('encrypted')
    const method = Buffer.from(zip)
    method.writeUInt16LE(12, rec + 10)
    expect(await refused(method)).toContain('method 12')
  })

  it('a stored entry with two sizes, and an entry over its cap or the total, are refused', async () => {
    const zip = await sample()
    const two = Buffer.from(zip)
    two.writeUInt32LE(99_999, (cdRecords(zip)[2] as number) + 20)
    expect(await refused(two)).toContain('two sizes')
    expect(await refused(zip, 'limit', { ...LIMITS, maxEntryBytes: () => 50_000 })).toContain('too large')
    expect(await refused(zip, 'limit', { ...LIMITS, maxTotalBytes: 100_000 })).toContain('together')
  })

  it('a deflated entry is read in chunks (never its compressed bytes in one read) and still checked', async () => {
    const big = randomBytes(3 * 1024 * 1024)
    const zip = await zipToBuffer([{ name: 'board.json', data: big, method: 8 }])
    const inner = bufferSource(zip)
    const sizes: number[] = []
    const src: RangeSource = {
      size: inner.size,
      read: (start, length) => {
        sizes.push(length)
        return inner.read(start, length)
      },
      async *stream(start, length) {
        for await (const c of inner.stream(start, length)) {
          sizes.push(c.length)
          yield c
        }
      },
    }
    const [entry] = await readZipDirectory(src, LIMITS)
    expect(entry?.compressedSize).toBeGreaterThan(2 * 1024 * 1024)
    expect((await readZipEntry(src, entry as ZipEntry)).equals(big)).toBe(true)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1024 * 1024)
    // a deflated entry whose compressed size is past what its cap could deflate to: refused from the directory
    const lie = Buffer.from(zip)
    const rec = cdRecords(lie)[0] as number
    lie.writeUInt32LE(2_000_000_000, rec + 20)
    expect(await refused(lie, 'invalid', { ...LIMITS, maxEntryBytes: () => 1024 * 1024 * 1024 })).toMatch(
      /compressed size/,
    )
  })

  it('a bomb that understates its size is stopped at the declared size', async () => {
    const real = Buffer.alloc(4 * 1024 * 1024)
    const zip = await zipToBuffer([{ name: 'bomb', data: real, method: 8 }])
    // say it holds 100 bytes, in the directory and the local header (and a CRC to match the lie)
    const lie = Buffer.from(zip)
    const rec = cdRecords(zip)[0] as number
    lie.writeUInt32LE(100, rec + 24)
    lie.writeUInt32LE(100, 22)
    const entries = await readZipDirectory(bufferSource(lie), LIMITS)
    const err = await readZipEntry(bufferSource(lie), entries[0] as ZipEntry).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ZipFormatError)
    expect((err as ZipFormatError).kind).toBe('limit')
    // and an entry that compresses better than any real board (4 MiB of zeros in a few KiB) is refused unread
    expect(await refused(zip, 'limit')).toContain('compresses')
  })

  it('a comment (with a fake end record in it) and bytes after the end are refused', async () => {
    const zip = await sample()
    const fake = Buffer.from(zip.subarray(zip.length - 22))
    const comment = Buffer.concat([Buffer.from('padding'), fake])
    const withComment = Buffer.concat([zip.subarray(0, zip.length - 2), Buffer.alloc(2), comment])
    withComment.writeUInt16LE(comment.length, zip.length - 2)
    // the last 22 bytes are a well-formed end record, but it is not where its central directory says
    expect(await refused(withComment)).toBeTruthy()
    const tail = Buffer.concat([zip.subarray(0, zip.length - 2), Buffer.from([3, 0]), Buffer.from('abc')])
    expect(await refused(tail)).toBeTruthy()
    expect(await refused(Buffer.concat([zip, Buffer.from('trailing')]))).toBeTruthy()
  })

  it('a truncated file, a prefix and an empty file are refused', async () => {
    const zip = await sample()
    expect(await refused(zip.subarray(0, zip.length - 100))).toBeTruthy()
    expect(await refused(zip.subarray(0, 10))).toContain('too small')
    expect(await refused(Buffer.concat([Buffer.from('MZ-prefix!'), zip]))).toBeTruthy()
    // a prefix with every offset fixed up (a valid ZIP to most readers): still bytes before the first entry
    const shifted = Buffer.concat([Buffer.alloc(10), zip])
    shifted.writeUInt32LE(cdAt(zip) + 10, shifted.length - 22 + 16)
    for (const rec of cdRecords(zip)) shifted.writeUInt32LE(zip.readUInt32LE(rec + 42) + 10, rec + 10 + 42)
    expect(await refused(shifted)).toContain('before the first entry')
  })

  it('overlapping entries are refused', async () => {
    const zip = await sample()
    const over = Buffer.from(zip)
    const recs = cdRecords(zip)
    // the third entry says it starts where the second does
    over.writeUInt32LE(zip.readUInt32LE((recs[1] as number) + 42), (recs[2] as number) + 42)
    expect(await refused(over)).toBeTruthy()
  })

  it('too many entries (and 65,535, the ZIP64 marker) are refused before the directory is read', async () => {
    const zip = await sample()
    expect(await refused(zip, 'limit', { ...LIMITS, maxEntries: 3 })).toContain('too many')
    const many = Buffer.from(zip)
    many.writeUInt16LE(65_535, zip.length - 22 + 8)
    many.writeUInt16LE(65_535, zip.length - 22 + 10)
    expect(await refused(many)).toContain('ZIP64')
    const big = Buffer.from(zip)
    big.writeUInt16LE(60_000, zip.length - 22 + 8)
    big.writeUInt16LE(60_000, zip.length - 22 + 10)
    expect(await refused(big, 'limit')).toContain('too many')
  })

  it('a central directory over its cap is refused', async () => {
    const zip = await sample()
    expect(await refused(zip, 'limit', { ...LIMITS, maxCentralDirectoryBytes: 64 })).toContain('central')
  })

  it('a local header that disagrees with the directory is refused when the entry is read', async () => {
    const zip = await sample()
    const entries = await readZipDirectory(bufferSource(zip), LIMITS)
    const manifest = entries[0] as ZipEntry
    const bad = Buffer.from(zip)
    bad.writeUInt16LE(0, 8) // the first local header says STORED, the directory says deflated
    await expect(readZipEntry(bufferSource(bad), manifest)).rejects.toThrow('disagrees')
    const name = Buffer.from(zip)
    name.write('M', 30, 'latin1')
    await expect(readZipEntry(bufferSource(name), manifest)).rejects.toThrow('disagrees')
    // a deflate stream that is not one
    const junk = Buffer.from(zip)
    const start = 30 + manifest.name.length
    junk.fill(0xff, start, start + manifest.compressedSize)
    await expect(readZipEntry(bufferSource(junk), manifest)).rejects.toBeInstanceOf(ZipFormatError)
  })
})
