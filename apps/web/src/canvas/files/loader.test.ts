import { describe, expect, it } from 'vitest'
import {
  defaultRetryDelayMs,
  ImageLoader,
  type ImageLoaderOptions,
  parseFileKey,
  rasterMimeType,
} from './loader.ts'

const VER = (n: number) => `ver_${String(n).padStart(16, '0')}`

/** A loader on fake time, fake fetch and fake decode. */
function harness(opts: Partial<ImageLoaderOptions> & { fail?: Set<string>; contentType?: string } = {}) {
  let now = 0
  const timers: { at: number; fn: () => void }[] = []
  const added: { id: string; dataURL: string; mimeType: string }[] = []
  const pending: { url: string; resolve: (r: Response) => void }[] = []
  let urls = 0
  const revoked: string[] = []
  const loader = new ImageLoader({
    addFiles: (files) => {
      for (const f of files) added.push({ id: f.id, dataURL: f.dataURL, mimeType: f.mimeType })
    },
    resolveUrl: (ver, d) => `/files/ast_x/${ver}/d/${d}`,
    fetch: (url) =>
      new Promise<Response>((resolve) => {
        pending.push({ url, resolve })
      }),
    decode: async () => {},
    createObjectURL: () => `blob:test/${++urls}`,
    revokeObjectURL: (u) => revoked.push(u),
    scheduleFlush: (fn) => queueMicrotask(fn),
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number])
      if (i >= 0) timers.splice(i, 1)
    },
    ...opts,
  })
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const tick = async () => {
    for (let i = 0; i < 5; i++) await flush()
  }
  const respond = async (ok: boolean, n?: number) => {
    await tick()
    n ??= pending.length
    for (const p of pending.splice(0, n)) {
      const ver = /ver_\w+/.exec(p.url)?.[0] ?? ''
      const good = ok && !opts.fail?.has(ver)
      p.resolve(
        new Response(good ? new Uint8Array([1, 2, 3]) : 'no', {
          status: good ? 200 : 404,
          headers: { 'content-type': good ? (opts.contentType ?? 'image/webp') : 'text/plain' },
        }),
      )
    }
    for (let i = 0; i < 5; i++) await flush()
  }
  const advance = async (ms: number) => {
    now += ms
    for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (t.at <= now) t.fn()
      else timers.push(t)
    }
    await tick()
  }
  return { loader, added, pending, respond, advance, revoked, timers, tick }
}

describe('parseFileKey', () => {
  it('reads a version id and an optional derivative suffix', () => {
    expect(parseFileKey(VER(1))).toEqual({ key: VER(1), versionId: VER(1), derivative: 'thumb' })
    expect(parseFileKey(`${VER(1)}@display`)?.derivative).toBe('display')
    expect(parseFileKey(`${VER(1)}@original`)).toBeNull()
    expect(parseFileKey('9b3c0a…base64')).toBeNull()
    expect(parseFileKey(`${VER(1)}@thumb@x`)).toBeNull()
  })
})

describe('rasterMimeType', () => {
  it('accepts raster images only (never SVG: a blob: SVG breaks addFiles)', () => {
    expect(rasterMimeType('image/webp')).toBe('image/webp')
    expect(rasterMimeType('image/png; charset=binary')).toBe('image/png')
    expect(rasterMimeType('image/svg+xml')).toBeNull()
    expect(rasterMimeType('text/html')).toBeNull()
    expect(rasterMimeType(null)).toBeNull()
  })
})

