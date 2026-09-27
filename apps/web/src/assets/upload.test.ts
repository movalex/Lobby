import { describe, expect, it, vi } from 'vitest'
import { makeMeta, TEST_BOARD } from './test-fixtures.ts'
import { UploadError, uploadFile } from './upload.ts'

const file = (name: string, type: string) => new File([new Uint8Array([1, 2, 3])], name, { type })

describe('uploadFile', () => {
  it('POSTs the raw bytes with the declared type and an encoded, path-free display name', async () => {
    const meta = makeMeta()
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json(meta, { status: 201 }),
    )
    const f = file('C:\\Users\\me\\Q3 plan (final) é.pdf', 'application/pdf')
    const out = await uploadFile({
      boardId: TEST_BOARD,
      file: f,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(out).toEqual(meta)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    // Identity comes from the session cookie; no user id travels in the URL any more.
    expect(url).toBe(`/api/boards/${TEST_BOARD}/assets`)
    expect(init?.credentials).toBe('same-origin')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(f)
    const headers = init?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/pdf')
    expect(headers['X-File-Name']).toBe(encodeURIComponent('Q3 plan (final) é.pdf'))
    expect(headers['X-File-Name']).toMatch(/^[\x21-\x7e]+$/) // header-safe ASCII
  })

  it('falls back to application/octet-stream when the browser has no type', async () => {
    const fetchImpl = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      Response.json(makeMeta(), { status: 201 }),
    )
    await uploadFile({
      boardId: TEST_BOARD,
      file: file('notes', ''),
      fetchImpl: fetchImpl as never,
    })
    const headers = (fetchImpl.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers['Content-Type']).toBe('application/octet-stream')
  })

  it("surfaces the server's user-safe message and code", async () => {
    const fetchImpl = async () =>
      Response.json(
        { error: { code: 'TOO_LARGE', message: 'Videos can be at most 500 MB.' } },
        { status: 413 },
      )
    const err = await uploadFile({
      boardId: TEST_BOARD,
      file: file('x.mp4', 'video/mp4'),
      fetchImpl,
    })
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UploadError)
    expect(err).toMatchObject({ code: 'TOO_LARGE', status: 413, message: 'Videos can be at most 500 MB.' })
  })

  it('uses a generic message for unexpected bodies, network failures and malformed responses', async () => {
    const opts = { boardId: TEST_BOARD, file: file('x.pdf', 'application/pdf') }
    const html = async () => new Response('<html>proxy error at /srv/data/secret</html>', { status: 502 })
    await expect(uploadFile({ ...opts, fetchImpl: html })).rejects.toMatchObject({
      message: 'Upload failed.',
    })
    const down = async () => {
      throw new TypeError('Failed to fetch')
    }
    await expect(uploadFile({ ...opts, fetchImpl: down })).rejects.toMatchObject({ code: 'NETWORK' })
    const weird = async () => Response.json({ assetId: 'https://x', versionId: 'y' }, { status: 201 })
    await expect(uploadFile({ ...opts, fetchImpl: weird })).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  })

  it('rethrows an abort as-is so callers can tell cancellation from failure', async () => {
    const ctrl = new AbortController()
    const fetchImpl = async () => {
      ctrl.abort()
      throw new DOMException('aborted', 'AbortError')
    }
    const err = await uploadFile({
      boardId: TEST_BOARD,
      file: file('x.pdf', 'application/pdf'),
      signal: ctrl.signal,
      fetchImpl,
    }).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(UploadError)
    expect((err as DOMException).name).toBe('AbortError')
  })
})
