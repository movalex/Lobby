// The BlobStore behavioral contract, run against every implementation (fs, R2 against the in-process
// fake, and live R2 when .env.deploy.local exists). Every key it writes lives under `env.prefix`,
// and its last test deletes them and asserts the prefix is empty.

import { PassThrough, type Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BlobStore, BlobStoreError, presignedPutHeaders } from '../src/index.ts'
import {
  everyBytes,
  hashStream,
  MiB,
  memoryProbe,
  must,
  patternBytes,
  patternRange,
  patternSha256,
  patternSource,
  readAll,
  rejectionOf,
  SourceFailure,
} from './helpers.ts'

export interface SuiteEnv {
  store: BlobStore
  /** Every key the suite writes starts with this (e.g. `test/<run-id>/`). */
  prefix: string
  /** Lists every stored key (and, for fs, every stray temp file) under a prefix. */
  listKeys(prefix: string): Promise<string[]>
  /** fetch for presigned URLs (the global fetch against live R2). */
  fetch: typeof fetch
  /** The same store with its presigning clock shifted by `offsetMs` (negative = in the past). */
  withClock?: (offsetMs: number) => BlobStore
  /** Bytes the backend has received so far (fake only): bounds bytes in flight during uploads. */
  receivedBytes?: () => number
  teardown?(): Promise<void>
}

export interface SuiteOptions {
  /** get/head report the stored content type (fs returns null). */
  persistsContentType: boolean
  /** presignGet/presignPut return URLs (fs returns null). */
  presigns: boolean
  /** Size of the streamed upload whose memory use is measured. */
  bigUploadBytes: number
  /** Timeout for the big upload test. */
  bigUploadTimeoutMs: number
}

/**
 * Retained memory (after a full GC) may grow by at most this during a big upload or download.
 * Measured peaks: fs ~0.3-0.7 MiB, R2 via the fake ~0.4-4 MiB; buffering 200 MiB retained ~211 MB.
 */
const MEMORY_BOUND = 16 * MiB
/** Bytes produced by the source but not yet received by the backend, at any time. */
const IN_FLIGHT_BOUND = 16 * MiB

const codeOf = (e: unknown) => (e instanceof BlobStoreError ? e.code : `not a BlobStoreError: ${String(e)}`)

