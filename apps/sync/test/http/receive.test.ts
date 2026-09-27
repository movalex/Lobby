import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { contentDisposition } from '../../src/http/disposition.ts'
import { parseRange } from '../../src/http/range.ts'
import { ReceiveError, receiveToFile } from '../../src/http/receive.ts'

const dirs: string[] = []
const tmpFile = () => {
  const d = mkdtempSync(join(tmpdir(), 'dr-receive-'))
  dirs.push(d)
  return join(d, 'upload.tmp')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// A source that does what Node's HTTP parser never lets a client do: exceed its Content-Length.
const source = (...chunks: number[]) => Readable.from(chunks.map((n) => Buffer.alloc(n, 0x61)))

describe('receiveToFile (streaming size guard)', () => {
  it('writes and hashes a body of exactly the declared size', async () => {
    const dest = tmpFile()
    const r = await receiveToFile(source(3, 4), dest, { declaredBytes: 7, maxBytes: 10 })
    expect(r.bytes).toBe(7)
    expect(r.sha256).toBe(createHash('sha256').update(Buffer.alloc(7, 0x61)).digest('hex'))
    expect(readFileSync(dest).length).toBe(7)
  })

  it('aborts with TOO_LARGE as soon as the body passes its declared size', async () => {
    const dest = tmpFile()
    const err = await receiveToFile(source(5, 5, 5), dest, { declaredBytes: 8, maxBytes: 100 }).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(ReceiveError)
    expect(err.reason).toBe('TOO_LARGE')
    // the chunk that crossed the cap is never written
    expect(existsSync(dest) ? readFileSync(dest).length : 0).toBeLessThanOrEqual(5)
  })

  it('aborts with TOO_LARGE when the body passes the kind limit even if the declared size lies', async () => {
    const err = await receiveToFile(source(6, 6), tmpFile(), { declaredBytes: 1_000, maxBytes: 10 }).catch(
      (e) => e,
    )
    expect(err.reason).toBe('TOO_LARGE')
  })

  it('rejects a body that ends before its declared size', async () => {
    const err = await receiveToFile(source(4), tmpFile(), { declaredBytes: 5, maxBytes: 10 }).catch((e) => e)
    expect(err.reason).toBe('INCOMPLETE')
  })

  it('never overwrites an existing file', async () => {
    const dest = tmpFile()
    await receiveToFile(source(1), dest, { declaredBytes: 1, maxBytes: 1 })
    await expect(receiveToFile(source(1), dest, { declaredBytes: 1, maxBytes: 1 })).rejects.toMatchObject({
      code: 'EEXIST',
    })
  })
})

describe('parseRange', () => {
  it('handles the three single-range forms and clamps to the resource', () => {
    expect(parseRange('bytes=0-0', 10)).toEqual({ start: 0, end: 0 })
    expect(parseRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 })
    expect(parseRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 })
    expect(parseRange('bytes=-40', 10)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=3-99', 10)).toEqual({ start: 3, end: 9 })
  })
  it('flags unsatisfiable ranges and ignores malformed ones', () => {
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
    expect(parseRange('bytes=99999999999999999999-', 10)).toBe('unsatisfiable')
    for (const h of [
      undefined,
      '',
      'bytes=',
      'bytes=-',
      'bytes=5-1',
      'bytes=1-2,3-4',
      'lines=1-2',
      'bytes=a-b',
    ]) {
      expect(parseRange(h, 10)).toBeNull()
    }
  })
})

describe('contentDisposition', () => {
  it('escapes user-controlled names in both the fallback and the RFC 5987 form', () => {
    expect(contentDisposition('attachment', 'a"b\\c;d.txt')).toBe(
      `attachment; filename="a_b_c;d.txt"; filename*=UTF-8''a%22b%5Cc%3Bd.txt`,
    )
    expect(contentDisposition('inline', '日本語.pdf')).toBe(
      `inline; filename="___.pdf"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.pdf`,
    )
    expect(contentDisposition('attachment', "it's (1)!*.txt")).toContain(
      "filename*=UTF-8''it%27s%20%281%29%21%2A.txt",
    )
    // a lone surrogate would make encodeURIComponent throw
    expect(contentDisposition('attachment', 'x\ud800.txt')).toContain("filename*=UTF-8''x%EF%BF%BD.txt")
    expect(contentDisposition('attachment', 'line\r\nbreak')).not.toMatch(/[\r\n]/)
  })
})
