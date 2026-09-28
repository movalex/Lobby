import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { type BlobStore, createFsBlobStore } from '@draftroom/blob-store'
import { afterEach, describe, expect, it } from 'vitest'
import { derivativeKey, originalKey } from '../../src/files/blobs.ts'
import { contentDisposition } from '../../src/files/disposition.ts'
import { initialServedMime, normalizeDeclaredMime } from '../../src/files/mime.ts'
import { parseRange } from '../../src/files/range.ts'
import { ReceiveError, receiveToBlob } from '../../src/files/receive.ts'
import { faultyStore, listFiles } from './helpers.ts'

const dirs: string[] = []
const store = (): { blobs: BlobStore; root: string } => {
  const d = mkdtempSync(join(tmpdir(), 'dr-api-receive-'))
  dirs.push(d)
  return { blobs: createFsBlobStore(d), root: d }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// A source that does what Node's HTTP parser never lets a client do: exceed its Content-Length.
const source = (...chunks: number[]) => Readable.from(chunks.map((n) => Buffer.alloc(n, 0x61)))
const KEY = 'assets/ast_aaaaaaaaaaaaaaaaaaaa/ver_bbbbbbbbbbbbbbbbbbbb/original'
const opts = (declaredBytes: number, maxBytes: number) => ({
  declaredBytes,
  maxBytes,
  contentType: 'application/octet-stream',
})

describe('receiveToBlob (streaming size guard)', () => {
  it('stores and hashes a body of exactly the declared size', async () => {
    const { blobs } = store()
    const r = await receiveToBlob(source(3, 4), blobs, KEY, opts(7, 10))
    expect(r.bytes).toBe(7)
    expect(r.sha256).toBe(createHash('sha256').update(Buffer.alloc(7, 0x61)).digest('hex'))
    expect((await blobs.head(KEY))?.contentLength).toBe(7)
  })

  it('aborts with TOO_LARGE as soon as the body passes its declared size; nothing is stored', async () => {
    const { blobs, root } = store()
    const src = source(5, 5, 5)
    const err = await receiveToBlob(src, blobs, KEY, opts(8, 100)).catch((e) => e)
    expect(err).toBeInstanceOf(ReceiveError)
    expect(err.reason).toBe('TOO_LARGE')
    expect(src.destroyed).toBe(true) // stopped reading the request
    expect(listFiles(root)).toEqual([]) // the store never published a partial object
  })

  it('aborts with TOO_LARGE when the body passes the kind limit even if the declared size lies', async () => {
    const { blobs } = store()
    const err = await receiveToBlob(source(6, 6), blobs, KEY, opts(1_000, 10)).catch((e) => e)
    expect(err.reason).toBe('TOO_LARGE')
  })

  it('rejects a body that ends before its declared size (INCOMPLETE, not a storage error)', async () => {
    const { blobs, root } = store()
    const err = await receiveToBlob(source(4), blobs, KEY, opts(5, 10)).catch((e) => e)
    expect(err).toBeInstanceOf(ReceiveError)
    expect(err.reason).toBe('INCOMPLETE')
    expect(listFiles(root)).toEqual([])
  })

  it('a body that errors (client gone) is ABORTED; a store that fails is its own error', async () => {
    const { blobs } = store()
    const broken = new Readable({
      read() {
        this.push(Buffer.alloc(10))
        this.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))
      },
    })
    const aborted = await receiveToBlob(broken, blobs, KEY, opts(100, 100)).catch((e) => e)
    expect(aborted).toBeInstanceOf(ReceiveError)
    expect(aborted.reason).toBe('ABORTED')

    const failure = new Error('disk full')
    const failing = faultyStore(blobs, { put: () => failure })
    const src = source(10, 10)
    const stored = await receiveToBlob(src, failing, KEY, opts(20, 20)).catch((e) => e)
    expect(stored).toBe(failure)
    expect(src.destroyed).toBe(true) // and the request is no longer read
  })

  it('does not wait forever when the store stops reading without failing', async () => {
    const { blobs } = store()
    const lazy: BlobStore = { ...blobs, put: async () => {} } // returns without consuming the body
    const err = await receiveToBlob(source(10), lazy, KEY, opts(10, 10)).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
  })
})

describe('blob keys', () => {
  it('are derived from validated ids only', () => {
    expect(originalKey('ast_aaaaaaaaaaaaaaaaaaaa', 'ver_bbbbbbbbbbbbbbbbbbbb')).toBe(KEY)
    expect(
      derivativeKey(
        'ast_aaaaaaaaaaaaaaaaaaaa',
        'ver_bbbbbbbbbbbbbbbbbbbb',
        'drv_cccccccccccccccccccc',
        'webp',
      ),
    ).toBe('assets/ast_aaaaaaaaaaaaaaaaaaaa/ver_bbbbbbbbbbbbbbbbbbbb/d/drv_cccccccccccccccccccc.webp')
    for (const [a, v] of [
      ['ast_../../x', 'ver_bbbbbbbbbbbbbbbbbbbb'],
      ['ast_aaaaaaaaaaaaaaaaaaaa', 'ver_b/c'],
      ['../ast', 'ver_bbbbbbbbbbbbbbbbbbbb'],
    ])
      expect(() => originalKey(a as string, v as string)).toThrow()
    expect(() =>
      derivativeKey('ast_aaaaaaaaaaaaaaaaaaaa', 'ver_bbbbbbbbbbbbbbbbbbbb', 'drv_x/../y', 'webp'),
    ).toThrow()
    expect(() =>
      derivativeKey(
        'ast_aaaaaaaaaaaaaaaaaaaa',
        'ver_bbbbbbbbbbbbbbbbbbbb',
        'drv_cccccccccccccccccccc',
        'svg' as 'png',
      ),
    ).toThrow()
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

describe('declared and served types', () => {
  it('reduces the declared Content-Type to a well-formed type/subtype or octet-stream', () => {
    expect(normalizeDeclaredMime('Image/PNG; charset=binary')).toBe('image/png')
    expect(normalizeDeclaredMime('text/html; <script>')).toBe('text/html')
    for (const bad of [undefined, '', 'garbage', 'image /png', 'a/b/c', '<x>/y']) {
      expect(normalizeDeclaredMime(bad), String(bad)).toBe('application/octet-stream')
    }
  })
  it('serves only allowlisted types for the kind until the worker confirms them', () => {
    expect(initialServedMime('image', 'image/png', 'a.png')).toBe('image/png')
    expect(initialServedMime('pdf', 'application/octet-stream', 'deck.PDF')).toBe('application/pdf')
    expect(initialServedMime('image', 'image/svg+xml', 'a.png')).toBe('image/png')
    expect(initialServedMime('other', 'text/html', 'a.html')).toBe('application/octet-stream')
    expect(initialServedMime('video', 'text/html', 'clip.exe')).toBe('application/octet-stream')
  })
})
