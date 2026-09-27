import { mkdirSync, writeFileSync } from 'node:fs'
import {
  type AssetVersionMeta,
  type DerivativeRecord,
  derivativePath,
  derivativesDir,
  newId,
  updateMeta,
} from '@draftroom/dev-assets'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { rawExchange, req, startApp, type TestApp, upload } from './helpers.ts'

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

/** Plays the worker: writes a derivative file and (optionally) publishes it in meta. */
function addDerivative(m: AssetVersionMeta, opts: { list: boolean; mimeType?: string; file?: string }) {
  const id = newId('drv')
  const bytes = Buffer.from(`webp-bytes-${id}`)
  const file = opts.file ?? `${id}.webp`
  mkdirSync(derivativesDir(t.layout, m.assetId, m.versionId), { recursive: true })
  if (!file.includes('/')) writeFileSync(derivativePath(t.layout, m.assetId, m.versionId, file), bytes)
  if (opts.list) {
    const rec = {
      id,
      role: 'thumb',
      page: null,
      width: 1,
      height: 1,
      mimeType: opts.mimeType ?? 'image/webp',
      bytes: bytes.length,
      file,
    } as DerivativeRecord
    updateMeta(t.layout, m.assetId, m.versionId, (cur) => ({
      ...cur,
      derivatives: [...cur.derivatives, rec],
    }))
  }
  return { id, bytes }
}

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

    const head = await req(t.port, { method: 'HEAD', path: metaRoute(img) })
    expect(head.status).toBe(200)
    expect(head.body.length).toBe(0)
  })
})

describe('GET original', () => {
  it('serves the bytes inline for a previewable kind with the security and cache headers', async () => {
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

    const open = await r('bytes=990-')
    expect(open.status).toBe(206)
    expect(open.body.equals(imgBytes.subarray(990))).toBe(true)

    const suffix = await r('bytes=-3')
    expect(suffix.status).toBe(206)
    expect(suffix.body.equals(imgBytes.subarray(imgBytes.length - 3))).toBe(true)

    const clamped = await r('bytes=998-5000')
    expect(clamped.headers['content-range']).toBe(`bytes 998-999/${imgBytes.length}`)

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

  it('serves a failed asset, or a meta with a non-allowlisted type, as an attachment', async () => {
    const bad = (await upload(t.port, { name: 'broken.png' })).json<AssetVersionMeta>()
    updateMeta(t.layout, bad.assetId, bad.versionId, (m) => ({
      ...m,
      status: 'failed',
      error: { code: 'IMAGE_INVALID', message: 'This image could not be read.' },
    }))
    const failed = await req(t.port, { path: original(bad) })
    expect(failed.headers['content-type']).toBe('application/octet-stream')
    expect(failed.headers['content-disposition']).toMatch(/^attachment; /)

    const tampered = (await upload(t.port, { name: 'x.png' })).json<AssetVersionMeta>()
    updateMeta(t.layout, tampered.assetId, tampered.versionId, (m) => ({ ...m, mimeType: 'text/html' }))
    const res = await req(t.port, { path: original(tampered) })
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['content-disposition']).toMatch(/^attachment; /)
  })
})

describe('GET derivative', () => {
  it('serves only derivatives listed in meta, board-scoped, with immutable caching', async () => {
    const listed = addDerivative(img, { list: true })
    const unlisted = addDerivative(img, { list: false })
    const d = (id: string, board = 'board-a') =>
      req(t.port, { path: `/files/${img.assetId}/${img.versionId}/d/${id}?board=${board}` })

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
    expect((await d(listed.id, 'board-b')).status).toBe(404)
    expect((await d(unlisted.id)).status).toBe(404) // on disk, but not published by the worker
    expect((await d(newId('drv'))).status).toBe(404)
    expect((await d('drv_bad!')).status).toBe(404)
    expect(
      (await req(t.port, { path: `/files/${img.assetId}/${img.versionId}/d/${listed.id}` })).status,
    ).toBe(400)
  })

  it('refuses derivative records with a non-image type or a path-like file name', async () => {
    const svg = addDerivative(img, { list: true, mimeType: 'image/svg+xml' })
    const pathLike = addDerivative(img, { list: true, file: '../meta.json' })
    for (const id of [svg.id, pathLike.id]) {
      const res = await req(t.port, { path: `/files/${img.assetId}/${img.versionId}/d/${id}?board=board-a` })
      expect(res.status).toBe(404)
    }
  })
})

describe('ids are validated before touching the filesystem', () => {
  it('traversal attempts in every id position are 400/404 and never serve data files', async () => {
    const paths = [
      `/files/..%2F..%2Frooms/${img.versionId}/original?board=board-a`,
      `/files/${img.assetId}/..%2Fmeta.json/original?board=board-a`,
      `/files/${img.assetId}/${img.versionId}/d/..%2F..%2Fmeta.json?board=board-a`,
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
