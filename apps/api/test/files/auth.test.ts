import { type AssetVersionMeta, newId } from '@draftroom/dev-assets'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addDerivative,
  BOB,
  listFiles,
  nothingStored,
  parseRaw,
  type Res,
  rawExchange,
  req,
  startApp,
  type TestApp,
  upload,
  uploadHead,
  waitFor,
} from './helpers.ts'

let t: TestApp
beforeEach(async () => {
  t = await startApp()
})
afterEach(async () => {
  await t.stop()
})

/** Headers only, never a body: the answer must come from the headers alone, then a hang-up. */
async function headersOnlyUpload(head: string) {
  const started = Date.now()
  const raw = await rawExchange(t.port, (s) => s.write(head))
  return { ...parseRaw(raw), ms: Date.now() - started }
}

describe('upload authorization (edit)', () => {
  it('signed out: 401 from the headers alone, nothing written', async () => {
    t.auth.userId = null
    const r = await headersOnlyUpload(uploadHead({ length: 1_000_000 }))
    expect(r.status).toBe(401)
    expect(r.json).toEqual({ error: { code: 'NOT_AUTHENTICATED', message: expect.any(String) } })
    expect(r.headers.connection).toBe('close')
    expect(r.ms).toBeLessThan(2_000)
    expect(t.auth.calls.map((c) => [c.boardId, c.action])).toEqual([['board-a', 'edit']])
    await nothingStored(t)
  })

  it('viewer: 403 from the headers alone, nothing written', async () => {
    t.auth.roles = { 'board-a': 'viewer' }
    const r = await headersOnlyUpload(uploadHead({ length: 1_000_000 }))
    expect(r.status).toBe(403)
    expect(r.json).toEqual({ error: { code: 'FORBIDDEN', message: expect.any(String) } })
    expect(r.headers.connection).toBe('close')
    expect(r.ms).toBeLessThan(2_000)
    await nothingStored(t)
    // and a full upload with a body is refused the same way
    const full = await upload(t.port)
    expect(full.status).toBe(403)
    await nothingStored(t)
  })

  it('non-member: the same 404 as any missing resource, nothing written', async () => {
    t.auth.roles = { 'board-b': 'editor' }
    const r = await headersOnlyUpload(uploadHead({ board: 'board-a', length: 1_000_000 }))
    expect(r.status).toBe(404)
    expect(r.json).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } })
    expect(r.headers.connection).toBe('close')
    await nothingStored(t)
    // editing board-b does not let anyone write into board-a
    expect((await upload(t.port, { board: 'board-a' })).status).toBe(404)
    expect((await upload(t.port, { board: 'board-b' })).status).toBe(201)
  })

  it('is decided before Content-Length, name or size are looked at', async () => {
    // Unauthorized callers learn nothing from the other checks (411/400/413 would each reveal that
    // the board accepted them).
    t.auth.userId = null
    const noLength = await headersOnlyUpload(uploadHead({ length: null }))
    expect(noLength.status).toBe(401)
    t.auth.userId = BOB
    t.auth.roles = { 'board-a': 'viewer' }
    const tooBig = await headersOnlyUpload(uploadHead({ length: 1024 * 1024 * 1024 }))
    expect(tooBig.status).toBe(403)
    const badName = await upload(t.port, { headers: { 'X-File-Name': '%' } })
    expect(badName.status).toBe(403)
    await nothingStored(t)
  })

  it('runs before any body byte is read or any file is created', async () => {
    let release = () => {}
    t.auth.gate = new Promise<void>((r) => {
      release = r
    })
    const body = Buffer.from('the body arrives only after authorization was asked')
    let sock: import('node:net').Socket | undefined
    const exchange = rawExchange(t.port, (s) => {
      sock = s
      s.write(uploadHead({ type: 'text/plain', name: 'a.txt', length: body.length, close: true })) // headers only
    })
    await waitFor(() => t.auth.calls.length === 1, 5_000, 'authorize() call')
    // authorize() was asked while the client had sent no body at all
    expect(t.auth.calls[0]).toMatchObject({
      boardId: 'board-a',
      action: 'edit',
      bodyRead: false,
      blobsAtCall: [],
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(listFiles(t.blobRoot)).toEqual([]) // still waiting on authorize(): nothing touched
    release()
    sock?.write(body)
    const r = parseRaw(await exchange)
    expect(r.status).toBe(201)
    expect(r.json).toMatchObject({ uploadedBy: t.auth.userId, sizeBytes: body.length })
  })

  it('an authorize() failure is a generic 500 that writes nothing and leaks nothing', async () => {
    t.auth.failWith = new Error('connect ECONNREFUSED 127.0.0.1:5432 at C:\\secret\\db.ts')
    const r = await headersOnlyUpload(uploadHead({ length: 1000 }))
    expect(r.status).toBe(500)
    expect(r.json).toEqual({
      error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' },
    })
    expect(r.headers.connection).toBe('close')
    await nothingStored(t)
    expect(t.errors).toHaveLength(1)
    expect(t.errors[0]).toMatchObject({ route: '/api/boards/:bid/assets' })
  })

  it('attributes the upload to the authorized user only', async () => {
    t.auth.userId = BOB
    const res = await upload(t.port, { query: '?devUser=alice&uploadedBy=alice' })
    expect(res.status).toBe(201)
    expect(res.json().uploadedBy).toBe(BOB)
  })
})

