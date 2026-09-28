import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Rendered } from './scheduler.ts'
import { hasStoredThumbnail, KEEPALIVE_MAX_BYTES, sendLeftover, sendThumbnail } from './upload.ts'

const BOARD = 'b-abc123defg'
const image = (bytes = 100): Rendered => ({
  kind: 'image',
  blob: new Blob([new Uint8Array(bytes)], { type: 'image/webp' }),
  type: 'image/webp',
  width: 480,
  height: 300,
})
const uploaded = {
  thumbnail: {
    version: '0123456789abcdef01234567',
    mimeType: 'image/webp',
    width: 480,
    height: 300,
    bytes: 100,
    updatedAt: '2026-09-27T12:00:00.000Z',
  },
}

function fakeFetch(res: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (res instanceof Error) throw res
    return res.clone()
  }) as unknown as typeof fetch
  return { impl, calls }
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

afterEach(() => {
  vi.useRealTimers()
})

describe('sending thumbnails', () => {
  it('PUTs the image as a raw same-origin body with its type; keepalive only when it fits', async () => {
    const f = fakeFetch(json(200, uploaded))
    expect(await sendThumbnail(BOARD, image(), { keepalive: true }, f.impl)).toEqual({
      ok: true,
      version: uploaded.thumbnail.version,
    })
    const call = f.calls[0]
    expect(call?.url).toBe(`/api/boards/${BOARD}/thumbnail`)
    expect(call?.init).toMatchObject({
      method: 'PUT',
      headers: { 'content-type': 'image/webp' },
      credentials: 'same-origin',
      keepalive: true,
    })
    expect(call?.init.body).toBeInstanceOf(Blob)

    await sendThumbnail(BOARD, image(KEEPALIVE_MAX_BYTES + 1), { keepalive: true }, f.impl)
    expect(f.calls[1]?.init.keepalive).toBe(false)
    await sendThumbnail(BOARD, image(), { keepalive: false }, f.impl)
    expect(f.calls[2]?.init.keepalive).toBe(false)
  })

  it('an empty board DELETEs the stored thumbnail', async () => {
    const f = fakeFetch(new Response(null, { status: 204 }))
    expect(await sendThumbnail(BOARD, { kind: 'empty' }, { keepalive: false }, f.impl)).toEqual({
      ok: true,
      version: null,
    })
    expect(f.calls[0]?.init).toMatchObject({ method: 'DELETE', credentials: 'same-origin' })
    expect(f.calls[0]?.init.body).toBeUndefined()
  })

  it('maps refusals to what the scheduler does next', async () => {
    const cases: [Response | Error, unknown][] = [
      [json(429, {}, { 'retry-after': '17' }), { ok: false, retryAfterMs: 17_000 }],
      [json(429, {}), { ok: false, retryAfterMs: 30_000 }],
      [json(401, {}), { ok: false, stop: true }],
      [json(403, {}), { ok: false, stop: true }],
      [json(404, {}), { ok: false, stop: true }],
      [json(400, {}), { ok: false, drop: true }],
      [json(413, {}), { ok: false, drop: true }],
      [json(503, {}), { ok: false }],
      [new TypeError('Failed to fetch'), { ok: false }],
    ]
    for (const [res, expected] of cases) {
      const f = fakeFetch(res)
      expect(await sendThumbnail(BOARD, image(), { keepalive: false }, f.impl)).toEqual(expected)
    }
  })

  it('reads whether a thumbnail is stored; unknown when that fails', async () => {
    const signal = new AbortController().signal
    expect(await hasStoredThumbnail(BOARD, signal, fakeFetch(json(200, uploaded)).impl)).toBe(true)
    expect(await hasStoredThumbnail(BOARD, signal, fakeFetch(json(200, { thumbnail: null })).impl)).toBe(
      false,
    )
    expect(await hasStoredThumbnail(BOARD, signal, fakeFetch(json(404, {})).impl)).toBeUndefined()
    expect(await hasStoredThumbnail(BOARD, signal, fakeFetch(json(200, { nope: 1 })).impl)).toBeUndefined()
    expect(await hasStoredThumbnail(BOARD, signal, fakeFetch(new Error('offline')).impl)).toBeUndefined()
  })

  it('what a closed board left is sent once the window opens; a newer leftover replaces it', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    const send = vi.fn(async (_b: string, r: Rendered) => {
      sent.push(r.kind === 'image' ? String(r.blob.size) : 'empty')
      return { ok: true as const, version: null }
    })
    const now = () => 1_000
    sendLeftover(BOARD, { rendered: image(1), notBefore: 11_000 }, { now, send })
    sendLeftover(BOARD, { rendered: image(2), notBefore: 21_000 }, { now, send })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent).toEqual(['2'])
    sendLeftover('b-other12345', { rendered: { kind: 'empty' }, notBefore: 0 }, { now, send })
    expect(sent).toEqual(['2', 'empty'])
    expect(send).toHaveBeenLastCalledWith('b-other12345', { kind: 'empty' }, { keepalive: true })
  })
})
