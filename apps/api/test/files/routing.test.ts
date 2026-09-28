import { newId } from '@draftroom/dev-assets'
import { afterEach, describe, expect, it } from 'vitest'
import { faultyStore, listFiles, nothingStored, req, startApp, type TestApp, upload } from './helpers.ts'

let t: TestApp | undefined
afterEach(async () => {
  await t?.stop()
  t = undefined
})

describe('routing', () => {
  it('405 with Allow for wrong methods on every file route, whatever the body', async () => {
    t = await startApp()
    const ast = newId('ast')
    const ver = newId('ver')
    const cases: Array<[string, string, string]> = [
      ['GET', '/api/boards/board-a/assets', 'POST'],
      ['HEAD', '/api/boards/board-a/assets', 'POST'],
      ['PUT', '/api/boards/board-a/assets', 'POST'],
      ['POST', `/api/boards/board-a/assets/${ast}/${ver}`, 'GET, HEAD'],
      ['DELETE', `/files/${ast}/${ver}/original?board=board-a`, 'GET, HEAD'],
      ['PATCH', `/files/${ast}/${ver}/original?board=board-a`, 'GET, HEAD'],
      ['POST', `/files/${ast}/${ver}/d/${newId('drv')}?board=board-a`, 'GET, HEAD'],
      ['OPTIONS', `/files/${ast}/${ver}/d/${newId('drv')}?board=board-a`, 'GET, HEAD'],
    ]
    for (const [method, path, allow] of cases) {
      const res = await req(t.port, { method, path, body: Buffer.alloc(0) })
      expect(res.status, `${method} ${path}`).toBe(405)
      expect(res.headers.allow).toBe(allow)
      if (method !== 'HEAD') {
        expect(res.json()).toEqual({ error: { code: 'METHOD_NOT_ALLOWED', message: expect.any(String) } })
      }
    }
    // decided from the request line: neither a body nor a malformed Content-Type changes the answer
    const withBody = await req(t.port, {
      method: 'PUT',
      path: '/api/boards/board-a/assets',
      headers: { 'Content-Type': 'garbage', 'Content-Length': '5' },
      body: Buffer.from('12345'),
    })
    expect(withBody.status).toBe(405)
    expect(t.auth.calls).toEqual([]) // a wrong method never reaches authorization
  })

  it('the plugin does not change the host app: its parsers, error handler and other routes', async () => {
    for (const direct of [false, true]) {
      t = await startApp({ direct })
      const echo = await req(t.port, {
        method: 'POST',
        path: '/host/echo',
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from('{"a":1}'),
      })
      expect(echo.status, `direct=${direct}`).toBe(200)
      expect(echo.json()).toEqual({ echoed: { a: 1 } })
      const boom = await req(t.port, { path: '/host/boom' })
      expect(boom.status).toBe(599) // the host's own error handler, not the file routes' one
      expect(boom.json()).toEqual({ host: true })
      // and the file routes work either way
      expect((await upload(t.port, { type: 'application/json', name: 'x.json' })).status).toBe(201)
      await t.stop()
      t = undefined
    }
  })

  it('a storage failure is a generic JSON 500 without paths, logged with the route pattern only', async () => {
    // The store refuses the write (a full disk, R2 down) and, like a real store, destroys the body.
    const failure = () =>
      Object.assign(new Error('EACCES: permission denied, open C:\\data\\blobs\\assets\\x'), {
        code: 'EACCES',
      })
    t = await startApp({ wrap: (inner) => faultyStore(inner, { put: failure }) })
    const res = await upload(t.port, { query: '?secret=token123', body: Buffer.alloc(200_000, 1) })
    expect(res.status).toBe(500)
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' },
    })
    expect(res.body.toString()).not.toMatch(/[\\/]|assets|EACCES/)
    expect(t.errors).toHaveLength(1)
    const logged = t.errors[0] as { route: string; err: { code: string } }
    expect(logged.route).toBe('/api/boards/:bid/assets')
    expect(logged.err.code).toBe('EACCES')
    expect(JSON.stringify(logged)).not.toContain('token123')
    await nothingStored(t)
  })

  it('a failing cleanup after a failed upload is logged, and the client still gets the real error', async () => {
    let refuse = false
    t = await startApp({
      wrap: (inner) =>
        faultyStore(inner, {
          put: () => (refuse ? new Error('R2 answered 503') : null),
          delete: () => new Error('R2 delete failed'),
        }),
    })
    refuse = true
    const res = await upload(t.port, { body: Buffer.alloc(1000, 1) })
    expect(res.status).toBe(500)
    const messages = t.errors.map((e) => JSON.stringify(e))
    expect(messages.some((m) => m.includes('R2 delete failed'))).toBe(true) // cleanup failure reported
    expect(messages.some((m) => m.includes('R2 answered 503'))).toBe(true) // and the cause
    expect((await t.db.one<{ n: number }>('SELECT count(*)::int AS n FROM asset_versions')).n).toBe(0)
    expect(listFiles(t.blobRoot)).toEqual([])
  })

  it('a read failure of the store is a 500 on the file routes; the meta route still answers', async () => {
    let failing = false
    t = await startApp({
      wrap: (inner) => faultyStore(inner, { get: () => (failing ? new Error('R2 unavailable') : null) }),
    })
    const m = (await upload(t.port, { body: Buffer.alloc(100, 2) })).json()
    failing = true
    const res = await req(t.port, { path: `/files/${m.assetId}/${m.versionId}/original?board=board-a` })
    expect(res.status).toBe(500)
    expect(res.json().error.code).toBe('INTERNAL')
    expect(
      (await req(t.port, { path: `/api/boards/board-a/assets/${m.assetId}/${m.versionId}` })).status,
    ).toBe(200)
  })
})
