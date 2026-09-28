import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type AssetVersionMeta, newId } from '@draftroom/dev-assets'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { addDerivative, rawExchange, req, setVersion, startApp, type TestApp, upload } from './helpers.ts'

let t: TestApp
let img: AssetVersionMeta
const imgBytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))

beforeAll(async () => {
  t = await startApp()
  img = (await upload(t.port, { board: 'board-a', body: imgBytes, name: 'Résumé (1).png' })).json()
})
afterAll(async () => {
  await t.stop()
})
beforeEach(() => {
  // alice may view both boards here; access denials live in auth.test.ts
  t.auth.roles = { 'board-a': 'editor', 'board-b': 'editor' }
})

const original = (m: AssetVersionMeta, board = m.boardId) =>
  `/files/${m.assetId}/${m.versionId}/original?board=${board}`
const metaRoute = (m: AssetVersionMeta, board = m.boardId) =>
  `/api/boards/${board}/assets/${m.assetId}/${m.versionId}`

describe('GET meta', () => {
  it('returns the meta for its own board with no-store, 404 for any other board', async () => {
    const ok = await req(t.port, { path: metaRoute(img) })
    expect(ok.status).toBe(200)
    expect(ok.headers['cache-control']).toBe('no-store')
    expect(ok.headers['x-content-type-options']).toBe('nosniff')
    expect(ok.json()).toMatchObject({ assetId: img.assetId, versionId: img.versionId, boardId: 'board-a' })

    const other = await req(t.port, { path: metaRoute(img, 'board-b') })
    const missing = await req(t.port, { path: metaRoute({ ...img, versionId: newId('ver') }) })
    // identical answers: another board's asset is indistinguishable from one that does not exist
    expect(other.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(other.body.equals(missing.body)).toBe(true)
    expect(other.json()).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } })
    expect((await req(t.port, { path: metaRoute(img, 'Board-A') })).status).toBe(400)
    // a real version id under another asset id is not that asset's version
    const crossed = await req(t.port, { path: metaRoute({ ...img, assetId: newId('ast') }) })
    expect(crossed.status).toBe(404)

    const head = await req(t.port, { method: 'HEAD', path: metaRoute(img) })
    expect(head.status).toBe(200)
    expect(head.body.length).toBe(0)
  })

  it('reflects the worker result from the database: status, confirmed type, error, probe and derivatives in order', async () => {
    const m = (await upload(t.port, { name: 'scan.png', body: Buffer.alloc(64, 9) })).json<AssetVersionMeta>()
    const a = await addDerivative(t, m, { publish: true })
    const b = await addDerivative(t, m, { publish: true, mimeType: 'image/png' })
    await t.db.query(
      `UPDATE asset_versions SET status = 'ready', mime_type = 'image/jpeg', attempts = 1,
          probe = '{"width": 640, "height": 480}'::jsonb WHERE id = $1`,
      [m.versionId],
    )
    const got = (await req(t.port, { path: metaRoute(m) })).json<AssetVersionMeta>()
    expect(got).toMatchObject({ status: 'ready', mimeType: 'image/jpeg', attempts: 1, error: null })
    expect(got.probe).toEqual({
      width: 640,
      height: 480,
      pageCount: null,
      durationMs: null,
      videoCodec: null,
      audioCodec: null,
    })
    expect(got.derivatives).toEqual([a.record, b.record])
    expect(Object.keys(got.derivatives[0] ?? {})).toEqual([
      'id',
      'role',
      'page',
      'width',
      'height',
      'mimeType',
      'bytes',
      'file',
    ])
    await setVersion(t.db, m.versionId, {
      status: 'failed',
      error: { code: 'IMAGE_INVALID', message: 'This image could not be previewed.' },
    })
    expect((await req(t.port, { path: metaRoute(m) })).json().error).toEqual({
      code: 'IMAGE_INVALID',
      message: 'This image could not be previewed.',
    })
  })
})