export function blobStoreSuite(name: string, opts: SuiteOptions, setup: () => Promise<SuiteEnv>) {
  describe(`BlobStore contract: ${name}`, () => {
    let env: SuiteEnv
    let store: BlobStore
    const written = new Set<string>()
    const key = (n: string) => {
      const k = env.prefix + n
      written.add(k)
      return k
    }
    const type = (t: string) => (opts.persistsContentType ? t : null)

    beforeAll(async () => {
      env = await setup()
      store = env.store
    }, 60_000)

    afterAll(async () => {
      if (!env) return
      try {
        for (const k of written) await store.delete(k).catch(() => {})
      } finally {
        await env.teardown?.()
      }
    }, 120_000)

    it('put(bytes) then get returns exactly those bytes, length and type', async () => {
      const k = key('basic/one.bin')
      const bytes = patternBytes(100_000)
      await store.put(k, bytes, { contentType: 'application/x-draftroom-test', contentLength: bytes.length })
      const obj = await store.get(k)
      expect(obj).not.toBeNull()
      expect(obj?.contentLength).toBe(bytes.length)
      expect(obj?.contentType).toBe(type('application/x-draftroom-test'))
      expect(obj?.contentRange).toBeUndefined()
      expect((await readAll(must(obj).body)).equals(bytes)).toBe(true)
    })

    it('put(stream) then head reports size and type', async () => {
      const k = key('basic/two.webp')
      await store.put(k, patternSource(300_000), { contentType: 'image/webp', contentLength: 300_000 })
      expect(await store.head(k)).toEqual({ contentLength: 300_000, contentType: type('image/webp') })
      const obj = await store.get(k)
      expect((await hashStream(must(obj).body)).sha256).toBe(patternSha256(300_000))
    })

    it('missing objects: get and head return null, ranged get too; delete succeeds', async () => {
      const k = key('missing/never-written')
      expect(await store.get(k)).toBeNull()
      expect(await store.get(k, { range: { start: 0, end: 10 } })).toBeNull()
      expect(await store.head(k)).toBeNull()
      await store.delete(k)
      await store.delete(k)
    })

    it('delete removes the object and is idempotent', async () => {
      const k = key('delete/x.bin')
      await store.put(k, Buffer.from('bye'), { contentType: 'text/plain', contentLength: 3 })
      expect(await store.head(k)).not.toBeNull()
      await store.delete(k)
      expect(await store.head(k)).toBeNull()
      expect(await store.get(k)).toBeNull()
      await store.delete(k)
    })

    it('put replaces an existing object', async () => {
      const k = key('replace/x.bin')
      await store.put(k, Buffer.from('first version'), { contentType: 'text/plain', contentLength: 13 })
      await store.put(k, patternSource(70_000), { contentType: 'image/png', contentLength: 70_000 })
      expect(await store.head(k)).toEqual({ contentLength: 70_000, contentType: type('image/png') })
      const obj = await store.get(k)
      expect((await readAll(must(obj).body)).equals(patternBytes(70_000))).toBe(true)
    })

    it('range reads: first byte, middle, clamped end, whole object', async () => {
      const k = key('range/r.bin')
      const size = 200_003
      const bytes = patternBytes(size)
      await store.put(k, bytes, { contentType: 'video/mp4', contentLength: size })
      const cases: Array<[number, number, number]> = [
        [0, 0, 0],
        [1, 1, 1],
        [65_530, 131_080, 131_080],
        [size - 10, size + 5000, size - 1], // end past the object: clamped, as in HTTP
        [0, size - 1, size - 1],
        [size - 1, size - 1, size - 1],
      ]
      for (const [start, end, clampedEnd] of cases) {
        const obj = await store.get(k, { range: { start, end } })
        expect(obj).not.toBeNull()
        expect(obj?.contentLength).toBe(clampedEnd - start + 1)
        expect(obj?.contentRange).toBe(`bytes ${start}-${clampedEnd}/${size}`)
        expect(obj?.contentType).toBe(type('video/mp4'))
        const got = await readAll(must(obj).body)
        expect(got.equals(bytes.subarray(start, clampedEnd + 1))).toBe(true)
      }
    })

    it('a range starting at or past the end is RANGE_NOT_SATISFIABLE; a malformed range is refused', async () => {
      const k = key('range/small.bin')
      await store.put(k, Buffer.from('0123456789'), { contentType: 'text/plain', contentLength: 10 })
      for (const range of [
        { start: 10, end: 10 },
        { start: 11, end: 20 },
      ]) {
        const e = await rejectionOf(store.get(k, { range }))
        expect(codeOf(e)).toBe('RANGE_NOT_SATISFIABLE')
        const size = (e as BlobStoreError).size
        if (size !== undefined) expect(size).toBe(10) // known to fs; R2's 416 does not say
      }
      for (const range of [
        { start: 5, end: 4 },
        { start: -1, end: 3 },
        { start: 0.5, end: 3 },
        { start: 0, end: Number.NaN },
      ]) {
        expect(codeOf(await rejectionOf(store.get(k, { range })))).toBe('INVALID_ARGUMENT')
      }
    })

    it('zero-byte objects (bytes and stream); any range on them is unsatisfiable', async () => {
      const a = key('empty/a')
      const b = key('empty/b')
      await store.put(a, new Uint8Array(0), { contentType: 'application/octet-stream', contentLength: 0 })
      await store.put(b, patternSource(0), { contentType: 'application/octet-stream', contentLength: 0 })
      for (const k of [a, b]) {
        expect((await store.head(k))?.contentLength).toBe(0)
        const obj = await store.get(k)
        expect(obj?.contentLength).toBe(0)
        expect((await readAll(must(obj).body)).length).toBe(0)
        expect(codeOf(await rejectionOf(store.get(k, { range: { start: 0, end: 0 } })))).toBe(
          'RANGE_NOT_SATISFIABLE',
        )
      }
    })

    it('a stream shorter than contentLength is refused and stores nothing', async () => {
      const k = key('length/short.bin')
      const e = await rejectionOf(
        store.put(k, patternSource(200_000), { contentType: 'image/webp', contentLength: 200_001 }),
      )
      expect(codeOf(e)).toBe('LENGTH_MISMATCH')
      expect(await store.head(k)).toBeNull()
    })

    it('a stream longer than contentLength is refused and stores nothing', async () => {
      const k = key('length/long.bin')
      const src = patternSource(5 * MiB)
      const e = await rejectionOf(store.put(k, src, { contentType: 'image/webp', contentLength: 100_000 }))
      expect(codeOf(e)).toBe('LENGTH_MISMATCH')
      expect(src.produced()).toBeLessThan(5 * MiB) // stopped reading early
      expect(src.destroyed).toBe(true)
      expect(await store.head(k)).toBeNull()
    })

    it('a byte array whose length differs from contentLength is refused', async () => {
      const k = key('length/bytes.bin')
      const e = await rejectionOf(
        store.put(k, Buffer.from('abc'), { contentType: 'text/plain', contentLength: 4 }),
      )
      expect(codeOf(e)).toBe('LENGTH_MISMATCH')
      expect(await store.head(k)).toBeNull()
    })

    it('a failing source rejects put with its own error, stores nothing and keeps the old object', async () => {
      const k = key('failing/x.bin')
      await store.put(k, Buffer.from('old'), { contentType: 'text/plain', contentLength: 3 })
      const size = 3 * MiB
      const e = await rejectionOf(
        store.put(k, patternSource(size, { failAfter: MiB }), {
          contentType: 'text/plain',
          contentLength: size,
        }),
      )
      expect(e).toBeInstanceOf(SourceFailure)
      expect((await readAll(must(await store.get(k)).body)).toString()).toBe('old')
      const fresh = key('failing/fresh.bin')
      const e2 = await rejectionOf(
        store.put(fresh, patternSource(size, { failAfter: MiB }), {
          contentType: 'text/plain',
          contentLength: size,
        }),
      )
      expect(e2).toBeInstanceOf(SourceFailure)
      expect(await store.head(fresh)).toBeNull()
    })

    it('refuses traversal and malformed keys in every method, before any I/O', async () => {
      const bad = [
        '',
        '/abs',
        '../x',
        'a/../b',
        'a/..',
        '..',
        '.',
        'a/./b',
        'a//b',
        'a/',
        'a\\b',
        '..\\x',
        'C:/x',
        'c:x',
        'a/.hidden',
        'a/b.',
        'with space',
        'semi;colon',
        'q?x=1',
        'hash#x',
        '%2e%2e/x',
        'ümlaut',
        'nul',
        'a/CON.txt',
        'x'.repeat(513),
        `a/${'y'.repeat(256)}`,
        `${env.prefix}~temp.tmp`,
      ]
      const opts = { contentType: 'text/plain', contentLength: 1 }
      for (const k of bad) {
        const src = new PassThrough()
        expect(codeOf(await rejectionOf(store.put(k, Buffer.from('x'), opts))), k).toBe('INVALID_KEY')
        expect(codeOf(await rejectionOf(store.put(k, src, opts))), k).toBe('INVALID_KEY')
        expect(src.destroyed).toBe(false) // argument errors leave the caller's stream alone
        expect(codeOf(await rejectionOf(store.get(k))), k).toBe('INVALID_KEY')
        expect(codeOf(await rejectionOf(store.head(k))), k).toBe('INVALID_KEY')
        expect(codeOf(await rejectionOf(store.delete(k))), k).toBe('INVALID_KEY')
        expect(codeOf(await rejectionOf(store.presignGet(k, { expiresSec: 60 }))), k).toBe('INVALID_KEY')
        expect(
          codeOf(await rejectionOf(store.presignPut(k, { expiresSec: 60, contentType: 'text/plain' }))),
          k,
        ).toBe('INVALID_KEY')
      }
      // Messages never echo the (possibly hostile) key.
      const e = (await rejectionOf(store.get('../../etc/passwd'))) as Error
      expect(e.message.includes('passwd')).toBe(false)
    })

    it('refuses invalid content types, lengths and expiries', async () => {
      const k = key('args/x.bin')
      const put = (contentType: unknown, contentLength: unknown) =>
        rejectionOf(store.put(k, Buffer.from('x'), { contentType, contentLength } as never))
      expect(codeOf(await put('', 1))).toBe('INVALID_ARGUMENT')
      expect(codeOf(await put('text/plain\r\nx-evil: 1', 1))).toBe('INVALID_ARGUMENT')
      expect(codeOf(await put('text/plain', -1))).toBe('INVALID_ARGUMENT')
      expect(codeOf(await put('text/plain', 1.5))).toBe('INVALID_ARGUMENT')
      expect(codeOf(await put('text/plain', '1'))).toBe('INVALID_ARGUMENT')
      expect(codeOf(await put('text/plain', 6_000_000_000))).toBe('INVALID_ARGUMENT')
      for (const expiresSec of [0, 901, 3600, 1.5, -5]) {
        expect(codeOf(await rejectionOf(store.presignGet(k, { expiresSec })))).toBe('INVALID_ARGUMENT')
        expect(
          codeOf(await rejectionOf(store.presignPut(k, { expiresSec, contentType: 'text/plain' }))),
        ).toBe('INVALID_ARGUMENT')
      }
      expect(await store.head(k)).toBeNull()
    })

    it('a download destroyed early releases the object', async () => {
      const k = key('early/x.bin')
      await store.put(k, patternSource(2 * MiB), { contentType: 'video/mp4', contentLength: 2 * MiB })
      const obj = await store.get(k)
      const body = must(obj).body as Readable
      await new Promise<void>((resolve, reject) => {
        body.once('data', () => resolve())
        body.once('error', reject)
      })
      body.destroy()
      // The object can be read again, replaced and deleted afterwards.
      expect((await store.head(k))?.contentLength).toBe(2 * MiB)
      await store.put(k, Buffer.from('new'), { contentType: 'text/plain', contentLength: 3 })
      expect((await readAll(must(await store.get(k)).body)).toString()).toBe('new')
      await store.delete(k)
      expect(await store.head(k)).toBeNull()
    })

    it('concurrent puts to one key leave exactly one of them, whole', async () => {
      const k = key('race/x.bin')
      const a = Buffer.alloc(300_000, 0x61)
      const b = Buffer.alloc(200_000, 0x62)
      await Promise.all([
        store.put(k, a, { contentType: 'text/plain', contentLength: a.length }),
        store.put(k, b, { contentType: 'text/plain', contentLength: b.length }),
      ])
      const got = await readAll(must(await store.get(k)).body)
      expect(got.equals(a) || got.equals(b)).toBe(true)
    })

    it(
      `streams a ${opts.bigUploadBytes / MiB} MiB upload and download with bounded memory`,
      async () => {
        const k = key('big/upload.bin')
        const size = opts.bigUploadBytes
        const up = memoryProbe()
        let maxInFlight = 0
        const receivedAtStart = env.receivedBytes?.() ?? 0
        const src = patternSource(size, {
          onChunk: everyBytes(8 * MiB, () => {
            up.sample()
            if (env.receivedBytes) {
              maxInFlight = Math.max(maxInFlight, src.produced() - (env.receivedBytes() - receivedAtStart))
            }
          }),
        })
        await store.put(k, src, { contentType: 'video/mp4', contentLength: size })
        expect(up.samples).toBeGreaterThanOrEqual(Math.floor(size / (8 * MiB)))
        expect(up.peakAboveBaseline).toBeLessThan(MEMORY_BOUND)
        if (env.receivedBytes) expect(maxInFlight).toBeLessThan(IN_FLIGHT_BOUND)
        expect(await store.head(k)).toEqual({ contentLength: size, contentType: type('video/mp4') })

        const down = memoryProbe()
        const obj = await store.get(k)
        expect(obj?.contentLength).toBe(size)
        const { sha256, bytes } = await hashStream(
          must(obj).body,
          everyBytes(8 * MiB, () => down.sample()),
        )
        expect(bytes).toBe(size)
        expect(sha256).toBe(patternSha256(size))
        expect(down.peakAboveBaseline).toBeLessThan(MEMORY_BOUND)

        const tail = await store.get(k, { range: { start: size - 1000, end: size - 1 } })
        expect((await readAll(must(tail).body)).equals(patternRange(size, size - 1000, size))).toBe(true)
        await store.delete(k)
      },
      opts.bigUploadTimeoutMs,
    )

    if (opts.presigns) {
      it('presigned PUT then presigned GET round trip through plain fetch', async () => {
        const k = key('presign/drv.webp')
        const bytes = patternBytes(150_000)
        const putUrl = await store.presignPut(k, {
          expiresSec: 120,
          contentType: 'image/webp',
          contentLength: bytes.length,
        })
        expect(typeof putUrl).toBe('string')
        // The URL carries a signature, never the secret; don't print it (it holds the access key id).
        expect(must(putUrl).includes('X-Amz-Signature=')).toBe(true)
        expect(must(putUrl).includes('X-Amz-Expires=120')).toBe(true)
        const put = await env.fetch(must(putUrl), {
          method: 'PUT',
          body: bytes,
          headers: presignedPutHeaders({ contentType: 'image/webp', contentLength: bytes.length }),
        })
        await put.arrayBuffer()
        expect(put.status).toBe(200)
        expect(await store.head(k)).toEqual({ contentLength: bytes.length, contentType: 'image/webp' })

        const getUrl = await store.presignGet(k, { expiresSec: 60 })
        const got = await env.fetch(must(getUrl))
        expect(got.status).toBe(200)
        expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true)
        // A presigned GET honours Range like any GET.
        const ranged = await env.fetch(must(getUrl), { headers: { range: 'bytes=10-19' } })
        expect(ranged.status).toBe(206)
        expect(Buffer.from(await ranged.arrayBuffer()).equals(bytes.subarray(10, 20))).toBe(true)
      })

      it('a presigned PUT refuses another content type or size', async () => {
        const k = key('presign/strict.webp')
        const url = must(
          await store.presignPut(k, {
            expiresSec: 120,
            contentType: 'image/webp',
            contentLength: 5,
          }),
        )
        const attempt = async (body: Buffer, contentType: string) => {
          const res = await env.fetch(url, {
            method: 'PUT',
            body,
            headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) },
          })
          await res.arrayBuffer()
          return res.status
        }
        expect(await attempt(Buffer.from('abcde'), 'text/html')).toBe(403)
        expect(await attempt(Buffer.from('abcdef'), 'image/webp')).toBe(403)
        expect(await store.head(k)).toBeNull()
        expect(await attempt(Buffer.from('abcde'), 'image/webp')).toBe(200)
        expect((await store.head(k))?.contentLength).toBe(5)
      })

      it('a presigned URL is scoped to one key and one method', async () => {
        const k = key('presign/scoped.bin')
        const other = key('presign/other.bin')
        await store.put(k, Buffer.from('scoped'), { contentType: 'text/plain', contentLength: 6 })
        await store.put(other, Buffer.from('other!'), { contentType: 'text/plain', contentLength: 6 })
        const getUrl = new URL(must(await store.presignGet(k, { expiresSec: 60 })))
        const moved = new URL(getUrl)
        moved.pathname = moved.pathname.replace(/scoped\.bin$/, 'other.bin')
        const r1 = await env.fetch(moved)
        await r1.arrayBuffer()
        expect(r1.status).toBe(403)
        const r2 = await env.fetch(getUrl, {
          method: 'PUT',
          body: Buffer.from('x'),
          headers: { 'Content-Length': '1' },
        })
        await r2.arrayBuffer()
        expect(r2.status).toBe(403)
        const r3 = await env.fetch(getUrl, { method: 'DELETE' })
        await r3.arrayBuffer()
        expect(r3.status).toBe(403)
        expect((await readAll(must(await store.get(k)).body)).toString()).toBe('scoped')
      })

      it('an expired presigned URL is refused', async () => {
        const k = key('presign/expired.bin')
        await store.put(k, Buffer.from('secret-ish'), { contentType: 'text/plain', contentLength: 10 })
        const withClock = must(env.withClock, 'env.withClock')
        // Control: signed 5 minutes ago for the maximum 15 minutes -> still valid, so a 403 below
        // comes from expiry and not from a clock-shifted signature being wrong.
        const recent = await withClock(-5 * 60_000).presignGet(k, { expiresSec: 900 })
        const ok = await env.fetch(must(recent))
        expect(ok.status).toBe(200)
        expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe('secret-ish')
        // Signed 20 minutes ago for 15 minutes -> expired 5 minutes ago.
        const past = withClock(-20 * 60_000)
        const getUrl = await past.presignGet(k, { expiresSec: 900 })
        const r = await env.fetch(must(getUrl))
        await r.arrayBuffer()
        expect(r.status).toBe(403)
        const putUrl = await past.presignPut(k, {
          expiresSec: 900,
          contentType: 'text/plain',
          contentLength: 1,
        })
        const w = await env.fetch(must(putUrl), {
          method: 'PUT',
          body: Buffer.from('x'),
          headers: presignedPutHeaders({ contentType: 'text/plain', contentLength: 1 }),
        })
        await w.arrayBuffer()
        expect(w.status).toBe(403)
        expect((await readAll(must(await store.get(k)).body)).toString()).toBe('secret-ish')
      })
    } else {
      it('presign returns null (the caller serves and receives bytes itself)', async () => {
        const k = key('presign/none.bin')
        expect(await store.presignGet(k, { expiresSec: 60 })).toBeNull()
        expect(
          await store.presignPut(k, { expiresSec: 60, contentType: 'image/webp', contentLength: 3 }),
        ).toBeNull()
      })
    }

    // Keep last: vitest runs a file's tests in order.
    it('cleanup: deleting every written key leaves the prefix empty', async () => {
      for (const k of written) await store.delete(k)
      expect(await env.listKeys(env.prefix)).toEqual([])
    }, 120_000)
  })
}