describe('ImageLoader', () => {
  it('never runs more than 6 fetches at once, and fetches visible images first', async () => {
    const h = harness()
    const ids = Array.from({ length: 20 }, (_, i) => VER(i))
    h.loader.request(ids, new Set([VER(17), VER(18)]))
    await h.tick()
    expect(h.pending).toHaveLength(6)
    expect(h.pending.slice(0, 2).map((p) => /ver_\w+/.exec(p.url)?.[0])).toEqual([VER(17), VER(18)])
    await h.respond(true, 3)
    await h.tick()
    expect(h.pending).toHaveLength(6)
    for (let i = 0; i < 10; i++) await h.respond(true)
    expect(h.added).toHaveLength(20)
    expect(h.loader.stats.maxInFlight).toBe(6)
    expect(h.added.every((a) => a.dataURL.startsWith('blob:'))).toBe(true)
  })

  it('a failing file is never handed to the engine; it is retried at 1, 2, 4 s and loads when it works', async () => {
    const fail = new Set([VER(1)])
    const h = harness({ fail })
    h.loader.request([VER(1)])
    await h.respond(true)
    expect(h.added).toEqual([])
    expect(h.loader.state(VER(1))).toBe('retrying')
    await h.advance(999)
    expect(h.pending).toHaveLength(0)
    await h.advance(1)
    expect(h.pending).toHaveLength(1) // retry 1 after 1 s
    await h.respond(true)
    await h.advance(2000)
    expect(h.pending).toHaveLength(1) // retry 2 after 2 s
    fail.clear()
    await h.respond(true)
    expect(h.added.map((a) => a.id)).toEqual([VER(1)])
    expect(h.loader.state(VER(1))).toBe('loaded')
    expect(h.loader.stats).toMatchObject({ fetches: 3, failures: 2, retries: 2, loaded: 1 })
  })

  it('gives up after the retry window, still without touching the engine', async () => {
    const h = harness({ fail: new Set([VER(2)]), retryWindowMs: 10_000 })
    h.loader.request([VER(2)])
    for (let i = 0; i < 10; i++) {
      await h.respond(true)
      await h.advance(defaultRetryDelayMs(i + 1))
    }
    expect(h.loader.state(VER(2))).toBe('failed')
    expect(h.added).toEqual([])
    expect(h.loader.stats.gaveUp).toBe(1)
  })

  it('refuses a non-raster response and a URL that is not a same-origin path', async () => {
    const svg = harness({ contentType: 'image/svg+xml' })
    svg.loader.request([VER(3)])
    await svg.respond(true)
    expect(svg.added).toEqual([])
    const foreign = harness({ resolveUrl: () => 'https://cdn.example/x.webp' })
    foreign.loader.request([VER(4)])
    await foreign.respond(true)
    expect(foreign.pending).toHaveLength(0)
    expect(foreign.loader.stats.fetches).toBe(0)
    const protocolRelative = harness({ resolveUrl: () => '//cdn.example/x.webp' })
    protocolRelative.loader.request([VER(5)])
    await protocolRelative.tick()
    expect(protocolRelative.loader.stats.fetches).toBe(0)
  })

  it('a decode failure is a failed attempt (the blob URL is revoked, nothing is added)', async () => {
    const h = harness({ decode: async () => Promise.reject(new Error('bad image')) })
    h.loader.request([VER(6)])
    await h.respond(true)
    expect(h.added).toEqual([])
    expect(h.revoked).toEqual(['blob:test/1'])
    expect(h.loader.state(VER(6))).toBe('retrying')
  })

  it('ignores ids that are not Lobby version ids, and requests each key once', async () => {
    const h = harness()
    h.loader.syncScene([
      { type: 'image', fileId: VER(7) },
      { type: 'image', fileId: VER(7) },
      { type: 'image', fileId: 'abc' },
      { type: 'image', fileId: VER(8), isDeleted: true },
      { type: 'rectangle' },
    ])
    await h.tick()
    expect(h.pending.map((p) => p.url)).toEqual([`/files/ast_x/${VER(7)}/d/thumb`])
  })

  it('hands decoded files over in one addFiles call per flush (each call repaints the whole scene)', async () => {
    const calls: number[] = []
    const h = harness({
      addFiles: (files) => calls.push(files.length),
      scheduleFlush: () => {}, // flushed by hand below
    })
    h.loader.request([VER(11), VER(12), VER(13)])
    await h.respond(true)
    expect(calls).toEqual([])
    expect(h.loader.states().loaded).toBe(0)
    h.loader.flush()
    expect(calls).toEqual([3])
    expect(h.loader.states().loaded).toBe(3)
    expect(h.loader.stats.addFilesCalls).toBe(1)
  })

  it('dispose revokes the blob URLs and stops retries', async () => {
    const h = harness({ fail: new Set([VER(10)]) })
    h.loader.request([VER(9), VER(10)])
    await h.respond(true)
    h.loader.dispose()
    expect(h.revoked).toEqual(['blob:test/1'])
    await h.advance(5000)
    expect(h.pending).toHaveLength(0)
  })
})
