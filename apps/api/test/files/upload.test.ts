import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { type AssetVersionMeta, isId, LIMITS, PREVIEW_PROFILE } from '@draftroom/dev-assets'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ALICE,
  assetRows,
  listFiles,
  nothingStored,
  parseRaw,
  rawExchange,
  req,
  sha256,
  startApp,
  storedBlobs,
  type TestApp,
  upload,
  uploadHead,
  WORKSPACE,
  waitFor,
} from './helpers.ts'

let t: TestApp
beforeEach(async () => {
  t = await startApp()
})
afterEach(async () => {
  await t.stop()
})

const originalFile = (m: { assetId: string; versionId: string }) =>
  join(t.blobRoot, 'assets', m.assetId, m.versionId, 'original')

describe('POST /api/boards/:bid/assets', () => {
  it('streams the original to the blob store, inserts the queued version + job and returns the meta', async () => {
    const body = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 251))
    const res = await upload(t.port, {
      body,
      type: 'image/png',
      name: 'C:\\Users\\me\\Résumé 2026 "final".png', // a browser never sends paths, but a client might
      query: '?devUser=mallory', // M0's dev identity is gone: never an input
    })
    expect(res.status).toBe(201)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
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
      uploadedBy: ALICE, // the authorized user, from authorize()
      status: 'queued',
      attempts: 0,
      error: null,
      probe: {
        width: null,
        height: null,
        pageCount: null,
        durationMs: null,
        videoCodec: null,
        audioCodec: null,
      },
      derivatives: [],
    })
    // The same JSON (keys and order) as meta.json had: the web client did not change.
    expect(Object.keys(meta)).toEqual([
      'schemaVersion',
      'assetId',
      'versionId',
      'boardId',
      'name',
      'declaredMimeType',
      'mimeType',
      'kind',
      'sizeBytes',
      'sha256',
      'uploadedBy',
      'createdAt',
      'updatedAt',
      'status',
      'attempts',
      'error',
      'probe',
      'derivatives',
    ])
    expect(new Date(meta.createdAt).toISOString()).toBe(meta.createdAt)
    expect(t.auth.calls.map((c) => [c.boardId, c.action])).toEqual([['board-a', 'edit']])

    // exactly one stored object, the original, byte-for-byte (no temp file left behind)
    expect(storedBlobs(t)).toEqual([`assets/${meta.assetId}/${meta.versionId}/original`])
    expect(readFileSync(originalFile(meta)).equals(body)).toBe(true)
    // rows: the version (in the board's workspace) and its queued job, nothing else
    const v = await t.db.one<Record<string, unknown>>(
      'SELECT workspace_id, board_id, status, attempts, size_bytes::float8 AS size FROM asset_versions WHERE id = $1',
      [meta.versionId],
    )
    expect(v).toEqual({
      workspace_id: WORKSPACE,
      board_id: 'board-a',
      status: 'queued',
      attempts: 0,
      size: body.length,
    })
    const job = await t.db.one<Record<string, unknown>>(
      'SELECT profile, status, attempts, lease_owner FROM preview_jobs WHERE version_id = $1',
      [meta.versionId],
    )
    expect(job).toEqual({ profile: PREVIEW_PROFILE, status: 'queued', attempts: 0, lease_owner: null })
    expect(await assetRows(t.db)).toEqual({ versions: 1, jobs: 1, derivatives: 0 })
    // and the meta route answers the very same JSON
    const again = await req(t.port, { path: `/api/boards/board-a/assets/${meta.assetId}/${meta.versionId}` })
    expect(again.json()).toEqual(meta)
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
    expect(readFileSync(originalFile(empty.json())).length).toBe(0)
    const untyped = await req(t.port, {
      method: 'POST',
      path: '/api/boards/board-a/assets',
      headers: { 'Content-Length': '3', 'X-File-Name': 'notes' },
      body: Buffer.from('abc'),
    })
    expect(untyped.status).toBe(201)
    expect(untyped.json()).toMatchObject({ declaredMimeType: 'application/octet-stream', kind: 'other' })
  })

  it('stores bodies Fastify or the host app would parse byte-for-byte, beyond the 1 MiB bodyLimit', async () => {
    // Fastify's built-in JSON/text parsers and the host's buffering octet-stream parser must never
    // see an upload: the stream reaches the handler unread and is stored as sent.
    const cases: Array<[string, string, Buffer]> = [
      ['application/json', 'broken.json', Buffer.from('{"not": json at all')],
      ['text/plain; charset=utf-8', 'big.txt', Buffer.alloc(3 * 1024 * 1024 + 7, 0x61)],
      ['application/octet-stream', 'blob.bin', Buffer.alloc(2 * 1024 * 1024, 0xfe)],
      ['multipart/form-data; boundary=x', 'form.dat', Buffer.from('--x\r\n\r\n--x--')],
    ]
    for (const [type, name, body] of cases) {
      const res = await upload(t.port, { type, name, body })
      expect(res.status, type).toBe(201)
      const m = res.json<AssetVersionMeta>()
      expect(m.sizeBytes, type).toBe(body.length)
      expect(m.sha256, type).toBe(sha256(body))
      expect(readFileSync(originalFile(m)).equals(body), type).toBe(true)
    }
  })

  it('411 without Content-Length (chunked body), nothing stored', async () => {
    const res = await req(t.port, {
      method: 'POST',
      path: '/api/boards/board-a/assets',
      headers: { 'Transfer-Encoding': 'chunked', 'Content-Type': 'image/png', 'X-File-Name': 'a.png' },
      body: [Buffer.from('abc'), Buffer.from('def')],
    })
    expect(res.status).toBe(411)
    expect(res.json()).toEqual({ error: { code: 'LENGTH_REQUIRED', message: expect.any(String) } })
    await nothingStored(t)
  })

  it('413 on the declared size, before reading any body, for each kind limit', async () => {
    for (const [type, name, limit] of [
      ['image/png', 'a.png', LIMITS.maxBytes.image],
      ['application/zip', 'a.zip', LIMITS.maxBytes.other],
    ] as const) {
      // A keep-alive client that never sends the body: the server must answer from the headers
      // alone and hang up (rawExchange resolves on close), not wait to drain the declared bytes.
      const started = Date.now()
      const raw = await rawExchange(t.port, (s) => s.write(uploadHead({ type, name, length: limit + 1 })))
      expect(Date.now() - started).toBeLessThan(2_000)
      const r = parseRaw(raw)
      expect(r.status).toBe(413)
      expect(r.headers.connection).toBe('close')
      expect(r.json.error.code).toBe('TOO_LARGE')
      expect(r.json.error.message).not.toMatch(/[\\/]/) // no paths in user-facing messages
    }
    await nothingStored(t)
    // exactly at the limit is not rejected up front (it is accepted once the bytes arrive), and the
    // 25 MiB body is far beyond Fastify's default 1 MiB bodyLimit
    const atLimit = await upload(t.port, { body: Buffer.alloc(LIMITS.maxBytes.image, 1), name: 'a.png' })
    expect(atLimit.status).toBe(201)
    expect(atLimit.json().sizeBytes).toBe(LIMITS.maxBytes.image)
  })

  it('the streaming cap stops a body that outgrows its Content-Length and removes the partial blob', async () => {
    // Node's HTTP parser never delivers more than Content-Length over a socket, so this cap is the
    // second line of defense; inject() can exceed it. The cap destroys the request stream (over a
    // socket that drops the connection, as in M0), which light-my-request reports as the error.
    const injected = t.app.inject({
      method: 'POST',
      url: '/api/boards/board-a/assets',
      headers: { 'content-type': 'text/plain', 'content-length': '10', 'x-file-name': 'a.txt' },
      payload: Readable.from([Buffer.alloc(8), Buffer.alloc(64 * 1024, 0x41)]),
    })
    await expect(injected).rejects.toMatchObject({ reason: 'TOO_LARGE' })
    await t.close() // waits for the upload handler's cleanup
    await nothingStored(t)
  })

  it('a body that ends before its Content-Length is a 400 and leaves nothing', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/boards/board-a/assets',
      headers: { 'content-type': 'text/plain', 'content-length': '100', 'x-file-name': 'a.txt' },
      payload: Readable.from([Buffer.alloc(10, 0x41)]),
    })
    expect(res.statusCode).toBe(400)
    expect(res.headers.connection).toBe('close')
    expect(res.json()).toEqual({ error: { code: 'UPLOAD_INCOMPLETE', message: expect.any(String) } })
    await nothingStored(t)
  })

  it('a client that sends more bytes than it declared can never store more than declared', async () => {
    // Content-Length lies: the extra bytes are not part of this request's body (Node's parser stops
    // at Content-Length and treats the rest as a malformed next request).
    const declared = Buffer.from('0123456789')
    const extra = Buffer.alloc(4096, 0x41)
    await rawExchange(t.port, (s) => {
      s.write(uploadHead({ type: 'text/plain', name: 'a.txt', length: declared.length }))
      s.end(Buffer.concat([declared, extra]))
    })
    await t.close() // waits for the in-flight upload handler to finish or clean up
    const originals = storedBlobs(t).filter((f) => f.endsWith('/original'))
    expect(originals.length).toBeLessThanOrEqual(1)
    for (const f of originals) expect(readFileSync(join(t.blobRoot, f)).equals(declared)).toBe(true)
    const rows = await t.db.query<{ size: number }>('SELECT size_bytes::float8 AS size FROM asset_versions')
    expect(rows.rows.length).toBe(originals.length)
    for (const r of rows.rows) expect(r.size).toBe(declared.length)
    expect(listFiles(t.blobRoot).some((f) => f.includes('~'))).toBe(false) // no temp files
  })

  it('an upload aborted mid-body leaves no blob, no temp file and no rows', async () => {
    const closed = rawExchange(t.port, (s) => {
      s.write(uploadHead({ name: 'big.png', length: 1_000_000 }))
      s.write(Buffer.alloc(64 * 1024, 7))
      // abort only once the server has demonstrably started streaming into storage: the body is
      // written as it arrives, not buffered in memory first
      waitFor(() => listFiles(t.blobRoot).length > 0, 5_000, 'partial blob')
        .then(() => s.destroy())
        .catch(() => s.destroy())
    })
    await closed
    await waitFor(() => listFiles(t.blobRoot).length === 0, 5_000, 'cleanup')
    await t.close()
    await nothingStored(t)
  })

  it('rejects bad board ids and file names with JSON 4xx and stores nothing', async () => {
    for (const board of ['Board-A', 'ab', 'a%2Fb', '..', 'board_a%00']) {
      const res = await upload(t.port, { board })
      expect([400, 404], board).toContain(res.status)
      if (res.status === 400) expect(res.json().error.code).toBe('INVALID_BOARD_ID')
    }
    expect((await upload(t.port, { board: 'Board-A' })).status).toBe(400)
    // a malformed board id is refused before authorization is even asked
    expect(t.auth.calls).toEqual([])

    for (const bad of ['%E0%A4%A', '%', '%FF%FE', 'r\u00e9sum\u00e9.png' /* raw, not URI-encoded */]) {
      const res = await upload(t.port, { headers: { 'X-File-Name': bad } })
      expect(res.status).toBe(400)
      expect(res.json()).toEqual({ error: { code: 'INVALID_FILE_NAME', message: expect.any(String) } })
    }
    const noName = await req(t.port, {
      method: 'POST',
      path: '/api/boards/board-a/assets',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: Buffer.from('abc'),
    })
    expect(noName.status).toBe(400)
    expect(noName.json().error.code).toBe('INVALID_FILE_NAME')
    await nothingStored(t)
  })

  it('a syntactically invalid Content-Type is a JSON 415 from Fastify (M0 read it as octet-stream)', async () => {
    // Fastify 5 validates the header before any parser runs. Browsers always send a valid type.
    for (const type of ['garbage', 'image/png extra']) {
      const res = await upload(t.port, { type, name: 'clip.mp4' })
      expect(res.status, type).toBe(415)
      expect(res.json()).toEqual({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: expect.any(String) } })
    }
    await nothingStored(t)
  })

  it('a row insert failure (the board is gone) deletes the stored blob: no orphan bytes, no rows', async () => {
    // authorize() still says yes, but the board row was deleted meanwhile: the FK refuses the version.
    t.auth.roles['board-zz'] = 'editor'
    const res = await upload(t.port, { board: 'board-zz', body: Buffer.alloc(5000, 3) })
    expect(res.status).toBe(500)
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' },
    })
    await nothingStored(t)
  })

  it('close() aborts an in-flight upload, removes its partial blob and frees the port', async () => {
    const pending = rawExchange(t.port, (s) => {
      s.write(uploadHead({ name: 'a.png', length: 100_000 }))
      s.write(Buffer.alloc(1000))
    })
    await waitFor(() => listFiles(t.blobRoot).length > 0, 5_000, 'partial blob')
    const started = Date.now()
    await t.close()
    expect(Date.now() - started).toBeLessThan(3_000) // did not wait for the client to finish
    await pending // the server hung up on the half-sent upload
    await nothingStored(t) // close() waited for the cleanup
    const free = await new Promise<boolean>((resolve) => {
      const s = createServer()
      s.once('error', () => resolve(false))
      s.listen(t.port, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    expect(free).toBe(true)
  })
})
