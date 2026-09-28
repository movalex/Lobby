// createR2BlobStore against an in-process fake of the R2 S3 API (injected fetch; no network, no
// ports), so the R2 code path is covered on every machine. The live suite is r2-live.test.ts.

import { inspect } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BlobStore, BlobStoreError, createR2BlobStore, type R2BlobStoreConfig } from '../src/index.ts'
import { createFakeS3, FAKE_CREDS, FAKE_ENDPOINT, type FakeS3 } from './fake-s3.ts'
import { MiB, must, patternSource, readAll, rejectionOf } from './helpers.ts'
import { blobStoreSuite } from './suite.ts'

function baseConfig(fake: FakeS3, extra: Partial<R2BlobStoreConfig> = {}): R2BlobStoreConfig {
  return { ...FAKE_CREDS, endpoint: FAKE_ENDPOINT, fetch: fake.fetch, ...extra }
}

{
  let fake: FakeS3
  blobStoreSuite(
    'r2 (in-process fake S3)',
    { persistsContentType: true, presigns: true, bigUploadBytes: 200 * MiB, bigUploadTimeoutMs: 180_000 },
    async () => {
      fake = createFakeS3()
      return {
        store: createR2BlobStore(baseConfig(fake)),
        withClock: (offsetMs) => createR2BlobStore(baseConfig(fake, { now: () => Date.now() + offsetMs })),
        prefix: `test/fake-${Date.now().toString(36)}/`,
        listKeys: (prefix) => fake.listKeys(prefix),
        fetch: fake.fetch,
        receivedBytes: () => fake.receivedBytes(),
        async teardown() {
          fake.close()
        },
      }
    },
  )
}

