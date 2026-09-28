// The api in R2 mode (docs/M3-STORAGE-CONTRACTS.md §1, §3, §4) against packages/blob-store's in-process
// fake of the R2 S3 API (it verifies SigV4 header and presigned-query signatures, expiry and exact
// lengths). Uploads stream to "R2", the worker gets presigned GET/PUT URLs (it never sees credentials),
// complete verifies the uploaded derivatives with HEAD, and the file routes proxy bytes (with Range).

import { Writable } from 'node:stream'
import { createR2BlobStore } from '@draftroom/blob-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFakeS3,
  FAKE_CREDS,
  FAKE_ENDPOINT,
  type FakeS3,
} from '../../../../packages/blob-store/test/fake-s3.ts'
import { claim, PNG, reserve, type WorkerEnv, workerEnv } from './helpers.ts'

let fake: FakeS3
let env: WorkerEnv
let logs: string[]

beforeEach(async () => {
  fake = createFakeS3()
  logs = []
  const stream = new Writable({
    write(chunk, _enc, done) {
      logs.push(String(chunk))
      done()
    },
  })
  const blobs = createR2BlobStore({ ...FAKE_CREDS, endpoint: FAKE_ENDPOINT, fetch: fake.fetch })
  env = await workerEnv({ deps: { blobs, logger: { level: 'info', stream } } })
})
afterEach(async () => {
  await env.close()
  fake.close()
})

describe('R2 mode', () => {
  it('uploads stream to the bucket; the worker round trip uses presigned URLs only; files are proxied', async () => {
    const bytes = Buffer.concat([PNG, Buffer.alloc(5000, 0x5a)])
    const m = await env.upload('photo.png', bytes)
    expect(await fake.listKeys('assets/')).toEqual([`assets/${m.assetId}/${m.versionId}/original`])

    const c = await claim(env)
    if (!c) throw new Error('no job')
    const getUrl = new URL(c.original.url)
    expect(getUrl.origin).toBe(FAKE_ENDPOINT)
    expect(getUrl.pathname).toBe(`/${FAKE_CREDS.bucket}/assets/${m.assetId}/${m.versionId}/original`)
    expect(getUrl.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(c.original.url).not.toContain(FAKE_CREDS.secretAccessKey)
    // the worker downloads with nothing but the URL
    const got = await fake.fetch(c.original.url)
    expect(got.status).toBe(200)
    expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true)

    const thumb = Buffer.alloc(300, 1)
    const r = await reserve(env, m.versionId, { bytes: thumb.length })
    expect(new URL(r.upload.url).origin).toBe(FAKE_ENDPOINT)
    expect(r.upload.headers).toEqual({ 'Content-Type': 'image/webp', 'Content-Length': '300' })
    // the signature binds type and size: anything else is refused by "R2"
    const wrongType = await fake.fetch(r.upload.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html', 'Content-Length': '300' },
      body: thumb,
    })
    expect(wrongType.status).toBe(403)
    const put = await fake.fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body: thumb })
    expect(put.status).toBe(200)

    const done = await env.worker('POST', `/api/worker/jobs/${m.versionId}/complete`, {
      workerId: 'worker-a',
      status: 'ready',
      mimeType: 'image/png',
      probe: { width: 1, height: 1 },
      derivatives: [r.derivativeId],
    })
    expect(done.statusCode, done.body).toBe(200)
    const meta = await env.meta(m)
    expect(meta).toMatchObject({ status: 'ready', derivatives: [{ id: r.derivativeId, bytes: 300 }] })

    // the browser only ever talks to the api: bytes are proxied, Range included
    const part = await env.bob.req(
      'GET',
      `/files/${m.assetId}/${m.versionId}/original?board=${env.board}`,
      undefined,
      {
        range: 'bytes=8-15',
      },
    )
    expect(part.statusCode).toBe(206)
    expect(part.rawPayload.equals(bytes.subarray(8, 16))).toBe(true)
    expect(part.headers['content-range']).toBe(`bytes 8-15/${bytes.length}`)
    expect(part.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
    const d = await env.bob.req(
      'GET',
      `/files/${m.assetId}/${m.versionId}/d/${r.derivativeId}?board=${env.board}`,
    )
    expect(d.statusCode).toBe(200)
    expect(d.rawPayload.equals(thumb)).toBe(true)
    expect(d.headers['content-type']).toBe('image/webp')

    // presigned URLs and credentials never reach the logs
    const all = logs.join('')
    expect(logs.length).toBeGreaterThan(3)
    for (const s of [
      'X-Amz-Signature',
      'X-Amz-Credential',
      FAKE_CREDS.accessKeyId,
      FAKE_CREDS.secretAccessKey,
      FAKE_ENDPOINT,
    ])
      expect(all.includes(s), s).toBe(false)
  })

  it('complete refuses a reservation whose object is not in the bucket (HEAD), then accepts it', async () => {
    const m = await env.upload()
    await claim(env)
    const r = await reserve(env, m.versionId, { bytes: 10 })
    const complete = () =>
      env.worker('POST', `/api/worker/jobs/${m.versionId}/complete`, {
        workerId: 'worker-a',
        status: 'ready',
        derivatives: [r.derivativeId],
      })
    expect((await complete()).statusCode).toBe(409)
    await fake.fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body: Buffer.alloc(10) })
    expect((await complete()).statusCode).toBe(200)
  })

  it('an upload that fails in R2 leaves no object and no rows; a reclaimed job loses its uploaded derivatives', async () => {
    fake.fail(500, 'InternalError', 1)
    const res = await env.api.app.inject({
      method: 'POST',
      url: `/api/boards/${env.board}/assets`,
      payload: Buffer.alloc(2000, 1),
      headers: {
        origin: 'http://127.0.0.1:5173',
        cookie: env.bob.cookie,
        'content-type': 'image/png',
        'x-file-name': 'x.png',
      },
    })
    expect(res.statusCode).toBe(500)
    expect(await fake.listKeys('')).toEqual([])
    expect((await env.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM asset_versions')).n).toBe(0)

    const m = await env.upload()
    await claim(env, 'worker-a')
    const r = await reserve(env, m.versionId, { bytes: 10 })
    await fake.fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body: Buffer.alloc(10) })
    expect(await fake.listKeys(`assets/${m.assetId}/${m.versionId}/d/`)).toHaveLength(1)
    env.api.clock.advance(121_000)
    await claim(env, 'worker-b') // reclaim: worker-a's derivative is abandoned and deleted
    expect(await fake.listKeys(`assets/${m.assetId}/${m.versionId}/d/`)).toEqual([])
  })
})