describe('read authorization (view)', () => {
  let img: AssetVersionMeta
  let drvId: string

  beforeEach(async () => {
    img = (await upload(t.port, { board: 'board-a', name: 'a.png' })).json()
    drvId = (await addDerivative(t, img, { publish: true })).id
    t.auth.calls.length = 0
  })

  const routes = (board: string) => [
    `/api/boards/${board}/assets/${img.assetId}/${img.versionId}`,
    `/files/${img.assetId}/${img.versionId}/original?board=${board}`,
    `/files/${img.assetId}/${img.versionId}/d/${drvId}?board=${board}`,
  ]
  const missing = (board: string) => [
    `/api/boards/${board}/assets/${img.assetId}/${newId('ver')}`,
    `/files/${img.assetId}/${newId('ver')}/original?board=${board}`,
    `/files/${img.assetId}/${img.versionId}/d/${newId('drv')}?board=${board}`,
  ]
  const get = (path: string, method = 'GET') => req(t.port, { method, path })
  const comparable = (r: Res) => ({
    status: r.status,
    body: r.body.toString(),
    type: r.headers['content-type'],
  })

  it('a viewer can read meta, original and derivative; authorize() sees the URL board and "view"', async () => {
    t.auth.roles = { 'board-a': 'viewer' }
    for (const path of routes('board-a')) expect((await get(path)).status, path).toBe(200)
    expect(t.auth.calls.map((c) => [c.boardId, c.action])).toEqual([
      ['board-a', 'view'],
      ['board-a', 'view'],
      ['board-a', 'view'],
    ])
  })

  it('a non-member gets 404s byte-identical to a missing asset on every read route, GET and HEAD', async () => {
    t.auth.roles = { 'board-a': 'editor' }
    const absent = await Promise.all(missing('board-a').map((p) => get(p)))
    t.auth.roles = {}
    const denied = await Promise.all(routes('board-a').map((p) => get(p)))
    for (let i = 0; i < denied.length; i++) {
      const d = denied[i] as Res
      expect(d.status).toBe(404)
      expect(comparable(d)).toEqual(comparable(absent[i] as Res))
      expect(d.headers['cache-control']).toBe('no-store')
    }
    for (const path of routes('board-a')) expect((await get(path, 'HEAD')).status, path).toBe(404)
  })

  it('signed out: 401 on every read route, before anything about the asset is checked', async () => {
    t.auth.userId = null
    for (const path of [...routes('board-a'), ...missing('board-a')]) {
      const res = await get(path)
      expect(res.status, path).toBe(401)
      expect(res.json().error.code).toBe('NOT_AUTHENTICATED')
    }
  })

  it('access to one board never reaches another board`s assets', async () => {
    // bob can view board-b only; img lives on board-a
    t.auth.userId = BOB
    t.auth.roles = { 'board-b': 'viewer' }
    const viaOwnBoard = await Promise.all(routes('board-b').map((p) => get(p))) // authorized, wrong board
    const direct = await Promise.all(routes('board-a').map((p) => get(p))) // not authorized
    for (let i = 0; i < direct.length; i++) {
      expect((viaOwnBoard[i] as Res).status).toBe(404)
      expect(comparable(viaOwnBoard[i] as Res)).toEqual(comparable(direct[i] as Res))
    }
    expect(t.auth.calls.map((c) => c.boardId)).toEqual([
      'board-b',
      'board-b',
      'board-b',
      'board-a',
      'board-a',
      'board-a',
    ])
  })

  it('never asks authorize() about a malformed board id', async () => {
    for (const path of routes('Board-A')) expect((await get(path)).status, path).toBe(400)
    expect((await get(`/files/${img.assetId}/${img.versionId}/original`)).status).toBe(400)
    expect(t.auth.calls).toEqual([])
  })
})
