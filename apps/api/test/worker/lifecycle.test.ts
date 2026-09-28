// The job lifecycle over /api/worker/* in fs mode (docs/M3-STORAGE-CONTRACTS.md §4): claim hands out the
// original, derivatives are reserved and uploaded to fs-mode blob URLs, complete verifies every blob
// and publishes the result (rows + board event), idempotently.

import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { derivativeKey } from '../../src/files/blobs.ts'
import { claim, PNG, pathOf, putBlob, reserve, type WorkerEnv, workerEnv } from './helpers.ts'

let env: WorkerEnv
beforeEach(async () => {
  env = await workerEnv()
})
afterEach(() => env.close())

const webp = (n: number, fill = 7) => Buffer.alloc(n, fill)

describe('claim', () => {
  it('204 when there is nothing to do', async () => {
    const res = await env.worker('POST', '/api/worker/claim', { workerId: 'worker-a' })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
  })

  it('leases the job, marks the version processing and hands out the original', async () => {
    const m = await env.upload('Résumé.png')
    const c = await claim(env)
    expect(c?.job).toEqual({
      versionId: m.versionId,
      assetId: m.assetId,
      boardId: env.board,
      kind: 'image',
      name: 'Résumé.png',
      declaredMimeType: 'image/png',
      sizeBytes: PNG.length,
      attempt: 1,
      leaseMs: 120_000,
    })
    // fs mode: an api URL on the origin the worker used, self-authorizing like a presigned URL
    expect(c?.original.url).toMatch(
      /^http:\/\/localhost(:80)?\/api\/worker\/blobs\/o\.ver_[0-9A-Za-z]+\.\d{10}\.[A-Za-z0-9_-]{22}$/,
    )
    const got = await env.api.app.inject({ method: 'GET', url: pathOf(c?.original.url ?? '') })
    expect(got.statusCode).toBe(200)
    expect(got.rawPayload.equals(PNG)).toBe(true)
    expect(got.headers['content-type']).toBe('application/octet-stream')
    expect(got.headers['content-length']).toBe(String(PNG.length))
    expect(got.headers['cache-control']).toBe('no-store')
    expect(await env.meta(m)).toMatchObject({ status: 'processing', attempts: 1, derivatives: [] })
    const job = await env.api.db.one<Record<string, unknown>>(
      'SELECT status, lease_owner, attempts FROM preview_jobs WHERE version_id = $1',
      [m.versionId],
    )
    expect(job).toEqual({ status: 'running', lease_owner: 'worker-a', attempts: 1 })
    // leased: nobody else gets it
    expect(await claim(env, 'worker-b')).toBeNull()
  })

  it('claims the oldest due job first', async () => {
    const first = await env.upload('one.png')
    env.api.clock.advance(1_000)
    const second = await env.upload('two.png')
    expect((await claim(env))?.job.versionId).toBe(first.versionId)
    expect((await claim(env))?.job.versionId).toBe(second.versionId)
    expect(await claim(env)).toBeNull()
  })

  it('validates the body', async () => {
    for (const body of [
      {},
      { workerId: '' },
      { workerId: 'has space' },
      { workerId: 'x'.repeat(200) },
      { workerId: 7 },
    ]) {
      const res = await env.worker('POST', '/api/worker/claim', body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
    }
    const text = await env.worker('POST', '/api/worker/claim', 'workerId=a', { 'content-type': 'text/plain' })
    expect(text.statusCode).toBe(415)
  })
})

describe('derivatives + complete', () => {
  it('the full happy path: reserve, upload, complete ready → rows, meta, served derivative, board event', async () => {
    const m = await env.upload()
    const c = await claim(env)
    if (!c) throw new Error('no job')
    const thumbBytes = webp(16, 1)
    const displayBytes = webp(40, 2)
    const thumb = await reserve(env, m.versionId, {
      role: 'thumb',
      bytes: thumbBytes.length,
      width: 32,
      height: 24,
    })
    const display = await reserve(env, m.versionId, {
      role: 'display',
      bytes: displayBytes.length,
      width: 640,
      height: 480,
      mimeType: 'image/png',
    })
    expect(thumb.upload).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp', 'Content-Length': '16' },
    })
    expect(thumb.upload.url).toMatch(/\/api\/worker\/blobs\/d\.drv_/)
    expect((await putBlob(env, thumb, thumbBytes)).statusCode).toBe(200)
    expect((await putBlob(env, display, displayBytes)).statusCode).toBe(200)
    // uploaded but not published: not served yet
    const unpublished = await env.bob.req(
      'GET',
      `/files/${m.assetId}/${m.versionId}/d/${thumb.derivativeId}?board=${env.board}`,
    )
    expect(unpublished.statusCode).toBe(404)

    const done = await env.worker('POST', `/api/worker/jobs/${m.versionId}/complete`, {
      workerId: 'worker-a',
      status: 'ready',
      mimeType: 'image/png',
      probe: { width: 640, height: 480, fps: 30 },
      derivatives: [display.derivativeId, thumb.derivativeId],
    })
    expect(done.statusCode, done.body).toBe(200)
    expect(done.json()).toEqual({ versionId: m.versionId, status: 'ready', repeated: false })

    const meta = await env.meta(m)
    expect(meta).toMatchObject({ status: 'ready', mimeType: 'image/png', attempts: 1, error: null })
    expect(meta.probe).toEqual({
      width: 640,
      height: 480,
      pageCount: null,
      durationMs: null,
      videoCodec: null,
      audioCodec: null,
    })
    // in the order complete listed them, with the M0 record shape
    expect(meta.derivatives).toEqual([
      {
        id: display.derivativeId,
        role: 'display',
        page: null,
        width: 640,
        height: 480,
        mimeType: 'image/png',
        bytes: displayBytes.length,
        file: `${display.derivativeId}.png`,
      },
      {
        id: thumb.derivativeId,
        role: 'thumb',
        page: null,
        width: 32,
        height: 24,
        mimeType: 'image/webp',
        bytes: thumbBytes.length,
        file: `${thumb.derivativeId}.webp`,
      },
    ])
    const served = await env.bob.req(
      'GET',
      `/files/${m.assetId}/${m.versionId}/d/${thumb.derivativeId}?board=${env.board}`,
    )
    expect(served.statusCode).toBe(200)
    expect(served.rawPayload.equals(thumbBytes)).toBe(true)
    expect(served.headers['content-type']).toBe('image/webp')
    const job = await env.api.db.one<Record<string, unknown>>(
      'SELECT status, lease_until FROM preview_jobs WHERE version_id = $1',
      [m.versionId],
    )
    expect(job).toEqual({ status: 'done', lease_until: null })
    expect(
      (await env.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM asset_derivative_reservations')).n,
    ).toBe(0)
    // the board heard about it, after commit, with nothing but ids and the status
    expect(env.events.filter((e) => e.type === 'assets.version')).toEqual([
      {
        type: 'assets.version',
        boardId: env.board,
        data: { assetId: m.assetId, versionId: m.versionId, status: 'ready' },
      },
    ])
    // the fs-mode URLs are dead now: the job is no longer running
    expect((await env.api.app.inject({ method: 'GET', url: pathOf(c.original.url) })).statusCode).toBe(404)
    expect((await putBlob(env, thumb, thumbBytes)).statusCode).toBe(404)
  })

  it('complete is idempotent for the same worker, and 409 for anyone else', async () => {
    const m = await env.upload()
    await claim(env)
    const r = await reserve(env, m.versionId, { bytes: 16 })
    await putBlob(env, r, webp(16))
    const body = { workerId: 'worker-a', status: 'ready', probe: {}, derivatives: [r.derivativeId] }
    const first = await env.worker('POST', `/api/worker/jobs/${m.versionId}/complete`, body)
    expect(first.json()).toMatchObject({ status: 'ready', repeated: false })
    const before = await env.meta(m)
    env.api.clock.advance(5_000)
    const again = await env.worker('POST', `/api/worker/jobs/${m.versionId}/complete`, body)
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual({ versionId: m.versionId, status: 'ready', repeated: true })
    // even a different body from the same worker is answered with the stored result, changing nothing
    const odd = await env.worker('POST', `/api/worker/jobs/${m.versionId}/complete`, {
      workerId: 'worker-a',
      status: 'failed',
      error: { code: 'INTERNAL' },
    })
    expect(odd.json()).toMatchObject({ status: 'ready', repeated: true })
    expect(await env.meta(m)).toEqual(before)
    expect(env.events.filter((e) => e.type === 'assets.version')).toHaveLength(1) // published once
    const other = await env.worker('POST', `/api/worker/jobs/${m.versionId}/complete`, {
      ...body,
      workerId: 'worker-b',
    })
    expect(other.statusCode).toBe(409)
    expect(other.json().error.code).toBe('LEASE_LOST')
  })

  it('a listed derivative that was reserved but not uploaded (or has the wrong size) is a 409; the job stays leased', async () => {
    const m = await env.upload()
    await claim(env)
    const r = await reserve(env, m.versionId, { bytes: 16 })
    const complete = () =>
      env.worker('POST', `/api/worker/jobs/${m.versionId}/complete`, {
        workerId: 'worker-a',
        status: 'ready',
        derivatives: [r.derivativeId],
      })
    const missing = await complete()
    expect(missing.statusCode).toBe(409)
    expect(missing.json().error.code).toBe('DERIVATIVE_MISSING')
    // a blob of another size under the reserved key (written around the api) is refused the same way
    const key = derivativeKey(m.assetId, m.versionId, r.derivativeId, 'webp')
    await env.api.blobs.put(key, webp(15), { contentType: 'image/webp', contentLength: 15 })
    expect((await complete()).statusCode).toBe(409)
    expect((await env.meta(m)).status).toBe('processing')
    // the upload arrives: complete succeeds
    expect((await putBlob(env, r, webp(16))).statusCode).toBe(200)
    expect((await complete()).statusCode).toBe(200)
    expect((await env.meta(m)).derivatives.map((d) => d.id)).toEqual([r.derivativeId])
  })

  it('a derivative id that is not a reservation of this attempt is a 400', async () => {
    const a = await env.upload('a.png')
    const b = await env.upload('b.png')
    await claim(env)
    await claim(env)
    const ofB = await reserve(env, b.versionId, { bytes: 16 })
    await putBlob(env, ofB, webp(16))
    for (const ids of [['drv_ZZZZZZZZZZZZZZZZZZZZ'], [ofB.derivativeId]]) {
      const res = await env.worker('POST', `/api/worker/jobs/${a.versionId}/complete`, {
        workerId: 'worker-a',
        status: 'ready',
        derivatives: ids,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('UNKNOWN_DERIVATIVE')
    }
    const dup = await env.worker('POST', `/api/worker/jobs/${b.versionId}/complete`, {
      workerId: 'worker-a',
      status: 'ready',
      derivatives: [ofB.derivativeId, ofB.derivativeId],
    })
    expect(dup.statusCode).toBe(400)
  })

  it('unlisted reservations are dropped at complete and their blobs deleted', async () => {
    const m = await env.upload()
    await claim(env)
    const kept = await reserve(env, m.versionId, { bytes: 16 })
    const extra = await reserve(env, m.versionId, { bytes: 20 })
    await putBlob(env, kept, webp(16))
    await putBlob(env, extra, webp(20))
    const extraKey = derivativeKey(m.assetId, m.versionId, extra.derivativeId, 'webp')
    expect(await env.api.blobs.head(extraKey)).not.toBeNull()
    await env.worker('POST', `/api/worker/jobs/${m.versionId}/complete`, {
      workerId: 'worker-a',
      status: 'ready',
      derivatives: [kept.derivativeId],
    })
    expect(await env.api.blobs.head(extraKey)).toBeNull()
  })

  it('failed: the version gets the fixed user-safe message for the code; unknown codes are INTERNAL', async () => {
    const pdf = await env.upload('locked.pdf', Buffer.from('%PDF-1.7 encrypted'), 'application/pdf')
    const vid = await env.upload('clip.mp4', Buffer.from('not really a video'), 'video/mp4')
    await claim(env)
    await claim(env)
    const fail = (versionId: string, body: Record<string, unknown>) =>
      env.worker('POST', `/api/worker/jobs/${versionId}/complete`, {
        workerId: 'worker-a',
        status: 'failed',
        ...body,
      })
    expect(
      (
        await fail(pdf.versionId, {
          error: { code: 'PDF_ENCRYPTED', message: 'qpdf: C:\\tmp\\job-123\\in.pdf: password required' },
        })
      ).statusCode,
    ).toBe(200)
    const pdfMeta = await env.meta(pdf)
    expect(pdfMeta.status).toBe('failed')
    expect(pdfMeta.error).toEqual({
      code: 'PDF_ENCRYPTED',
      message: 'This PDF is password-protected. Download it to view it.',
    })
    expect(JSON.stringify(pdfMeta)).not.toContain('tmp')
    // probe facts learned before the failure are kept; a bogus code is not echoed to users
    await fail(vid.versionId, {
      error: { code: 'SEGFAULT_IN_FFMPEG' },
      probe: { videoCodec: 'hevc', audioCodec: 'aac', durationMs: 1234.4, width: -1 },
    })
    const vidMeta = await env.meta(vid)
    expect(vidMeta.error).toEqual({
      code: 'INTERNAL',
      message: 'The preview could not be made. Try uploading the file again.',
    })
    expect(vidMeta.probe).toEqual({
      width: null,
      height: null,
      pageCount: null,
      durationMs: 1234,
      videoCodec: 'hevc',
      audioCodec: 'aac',
    })
    // the original is still downloadable, as an attachment
    const original = await env.bob.req(
      'GET',
      `/files/${vid.assetId}/${vid.versionId}/original?board=${env.board}`,
    )
    expect(original.statusCode).toBe(200)
    expect(original.headers['content-disposition']).toMatch(/^attachment; /)
    expect(
      env.events.filter((e) => e.type === 'assets.version').map((e) => (e.data as { status: string }).status),
    ).toEqual(['failed', 'failed'])
  })

  it('a confirmed type applies to previewable kinds only: an "other" file keeps octet-stream', async () => {
    const page = await env.upload('page.html', Buffer.from('<script>alert(1)</script>'), 'text/html')
    const pic = await env.upload('pic.png')
    await claim(env)
    await claim(env)
    for (const [v, mimeType] of [
      [page, 'text/html'],
      [pic, 'image/jpeg'],
    ] as const)
      await env.worker('POST', `/api/worker/jobs/${v.versionId}/complete`, {
        workerId: 'worker-a',
        status: 'ready',
        mimeType,
      })
    expect(await env.meta(page)).toMatchObject({
      kind: 'other',
      status: 'ready',
      mimeType: 'application/octet-stream',
    })
    expect(await env.meta(pic)).toMatchObject({ kind: 'image', status: 'ready', mimeType: 'image/jpeg' })
    const served = await env.bob.req(
      'GET',
      `/files/${page.assetId}/${page.versionId}/original?board=${env.board}`,
    )
    expect(served.headers['content-type']).toBe('application/octet-stream')
    expect(served.headers['content-disposition']).toMatch(/^attachment; /)
  })

  it('reservations are validated and capped per attempt', async () => {
    const m = await env.upload()
    await claim(env)
    const bad = [
      { role: 'avatar' },
      { mimeType: 'image/svg+xml' },
      { width: 0 },
      { height: 100_000 },
      { bytes: 0 },
      { bytes: 33 * 1024 * 1024 },
      { role: 'page', page: null },
    ]
    for (const b of bad) {
      const res = await env.worker('POST', `/api/worker/jobs/${m.versionId}/derivatives`, {
        workerId: 'worker-a',
        role: 'thumb',
        mimeType: 'image/webp',
        width: 1,
        height: 1,
        bytes: 1,
        ...b,
      })
      expect(res.statusCode, JSON.stringify(b)).toBe(400)
    }
    for (let i = 0; i < 32; i++) await reserve(env, m.versionId, { role: 'page', page: i + 1 })
    const over = await env.worker('POST', `/api/worker/jobs/${m.versionId}/derivatives`, {
      workerId: 'worker-a',
      role: 'thumb',
      mimeType: 'image/webp',
      width: 1,
      height: 1,
      bytes: 1,
    })
    expect(over.statusCode).toBe(400)
    expect(over.json().error.code).toBe('TOO_MANY_DERIVATIVES')
  })
})

describe('fs-mode blob URLs', () => {
  it('are scoped to one blob and one method, expire, and cannot be forged or edited', async () => {
    const m = await env.upload()
    const c = await claim(env)
    if (!c) throw new Error('no job')
    const r = await reserve(env, m.versionId, { bytes: 16 })
    const get = (url: string, headers: Record<string, string> = {}) =>
      env.api.app.inject({ method: 'GET', url, headers })
    const originalPath = pathOf(c.original.url)
    const putPath = pathOf(r.upload.url)
    // one method each: the GET grant cannot upload, the PUT grant cannot download
    expect(
      (
        await env.api.app.inject({
          method: 'PUT',
          url: originalPath,
          headers: r.upload.headers,
          payload: webp(16),
        })
      ).statusCode,
    ).toBe(404)
    expect((await get(putPath)).statusCode).toBe(404)
    // edited: another version id, a later expiry, a flipped signature character
    const [, , , kindIdExpSig = ''] = originalPath.split('/')
    const [kind, id, exp, sig] = kindIdExpSig.split('.')
    const other = await env.upload('other.png')
    for (const forged of [
      `${kind}.${other.versionId}.${exp}.${sig}`,
      `${kind}.${id}.${Number(exp) + 3600}.${sig}`,
      `${kind}.${id}.${exp}.${sig?.slice(0, -1)}${sig?.endsWith('A') ? 'B' : 'A'}`,
      `d.${id}.${exp}.${sig}`,
      'o.ver_x.1.y',
      '..%2F..%2Fassets',
    ])
      expect((await get(`/api/worker/blobs/${forged}`)).statusCode, forged).toBe(404)
    // a valid grant needs no Authorization header, but a wrong one is refused
    expect((await get(originalPath)).statusCode).toBe(200)
    expect(
      (await get(originalPath, { authorization: 'Bearer wrong-token-0123456789-0123456789-xx' })).statusCode,
    ).toBe(401)
    expect((await get(originalPath, { cookie: 'dr_session=abc' })).statusCode).toBe(403)
    // 15 minutes later it is dead
    env.api.clock.advance(901_000)
    expect((await get(originalPath)).statusCode).toBe(404)
    expect((await putBlob(env, r, webp(16))).statusCode).toBe(404)
  })

  it('a PUT must match the reservation exactly (length, type) and never stores a partial body', async () => {
    const m = await env.upload()
    await claim(env)
    const r = await reserve(env, m.versionId, { bytes: 16 })
    const key = derivativeKey(m.assetId, m.versionId, r.derivativeId, 'webp')
    expect(
      (await putBlob(env, r, webp(17), { 'content-type': 'image/webp', 'content-length': '17' })).statusCode,
    ).toBe(400)
    expect(
      (await putBlob(env, r, webp(16), { 'content-type': 'image/png', 'content-length': '16' })).statusCode,
    ).toBe(400)
    expect((await putBlob(env, r, webp(16), { 'content-type': 'image/webp' })).statusCode).toBe(200) // inject sets the length
    // a body that ends early (inject can send less than it declares)
    const r2 = await reserve(env, m.versionId, { bytes: 1000 })
    const short = await env.api.app.inject({
      method: 'PUT',
      url: pathOf(r2.upload.url),
      headers: { 'content-type': 'image/webp', 'content-length': '1000' },
      payload: (await import('node:stream')).Readable.from([webp(10)]),
    })
    expect(short.statusCode).toBe(400)
    expect(
      await env.api.blobs.head(derivativeKey(m.assetId, m.versionId, r2.derivativeId, 'webp')),
    ).toBeNull()
    const stored = await env.api.blobs.get(key)
    if (!stored) throw new Error('the reserved derivative was not stored')
    const chunks: Buffer[] = []
    for await (const c of stored.body as AsyncIterable<Buffer>) chunks.push(c)
    expect(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(
      createHash('sha256').update(webp(16)).digest('hex'),
    )
  })
})
