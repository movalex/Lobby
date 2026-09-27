import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AssetVersionMeta,
  isId,
  LIMITS,
  metaPath,
  originalPath,
  PREVIEW_PROFILE,
  type PreviewJob,
} from '@draftroom/dev-assets'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listFiles, rawExchange, req, startServer, type TestServer, upload, waitFor } from './helpers.ts'

let t: TestServer
beforeEach(async () => {
  t = await startServer()
})
afterEach(async () => {
  await t.stop()
})

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const nothingStored = () => {
  expect(listFiles(t.layout.assets)).toEqual([])
  expect(readdirSync(t.layout.jobs.queued)).toEqual([])
}

describe('POST /dev-api/boards/<board>/assets', () => {
  it('stores the original, writes queued meta, enqueues one job and returns the meta', async () => {
    const body = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 251))
    const res = await upload(t.port, {
      body,
      type: 'image/png',
      name: 'C:\\Users\\me\\Résumé 2026 "final".png', // a browser never sends paths, but a client might
    })
    expect(res.status).toBe(201)
    const meta = res.json<AssetVersionMeta>()
    expect(isId('ast', meta.assetId)).toBe(true)
    expect(isId('ver', meta.versionId)).toBe(true)
    expect(meta).toMatchObject({
      schemaVersion: 1,
      boardId: 'board-a',
      name: 'Résumé 2026 "final".png',
      declaredMimeType: 'image/png',
      mimeType: 'image/png',
      kind: 'image',
      sizeBytes: body.length,
      sha256: sha256(body),
      uploadedBy: 'alice',
      status: 'queued',
      attempts: 0,
      error: null,
      derivatives: [],
    })

    const { assetId, versionId } = meta
    expect(readFileSync(originalPath(t.layout, assetId, versionId)).equals(body)).toBe(true)
    expect(JSON.parse(readFileSync(metaPath(t.layout, assetId, versionId), 'utf8'))).toEqual(meta)
    // exactly original + meta.json: the temp file was renamed, not copied
    expect(listFiles(t.layout.assets).sort()).toEqual(
      [`${assetId}/${versionId}/meta.json`, `${assetId}/${versionId}/original`].sort(),
    )
    const job = JSON.parse(
      readFileSync(join(t.layout.jobs.queued, `${versionId}.json`), 'utf8'),
    ) as PreviewJob
    expect(job).toMatchObject({
      assetId,
      versionId,
      boardId: 'board-a',
      profile: PREVIEW_PROFILE,
      attempt: 1,
    })
    expect(readdirSync(t.layout.jobs.queued)).toEqual([`${versionId}.json`])
  })

  it('classifies by type/extension and never trusts a declared type for the served mime', async () => {
    const svg = await upload(t.port, { type: 'image/svg+xml', name: 'logo.svg' })
    expect(svg.json()).toMatchObject({ kind: 'other', mimeType: 'application/octet-stream' })
    const byExt = await upload(t.port, { type: 'application/octet-stream', name: 'deck.PDF' })
    expect(byExt.json()).toMatchObject({ kind: 'pdf', mimeType: 'application/pdf' })
    const junkType = await upload(t.port, { type: 'text/html; <script>', name: 'clip.mp4' })
    expect(junkType.json()).toMatchObject({ kind: 'video', mimeType: 'video/mp4' })
    const empty = await upload(t.port, { body: Buffer.alloc(0), type: 'text/plain', name: 'empty.txt' })
    expect(empty.status).toBe(201)
    expect(empty.json()).toMatchObject({ sizeBytes: 0, sha256: sha256(Buffer.alloc(0)) })
  })

  it('411 without Content-Length (chunked body), nothing stored', async () => {
    const res = await req(t.port, {
      method: 'POST',
      path: '/dev-api/boards/board-a/assets?devUser=alice',
      headers: { 'Transfer-Encoding': 'chunked', 'Content-Type': 'image/png', 'X-File-Name': 'a.png' },
      body: [Buffer.from('abc'), Buffer.from('def')],
    })
    expect(res.status).toBe(411)
    expect(res.json()).toEqual({ error: { code: 'LENGTH_REQUIRED', message: expect.any(String) } })
    nothingStored()
  })

  it('413 on the declared size, before reading any body, for each kind limit', async () => {
    for (const [type, name, limit] of [
      ['image/png', 'a.png', LIMITS.maxBytes.image],
      ['application/zip', 'a.zip', LIMITS.maxBytes.other],
    ] as const) {
      // A keep-alive client that never sends the body: the server must answer from the headers
      // alone and hang up (rawExchange resolves on close), not wait to drain the declared bytes.
      const started = Date.now()
      const raw = await rawExchange(t.port, (s) =>
        s.write(
          'POST /dev-api/boards/board-a/assets?devUser=alice HTTP/1.1\r\nHost: x\r\n' +
            `Content-Type: ${type}\r\nX-File-Name: ${name}\r\nContent-Length: ${limit + 1}\r\n\r\n`,
        ),
      )
      expect(Date.now() - started).toBeLessThan(2_000)
      const [head = '', body = ''] = raw.split('\r\n\r\n')
      expect(head).toMatch(/^HTTP\/1\.1 413 /)
      expect(head).toMatch(/\r\nConnection: close\r\n/i)
      const err = JSON.parse(body).error
      expect(err.code).toBe('TOO_LARGE')
      expect(err.message).not.toMatch(/[\\/]/) // no paths in user-facing messages
    }
    // exactly at the limit is not rejected up front (it is accepted once the bytes arrive)
    const atLimit = await req(t.port, {
      method: 'POST',
      path: '/dev-api/boards/board-a/assets?devUser=alice',
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(LIMITS.maxBytes.image),
        'X-File-Name': 'a.png',
      },
      body: Buffer.alloc(LIMITS.maxBytes.image, 1),
    })
    expect(atLimit.status).toBe(201)
  })

  it('a client that sends more bytes than it declared can never store more than declared', async () => {
    // Content-Length lies: the extra bytes are not part of this request's body (Node's parser stops
    // at Content-Length and treats the rest as a malformed next request). The streaming cap in
    // receiveToFile is the second line of defense and is exercised directly in receive.test.ts.
    const declared = Buffer.from('0123456789')
    const extra = Buffer.alloc(4096, 0x41)
    await rawExchange(t.port, (s) => {
      s.write(
        'POST /dev-api/boards/board-a/assets?devUser=alice HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\n' +
          `X-File-Name: a.txt\r\nContent-Length: ${declared.length}\r\n\r\n`,
      )
      s.end(Buffer.concat([declared, extra]))
    })
    await t.server.close() // waits for the in-flight upload handler to finish or clean up
    const originals = listFiles(t.layout.assets).filter((f) => f.endsWith('/original'))
    expect(originals.length).toBeLessThanOrEqual(1)
    for (const f of originals) expect(readFileSync(join(t.layout.assets, f)).equals(declared)).toBe(true)
    for (const f of listFiles(t.layout.assets).filter((f) => f.endsWith('/meta.json'))) {
      expect(JSON.parse(readFileSync(join(t.layout.assets, f), 'utf8')).sizeBytes).toBe(declared.length)
    }
    expect(listFiles(t.layout.assets).some((f) => f.includes('.tmp'))).toBe(false)
  })

  it('an upload aborted mid-body leaves no original, no meta, no temp file and no job', async () => {
    const closed = rawExchange(t.port, (s) => {
      s.write(
        'POST /dev-api/boards/board-a/assets?devUser=alice HTTP/1.1\r\nHost: x\r\nContent-Type: image/png\r\n' +
          'X-File-Name: big.png\r\nContent-Length: 1000000\r\n\r\n',
      )
      s.write(Buffer.alloc(64 * 1024, 7))
      // abort only once the server has demonstrably started writing the partial file
      waitFor(() => listFiles(t.layout.assets).some((f) => f.includes('.upload-')), 5_000, 'partial file')
        .then(() => s.destroy())
        .catch(() => s.destroy())
    })
    await closed
    await waitFor(() => listFiles(t.layout.assets).length === 0 && readdirSync(t.layout.assets).length === 0)
    nothingStored()
    await waitFor(() => t.logs.some((l) => l.startsWith('POST /dev-api/boards/board-a/assets ')))
  })

  it('rejects bad board ids, identities and file names with JSON 4xx and stores nothing', async () => {
    for (const board of ['Board-A', 'ab', 'a%2Fb', '..', 'board_a%00']) {
      const res = await upload(t.port, { board })
      expect([400, 404]).toContain(res.status)
      if (res.status === 400) expect(res.json().error.code).toBe('INVALID_BOARD_ID')
    }
    expect((await upload(t.port, { board: 'Board-A' })).status).toBe(400)

    expect((await upload(t.port, { user: '' })).status).toBe(401)
    expect((await upload(t.port, { user: 'Alice' })).json().error.code).toBe('NOT_AUTHENTICATED')

    for (const bad of ['%E0%A4%A', '%', '%FF%FE', 'r\u00e9sum\u00e9.png' /* raw, not URI-encoded */]) {
      const res = await upload(t.port, { headers: { 'X-File-Name': bad } })
      expect(res.status).toBe(400)
      expect(res.json()).toEqual({ error: { code: 'INVALID_FILE_NAME', message: expect.any(String) } })
    }
    const noName = await req(t.port, {
      method: 'POST',
      path: '/dev-api/boards/board-a/assets?devUser=alice',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: Buffer.from('abc'),
    })
    expect(noName.status).toBe(400)
    nothingStored()
  })
})