describe('r2 blob store specifics (fake S3)', () => {
  let fake: FakeS3
  let store: BlobStore
  beforeAll(() => {
    fake = createFakeS3()
    store = createR2BlobStore(baseConfig(fake, { timeoutMs: 300, stallTimeoutMs: 300 }))
  })
  afterAll(() => fake.close())

  const lastRequest = () => must(fake.requests[fake.requests.length - 1])

  it('sends path-style, SigV4-signed requests: UNSIGNED-PAYLOAD and an exact Content-Length on PUT', async () => {
    await store.put('assets/ast_a/ver_b/original', patternSource(123_457), {
      contentType: 'video/mp4',
      contentLength: 123_457,
    })
    const put = lastRequest()
    expect(put.method).toBe('PUT')
    expect(put.path).toBe(`/${FAKE_CREDS.bucket}/assets/ast_a/ver_b/original`)
    expect(put.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD')
    expect(put.headers['content-length']).toBe('123457')
    expect(put.headers['content-type']).toBe('video/mp4')
    expect(put.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAFAKEACCESSKEY123\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    )
    await store.get('assets/ast_a/ver_b/original', { range: { start: 5, end: 9 } })
    expect(lastRequest().headers.range).toBe('bytes=5-9')
    expect(lastRequest().headers['accept-encoding']).toBe('identity')
  })

  it("sends every request with redirect: 'error' (otherwise Node's fetch tees and buffers a streamed body)", async () => {
    // The buffering itself only shows over a real connection; r2-live.test.ts measures it. Here we
    // pin the option that prevents it, for every kind of request.
    const from = fake.requests.length
    await store.put('redirect/x', patternSource(1000), { contentType: 'text/plain', contentLength: 1000 })
    await store.put('redirect/y', Buffer.from('y'), { contentType: 'text/plain', contentLength: 1 })
    await readAll(must(await store.get('redirect/x')).body)
    await store.head('redirect/x')
    await store.delete('redirect/x')
    await store.delete('redirect/y')
    const sent = fake.requests.slice(from)
    expect(sent.map((r) => r.method)).toEqual(['PUT', 'PUT', 'GET', 'HEAD', 'DELETE', 'DELETE'])
    for (const r of sent) expect(r.redirect).toBe('error')
  })

  it('presigned URLs are query-signed for one method with X-Amz-Expires and signed Content-Type/-Length', async () => {
    const put = new URL(
      must(
        await store.presignPut('a/b.webp', {
          expiresSec: 300,
          contentType: 'image/webp',
          contentLength: 42,
        }),
      ),
    )
    expect(put.origin + put.pathname).toBe(`${FAKE_ENDPOINT}/${FAKE_CREDS.bucket}/a/b.webp`)
    expect(put.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(put.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host')
    expect(put.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(put.searchParams.get('X-Amz-Credential')).toMatch(/\/auto\/s3\/aws4_request$/)
    const get = new URL(must(await store.presignGet('a/b.webp', { expiresSec: 900 })))
    expect(get.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(get.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    for (const u of [put, get]) expect(u.toString().includes(FAKE_CREDS.secretAccessKey)).toBe(false)
  })

  it('retries 5xx and 429 for idempotent requests, then succeeds', async () => {
    await store.put('retry/x', Buffer.from('ok'), { contentType: 'text/plain', contentLength: 2 })
    const before = fake.requests.length
    fake.fail(503, 'SlowDown')
    fake.fail(429, 'TooManyRequests')
    expect(await store.head('retry/x')).toEqual({ contentLength: 2, contentType: 'text/plain' })
    expect(fake.requests.length - before).toBe(3)
    fake.fail(500, 'InternalError')
    await store.put('retry/y', Buffer.from('ok'), { contentType: 'text/plain', contentLength: 2 })
    expect((await store.head('retry/y'))?.contentLength).toBe(2)
  })

  it('gives up after 1 + retries attempts with UPSTREAM and the status', async () => {
    const before = fake.requests.length
    fake.fail(500, 'InternalError', 3)
    const e = (await rejectionOf(store.get('retry/x'))) as BlobStoreError
    expect(e).toBeInstanceOf(BlobStoreError)
    expect(e.code).toBe('UPSTREAM')
    expect(e.status).toBe(500)
    expect(e.upstreamCode).toBe('InternalError')
    expect(fake.requests.length - before).toBe(3)
  })

  it('never retries a streamed PUT (its body cannot be replayed)', async () => {
    const before = fake.requests.length
    fake.fail(500, 'InternalError')
    const src = patternSource(10_000)
    const e = (await rejectionOf(
      store.put('retry/stream', src, { contentType: 'text/plain', contentLength: 10_000 }),
    )) as BlobStoreError
    expect(e.code).toBe('UPSTREAM')
    expect(e.status).toBe(500)
    expect(fake.requests.length - before).toBe(1)
    expect(src.destroyed).toBe(true)
    expect(await store.head('retry/stream')).toBeNull()
  })

  it('a request that never answers times out (per attempt) with TIMEOUT', async () => {
    const quick = createR2BlobStore(baseConfig(fake, { timeoutMs: 150, retries: 1 }))
    const before = fake.requests.length
    fake.hang(2)
    const t0 = Date.now()
    const e = (await rejectionOf(quick.head('timeout/x'))) as BlobStoreError
    expect(e.code).toBe('TIMEOUT')
    expect(fake.requests.length - before).toBe(2)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290)
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('a download that stops sending bytes fails with TIMEOUT instead of hanging', async () => {
    await store.put('stall/x', patternSource(MiB), { contentType: 'video/mp4', contentLength: MiB })
    fake.stallDownloadsAfter(100_000)
    try {
      const obj = await store.get('stall/x')
      const e = (await rejectionOf(readAll(must(obj).body))) as BlobStoreError
      expect(e).toBeInstanceOf(BlobStoreError)
      expect(e.code).toBe('TIMEOUT')
    } finally {
      fake.stallDownloadsAfter(null)
    }
    expect((await readAll(must(await store.get('stall/x')).body)).length).toBe(MiB)
  })

  it('an upload whose source stops producing fails with TIMEOUT and stores nothing', async () => {
    const src = patternSource(MiB, { stallAfter: 200_000 })
    const t0 = Date.now()
    const e = (await rejectionOf(
      store.put('stall/up', src, { contentType: 'video/mp4', contentLength: MiB }),
    )) as BlobStoreError
    expect(e.code).toBe('TIMEOUT')
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(src.destroyed).toBe(true)
    expect(await store.head('stall/up')).toBeNull()
  })

  it('refuses odd upstream answers instead of guessing (no length, wrong Content-Range, ignored Range)', async () => {
    await store.put('odd/x', Buffer.from('0123456789'), { contentType: 'text/plain', contentLength: 10 })
    const edit = (fn: (h: Headers) => void, status?: number) => (res: Response) => {
      const h = new Headers(res.headers)
      fn(h)
      return new Response(res.body, { status: status ?? res.status, headers: h })
    }
    const code = async (p: Promise<unknown>) => ((await rejectionOf(p)) as BlobStoreError).code

    fake.rewriteNext(edit((h) => h.delete('content-length')))
    expect(await code(store.head('odd/x'))).toBe('UPSTREAM')
    fake.rewriteNext(edit((h) => h.delete('content-length')))
    expect(await code(store.get('odd/x'))).toBe('UPSTREAM')
    fake.rewriteNext(edit((h) => h.set('content-length', '1e3')))
    expect(await code(store.get('odd/x'))).toBe('UPSTREAM')
    // A 206 for other bytes than the ones asked for.
    fake.rewriteNext(edit((h) => h.set('content-range', 'bytes 0-4/10')))
    expect(await code(store.get('odd/x', { range: { start: 2, end: 6 } }))).toBe('UPSTREAM')
    // A 200 (Range ignored) for a partial range.
    fake.rewriteNext(edit((h) => h.delete('content-range'), 200))
    expect(await code(store.get('odd/x', { range: { start: 2, end: 6 } }))).toBe('UPSTREAM')
    // A 200 for a range that covers the whole object is the same bytes: accepted.
    fake.rewriteNext(edit((h) => h.delete('content-range'), 200))
    const whole = must(await store.get('odd/x', { range: { start: 0, end: 99 } }))
    expect(whole.contentRange).toBe('bytes 0-9/10')
    expect((await readAll(whole.body)).toString()).toBe('0123456789')
  })

  it('a 404 for a missing bucket is an error, not a missing object', async () => {
    const wrong = createR2BlobStore(baseConfig(fake, { bucket: 'draftroom-other', retries: 0 }))
    const e = (await rejectionOf(wrong.get('x/y'))) as BlobStoreError
    expect(e.code).toBe('UPSTREAM')
    expect(e.status).toBe(404)
    expect(e.upstreamCode).toBe('NoSuchBucket')
  })

  it('errors carry no secret, access key, signature, host or upstream body', async () => {
    const errors: unknown[] = []
    const badSecret = createR2BlobStore(
      baseConfig(fake, { secretAccessKey: 'wrong-secret-0123456789', retries: 0 }),
    )
    errors.push(await rejectionOf(badSecret.get('assets/ast_x/ver_y/original')))
    errors.push(
      await rejectionOf(
        badSecret.put('a/b', Buffer.from('x'), { contentType: 'text/plain', contentLength: 1 }),
      ),
    )
    errors.push(await rejectionOf(badSecret.head('a/b')))
    const offline = createR2BlobStore(
      baseConfig(fake, { endpoint: 'https://offline-r2.invalid', retries: 0 }),
    )
    errors.push(await rejectionOf(offline.get('a/b')))
    errors.push(
      await rejectionOf(
        offline.put('a/b', patternSource(10), { contentType: 'text/plain', contentLength: 10 }),
      ),
    )
    fake.hang(1)
    errors.push(
      await rejectionOf(createR2BlobStore(baseConfig(fake, { timeoutMs: 50, retries: 0 })).head('a/b')),
    )

    const first = errors[0] as BlobStoreError
    expect(first.code).toBe('UPSTREAM')
    expect(first.status).toBe(403)
    expect(first.upstreamCode).toBe('SignatureDoesNotMatch')
    expect((errors[3] as BlobStoreError).code).toBe('NETWORK')
    expect((errors[3] as BlobStoreError).upstreamCode).toBe('ENOTFOUND')
    expect((errors[5] as BlobStoreError).code).toBe('TIMEOUT')

    const forbidden = [
      FAKE_CREDS.accessKeyId,
      FAKE_CREDS.secretAccessKey,
      'wrong-secret',
      FAKE_CREDS.accountId,
      'fake-r2.invalid',
      'offline-r2.invalid',
      'X-Amz',
      'StringToSign',
      'AWSAccessKeyId',
      'https://',
    ]
    for (const e of errors) {
      expect(e).toBeInstanceOf(BlobStoreError)
      const text = [inspect(e, { depth: 5 }), JSON.stringify(e), (e as Error).stack ?? ''].join('\n')
      for (const s of forbidden) expect(text.includes(s), `error text contains ${s}`).toBe(false)
    }
  })

  it('the store object exposes no credentials', () => {
    const text = [inspect(store, { depth: 10, showHidden: true }), JSON.stringify(store)].join('\n')
    expect(text.includes(FAKE_CREDS.secretAccessKey)).toBe(false)
    expect(text.includes(FAKE_CREDS.accessKeyId)).toBe(false)
    expect(store.kind).toBe('r2')
  })

  it('validates its config without echoing values', () => {
    const bad: Array<Partial<R2BlobStoreConfig>> = [
      { bucket: 'Bad_Bucket' },
      { bucket: '' },
      { accountId: 'has/slash' },
      { secretAccessKey: '' },
      { accessKeyId: '' },
      { endpoint: 'http://r2.example.com' }, // plain http only for loopback
      { endpoint: 'https://user:pw@r2.example.com' },
      { endpoint: 'https://r2.example.com/path' },
      { endpoint: 'not a url' },
      { timeoutMs: 0 },
      { retries: -1 },
    ]
    for (const b of bad) {
      let err: unknown
      try {
        createR2BlobStore({ ...FAKE_CREDS, ...b })
      } catch (e) {
        err = e
      }
      expect(err, JSON.stringify(Object.keys(b))).toBeInstanceOf(BlobStoreError)
      expect((err as BlobStoreError).code).toBe('INVALID_ARGUMENT')
      expect((err as Error).message.includes(FAKE_CREDS.secretAccessKey)).toBe(false)
      expect((err as Error).message.includes('example.com')).toBe(false)
    }
    expect(createR2BlobStore({ ...FAKE_CREDS, endpoint: 'http://127.0.0.1:9000' }).kind).toBe('r2')
    expect(createR2BlobStore({ ...FAKE_CREDS }).kind).toBe('r2')
  })
})