describe('GET original', () => {
  it('proxies the bytes inline for a previewable kind with the security and cache headers', async () => {
    const res = await req(t.port, { path: original(img) })
    expect(res.status).toBe(200)
    expect(res.body.equals(imgBytes)).toBe(true)
    expect(res.headers).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(imgBytes.length),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, max-age=3600',
      'accept-ranges': 'bytes',
    })
    expect(res.headers['content-disposition']).toBe(
      `inline; filename="R_sum_ (1).png"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%281%29.png`,
    )
    const head = await req(t.port, { method: 'HEAD', path: original(img) })
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(String(imgBytes.length))
    expect(head.headers['content-type']).toBe('image/png')
    expect(head.body.length).toBe(0)
  })

  it('is board-scoped: another board, no board and a bad board never reveal the file', async () => {
    const other = await req(t.port, { path: original(img, 'board-b') })
    expect(other.status).toBe(404)
    expect(other.headers['content-type']).toMatch(/^application\/json/)
    expect((await req(t.port, { path: `/files/${img.assetId}/${img.versionId}/original` })).status).toBe(400)
    expect((await req(t.port, { path: original(img, 'BOARD-A') })).status).toBe(400)
    // the first ?board= wins, as with URLSearchParams in M0: no smuggling a second board past the check
    const smuggled = `/files/${img.assetId}/${img.versionId}/original?board=board-b&board=board-a`
    expect((await req(t.port, { path: smuggled })).status).toBe(404)
  })

  it('supports single byte ranges with 206, and 416 for unsatisfiable ones', async () => {
    const r = async (range: string) => req(t.port, { path: original(img), headers: { Range: range } })
    const mid = await r('bytes=2-5')
    expect(mid.status).toBe(206)
    expect(mid.body.equals(imgBytes.subarray(2, 6))).toBe(true)
    expect(mid.headers['content-range']).toBe(`bytes 2-5/${imgBytes.length}`)
    expect(mid.headers['content-length']).toBe('4')
    expect(mid.headers['accept-ranges']).toBe('bytes')
    expect(mid.headers['x-content-type-options']).toBe('nosniff')
    expect(mid.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
    expect(mid.headers['content-disposition']).toMatch(/^inline; /)

    const open = await r('bytes=990-')
    expect(open.status).toBe(206)
    expect(open.body.equals(imgBytes.subarray(990))).toBe(true)

    const suffix = await r('bytes=-3')
    expect(suffix.status).toBe(206)
    expect(suffix.body.equals(imgBytes.subarray(imgBytes.length - 3))).toBe(true)

    const clamped = await r('bytes=998-5000')
    expect(clamped.headers['content-range']).toBe(`bytes 998-999/${imgBytes.length}`)
    expect(clamped.body.equals(imgBytes.subarray(998))).toBe(true)

    const last = await r('bytes=999-999')
    expect(last.status).toBe(206)
    expect(last.body.equals(imgBytes.subarray(999))).toBe(true)

    const beyond = await r(`bytes=${imgBytes.length}-`)
    expect(beyond.status).toBe(416)
    expect(beyond.headers['content-range']).toBe(`bytes */${imgBytes.length}`)
    expect(beyond.headers['accept-ranges']).toBe('bytes')
    expect(beyond.json().error.code).toBe('RANGE_NOT_SATISFIABLE')

    // malformed and multi-range headers are ignored: the whole file
    for (const ignored of ['bytes=5-2', 'items=0-1', 'bytes=0-1,4-5']) {
      const full = await r(ignored)
      expect(full.status).toBe(200)
      expect(full.body.length).toBe(imgBytes.length)
    }
  })

  it('serves an empty original as a 200 with Content-Length 0', async () => {
    const empty = (
      await upload(t.port, { body: Buffer.alloc(0), name: 'empty.png' })
    ).json<AssetVersionMeta>()
    const res = await req(t.port, { path: original(empty) })
    expect(res.status).toBe(200)
    expect(res.headers['content-length']).toBe('0')
    expect(res.body.length).toBe(0)
  })

  it('serves "other" kinds as an octet-stream attachment even when declared as HTML', async () => {
    const html = (
      await upload(t.port, {
        type: 'text/html',
        name: 'evil.html',
        body: Buffer.from('<script>alert(1)</script>'),
      })
    ).json<AssetVersionMeta>()
    const res = await req(t.port, { path: original(html) })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="evil.html"; filename*=UTF-8''evil.html`,
    )
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
  })

  it('serves a failed asset, or a row with a non-allowlisted type, as an attachment', async () => {
    const bad = (await upload(t.port, { name: 'broken.png' })).json<AssetVersionMeta>()
    await setVersion(t.db, bad.versionId, {
      status: 'failed',
      error: { code: 'IMAGE_INVALID', message: 'This image could not be read.' },
    })
    const failed = await req(t.port, { path: original(bad) })
    expect(failed.headers['content-type']).toBe('application/octet-stream')
    expect(failed.headers['content-disposition']).toMatch(/^attachment; /)

    const tampered = (await upload(t.port, { name: 'x.png' })).json<AssetVersionMeta>()
    await setVersion(t.db, tampered.versionId, { mimeType: 'text/html' })
    const res = await req(t.port, { path: original(tampered) })
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['content-disposition']).toMatch(/^attachment; /)
  })

  it('a row whose blob is gone is a 404 (GET and HEAD), never a 500 or a hanging response', async () => {
    const lost = (
      await upload(t.port, { name: 'lost.png', body: Buffer.alloc(10, 1) })
    ).json<AssetVersionMeta>()
    rmSync(join(t.blobRoot, 'assets', lost.assetId), { recursive: true, force: true })
    expect((await req(t.port, { path: original(lost) })).status).toBe(404)
    expect((await req(t.port, { method: 'HEAD', path: original(lost) })).status).toBe(404)
    expect((await req(t.port, { path: original(lost), headers: { Range: 'bytes=0-1' } })).status).toBe(404)
  })
})

describe('GET derivative', () => {
  it('serves only derivatives that complete published (rows), board-scoped, with immutable caching', async () => {
    const listed = await addDerivative(t, img, { publish: true })
    const unlisted = await addDerivative(t, img, { publish: false }) // stored, like a running job's upload
    const d = (id: string, board = 'board-a', headers: Record<string, string> = {}) =>
      req(t.port, { path: `/files/${img.assetId}/${img.versionId}/d/${id}?board=${board}`, headers })

    const ok = await d(listed.id)
    expect(ok.status).toBe(200)
    expect(ok.body.equals(listed.bytes)).toBe(true)
    expect(ok.headers).toMatchObject({
      'content-type': 'image/webp',
      'content-length': String(listed.bytes.length),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, max-age=31536000, immutable',
      'accept-ranges': 'bytes',
    })
    const part = await d(listed.id, 'board-a', { Range: 'bytes=1-3' })
    expect(part.status).toBe(206)
    expect(part.body.equals(listed.bytes.subarray(1, 4))).toBe(true)
    expect(part.headers['content-range']).toBe(`bytes 1-3/${listed.bytes.length}`)
    expect((await d(listed.id, 'board-b')).status).toBe(404)
    expect((await d(unlisted.id)).status).toBe(404) // in the store, but not published by the worker
    expect((await d(newId('drv'))).status).toBe(404)
    expect((await d('drv_bad!')).status).toBe(404)
    expect(
      (await req(t.port, { path: `/files/${img.assetId}/${img.versionId}/d/${listed.id}` })).status,
    ).toBe(400)
  })

  it('the database refuses derivative rows with a non-image type or a key outside the version', async () => {
    const id = newId('drv')
    const insert = (mime: string, key: string) =>
      t.db.query(
        `INSERT INTO asset_derivatives (id, version_id, position, role, width, height, mime_type, bytes, blob_key)
         VALUES ($1, $2, 99, 'thumb', 1, 1, $3, 4, $4)`,
        [id, img.versionId, mime, key],
      )
    const good = `assets/${img.assetId}/${img.versionId}/d/${id}.webp`
    await expect(insert('image/svg+xml', good)).rejects.toThrow()
    await expect(insert('image/webp', `assets/${img.assetId}/${img.versionId}/original`)).rejects.toThrow()
    await expect(insert('image/webp', `assets/${img.assetId}/../../x/d/${id}.webp`)).rejects.toThrow()
    await expect(insert('image/webp', `rooms/board-a.sqlite`)).rejects.toThrow()
  })
})

describe('ids are validated before touching storage', () => {
  it('traversal attempts in every id position are 400/404 and never serve data', async () => {
    const paths = [
      `/files/..%2F..%2Frooms/${img.versionId}/original?board=board-a`,
      `/files/${img.assetId}/..%2Fmeta.json/original?board=board-a`,
      `/files/${img.assetId}/${img.versionId}/d/..%2F..%2Foriginal?board=board-a`,
      `/files/${img.assetId}/${img.versionId}/d/%2e%2e?board=board-a`,
      `/api/boards/board-a/assets/${img.assetId}/..%5C..%5Cjobs`,
      `/api/boards/..%2Fboard-a/assets/${img.assetId}/${img.versionId}`,
      `/files/${img.assetId}/${img.versionId}/original?board=..%2Fboard-a`,
      '/files/ast_x/ver_y/original?board=board-a',
    ]
    for (const path of paths) {
      const res = await req(t.port, { path })
      expect([400, 404], path).toContain(res.status)
      expect(res.headers['content-type'], path).toMatch(/^application\/json/)
      expect(res.json().error.code, path).toMatch(/^(NOT_FOUND|INVALID_BOARD_ID)$/)
    }
    // dot segments sent raw match no file route and cannot climb out of /files
    const raw = await rawExchange(t.port, (s) =>
      s.end(
        `GET /files/${img.assetId}/${img.versionId}/../../../rooms HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      ),
    )
    expect(raw).toMatch(/^HTTP\/1\.1 404 /)
  })
})
