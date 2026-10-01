// Spike B (O5): the loader's §2.10.3 rules (the 100 ms window, the SVG rule, PDF page keys, revoking),
// `resolveUrl` with asset, derivative and board ids, and derivatives by zoom. Node, fake time.
import type { AssetVersionMeta, DerivativeRecord } from '@draftroom/dev-assets/shared'
import { describe, expect, it } from 'vitest'
import { DerivativeUpgrades } from './derivatives.ts'
import {
  blobToDataUrl,
  DEFAULT_BATCH_WINDOW_MS,
  ImageLoader,
  type ImageLoaderOptions,
  parseFileKey,
  wireFileId,
  withDerivative,
} from './loader.ts'
import { type FileMetaSource, FileUrlResolver, pickFor } from './resolve.ts'

const VER = (n: number) => `ver_${String(n).padStart(16, '0')}`
const AST = (n: number) => `ast_${String(n).padStart(16, '0')}`
const DRV = (n: number) => `drv_${String(n).padStart(16, '0')}`
const BOARD = 'b-spikefiles'

/** The loader on fake time, fetch and decode, WITHOUT scheduleFlush: §2.10.3's window applies. */
function harness(opts: Partial<ImageLoaderOptions> & { contentType?: (url: string) => string } = {}) {
  let now = 0
  const timers: { at: number; fn: () => void }[] = []
  const calls: { id: string; dataURL: string; mimeType: string }[][] = []
  const pending: { url: string; resolve: (r: Response) => void }[] = []
  let urls = 0
  const revoked: string[] = []
  const loader = new ImageLoader({
    addFiles: (files) =>
      calls.push(files.map((f) => ({ id: f.id, dataURL: f.dataURL, mimeType: f.mimeType }))),
    resolveUrl: (ver, d, file) => `/files/ast_x/${ver}/d/${d}${file.page ? `?page=${file.page}` : ''}`,
    fetch: (url) => new Promise<Response>((resolve) => void pending.push({ url, resolve })),
    decode: async () => {},
    createObjectURL: () => `blob:test/${++urls}`,
    revokeObjectURL: (u) => revoked.push(u),
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
  const tick = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
  }
  const respond = async (match?: (url: string) => boolean) => {
    await tick()
    for (const p of pending.filter((x) => !match || match(x.url))) {
      pending.splice(pending.indexOf(p), 1)
      p.resolve(
        new Response(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
          status: 200,
          headers: { 'content-type': opts.contentType?.(p.url) ?? 'image/webp' },
        }),
      )
    }
    await tick()
  }
  const advance = async (ms: number) => {
    now += ms
    for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (t.at <= now) t.fn()
      else timers.push(t)
    }
    await tick()
  }
  return { loader, calls, pending, respond, advance, revoked, timers, tick }
}

describe('file keys: PDF pages and local derivatives (E9)', () => {
  it('parses ver_X.p<n> with or without a derivative; strips and sets the local suffix', () => {
    expect(parseFileKey(`${VER(1)}.p3`)).toEqual({
      key: `${VER(1)}.p3`,
      versionId: VER(1),
      derivative: 'thumb',
      page: 3,
    })
    expect(parseFileKey(`${VER(1)}.p12@display`)?.page).toBe(12)
    expect(parseFileKey(`${VER(1)}.p0`)).toBeNull()
    expect(parseFileKey(`${VER(1)}.p10000`)).toBeNull()
    expect(wireFileId(`${VER(1)}.p2@display`)).toBe(`${VER(1)}.p2`)
    expect(wireFileId(`${VER(1)}@thumb`)).toBe(VER(1))
    expect(wireFileId('data:image/png;base64,xx')).toBeNull()
    expect(withDerivative(VER(1), 'display')).toBe(`${VER(1)}@display`)
    expect(withDerivative(`${VER(1)}.p2@thumb`, 'display')).toBe(`${VER(1)}.p2@display`)
  })

  it('hands a page key to resolveUrl', async () => {
    const h = harness()
    h.loader.request([`${VER(2)}.p4`])
    await h.tick()
    expect(h.pending.map((p) => p.url)).toEqual([`/files/ast_x/${VER(2)}/d/thumb?page=4`])
  })
})

describe('batching (§2.10.3): one addFiles per 100 ms window, or earlier once every visible image is ready', () => {
  it('collects decoded files for up to 100 ms', async () => {
    const h = harness()
    h.loader.request([VER(1), VER(2), VER(3)])
    await h.respond((u) => u.includes(VER(1)))
    await h.advance(40)
    await h.respond((u) => u.includes(VER(2)))
    expect(h.calls).toEqual([])
    await h.advance(DEFAULT_BATCH_WINDOW_MS - 40)
    expect(h.calls.map((c) => c.map((f) => f.id))).toEqual([[VER(1), VER(2)]])
    await h.respond()
    await h.advance(DEFAULT_BATCH_WINDOW_MS)
    expect(h.calls.map((c) => c.map((f) => f.id))).toEqual([[VER(1), VER(2)], [VER(3)]])
    expect(h.loader.stats.addFilesCalls).toBe(2)
    expect(h.loader.states().loaded).toBe(3)
  })

  it('flushes at once when the last visible image decodes, without waiting for the rest', async () => {
    const h = harness()
    h.loader.request([VER(1), VER(2), VER(3), VER(4)], new Set([VER(1), VER(2)]))
    await h.respond((u) => u.includes(VER(3)))
    await h.respond((u) => u.includes(VER(1)))
    expect(h.calls).toEqual([])
    await h.respond((u) => u.includes(VER(2)))
    expect(h.calls.map((c) => c.map((f) => f.id).sort())).toEqual([[VER(1), VER(2), VER(3)].sort()])
    expect(h.loader.stats.earlyFlushes).toBe(1)
    await h.respond()
    expect(h.calls).toHaveLength(1)
    await h.advance(DEFAULT_BATCH_WINDOW_MS)
    expect(h.calls.map((c) => c.map((f) => f.id))).toEqual([expect.any(Array), [VER(4)]])
  })

  it("a visible image that gave up does not hold the others' batch", async () => {
    const h = harness({ retryWindowMs: 0 })
    h.loader.request([VER(1), VER(2)], new Set([VER(1), VER(2)]))
    await h.tick()
    // VER(1) fails (404) and gives up at once (retry window 0); VER(2) decodes: flushed early.
    const p1 = h.pending.find((p) => p.url.includes(VER(1)))
    h.pending.splice(h.pending.indexOf(p1 as (typeof h.pending)[number]), 1)
    p1?.resolve(new Response('no', { status: 404 }))
    await h.tick()
    expect(h.loader.state(VER(1))).toBe('failed')
    await h.respond()
    expect(h.calls.map((c) => c.map((f) => f.id))).toEqual([[VER(2)]])
  })
})

describe('the SVG rule (§2.10.3): never a blob: URL', () => {
  it('an SVG response is handed over as a runtime-only data: URL; raster stays blob:', async () => {
    const h = harness({ contentType: (u) => (u.includes(VER(1)) ? 'image/svg+xml' : 'image/png') })
    h.loader.request([VER(1), VER(2)])
    await h.respond()
    await h.advance(DEFAULT_BATCH_WINDOW_MS)
    const files = h.calls.flat()
    const svg = files.find((f) => f.id === VER(1))
    const png = files.find((f) => f.id === VER(2))
    expect(svg?.mimeType).toBe('image/svg+xml')
    expect(svg?.dataURL.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(atob(svg?.dataURL.split(',')[1] ?? '')).toContain('<svg')
    expect(png?.dataURL.startsWith('blob:')).toBe(true)
    expect(h.loader.stats.svgDataUrls).toBe(1)
    // nothing to revoke for the data: URL
    h.loader.dispose()
    expect(h.revoked).toEqual([png?.dataURL])
  })

  it('blobToDataUrl encodes large blobs in chunks', async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251)
    const url = await blobToDataUrl(new Blob([bytes]), 'image/png')
    const back = Uint8Array.from(atob(url.slice('data:image/png;base64,'.length)), (c) => c.charCodeAt(0))
    expect(back).toEqual(bytes)
  })
})

describe('revoking (§2.10.3): only when no scene element and no export uses the key', () => {
  it('retainOnly revokes unused keys; a hold keeps one until released', async () => {
    const h = harness()
    h.loader.request([VER(1), VER(2), VER(3)])
    await h.respond()
    await h.advance(DEFAULT_BATCH_WINDOW_MS)
    const url2 = h.loader.urlOf(VER(2))
    const url3 = h.loader.urlOf(VER(3))
    const release = h.loader.hold(VER(3))
    h.loader.retainOnly(new Set([VER(1)]))
    expect(h.revoked).toEqual([url2])
    expect(h.loader.state(VER(2))).toBeUndefined()
    expect(h.loader.urlOf(VER(3))).toBe(url3)
    release()
    h.loader.retainOnly(new Set([VER(1)]))
    expect(h.revoked).toEqual([url2, url3])
    expect(h.loader.stats.revokedUnused).toBe(2)
    // a key the scene uses again is loaded again
    h.loader.request([VER(2)])
    await h.tick()
    expect(h.pending).toHaveLength(1)
  })
})

// ---- resolveUrl ------------------------------------------------------------------------------------------

const derivative = (n: number, extra: Partial<DerivativeRecord>): DerivativeRecord => ({
  id: DRV(n),
  role: 'thumb',
  page: null,
  width: 512,
  height: 384,
  mimeType: 'image/webp',
  bytes: 100,
  file: `${n}.webp`,
  ...extra,
})
const meta = (extra: Partial<AssetVersionMeta>): AssetVersionMeta =>
  ({
    schemaVersion: 1,
    assetId: AST(1),
    versionId: VER(1),
    boardId: BOARD,
    name: 'x',
    declaredMimeType: 'image/png',
    mimeType: 'image/png',
    kind: 'image',
    sizeBytes: 1,
    sha256: 'a'.repeat(64),
    uploadedBy: 'usr_x',
    createdAt: '',
    updatedAt: '',
    status: 'ready',
    attempts: 1,
    error: null,
    probe: {
      width: 4000,
      height: 3000,
      pageCount: null,
      durationMs: null,
      videoCodec: null,
      audioCodec: null,
    },
    derivatives: [],
    ...extra,
  }) as AssetVersionMeta

describe('pickFor: the derivative each file key loads', () => {
  const thumb = derivative(1, { role: 'thumb' })
  const display = derivative(2, { role: 'display', width: 2048, height: 1536 })

  it('images: thumb or display; never the original of a raster image', () => {
    const m = meta({ derivatives: [thumb, display] })
    expect(pickFor(m, { derivative: 'thumb', page: null })).toEqual({ kind: 'derivative', derivative: thumb })
    expect(pickFor(m, { derivative: 'display', page: null })).toEqual({
      kind: 'derivative',
      derivative: display,
    })
    expect(pickFor(meta({ derivatives: [thumb] }), { derivative: 'display', page: null })).toEqual({
      kind: 'derivative',
      derivative: thumb,
    })
    expect(pickFor(meta({ derivatives: [] }), { derivative: 'thumb', page: null })).toBeNull()
    expect(
      pickFor(meta({ derivatives: [], status: 'processing' }), { derivative: 'thumb', page: null }),
    ).toBeNull()
    // a derivative id that is not an id is never put in a URL
    expect(
      pickFor(meta({ derivatives: [{ ...thumb, id: '../x' }] }), { derivative: 'thumb', page: null }),
    ).toBeNull()
  })

  it('SVG: the raster derivative; with none (and done processing), the original (as data:)', () => {
    const svg = { mimeType: 'image/svg+xml', declaredMimeType: 'image/svg+xml' }
    expect(pickFor(meta({ ...svg, derivatives: [thumb] }), { derivative: 'thumb', page: null })?.kind).toBe(
      'derivative',
    )
    expect(pickFor(meta({ ...svg, derivatives: [] }), { derivative: 'thumb', page: null })).toEqual({
      kind: 'original',
    })
    expect(
      pickFor(meta({ ...svg, derivatives: [], status: 'processing' }), { derivative: 'thumb', page: null }),
    ).toBeNull()
  })

  it('PDF: a placed page loads that page; a card loads its cover; video cards their poster', () => {
    const pdf = meta({
      kind: 'pdf',
      mimeType: 'application/pdf',
      derivatives: [
        derivative(1, { role: 'thumb', page: 1, width: 400, height: 520 }),
        derivative(2, { role: 'page', page: 1, width: 1600, height: 2080 }),
        derivative(3, { role: 'page', page: 2, width: 1600, height: 2080 }),
      ],
    })
    expect(pickFor(pdf, { derivative: 'thumb', page: 2 })).toMatchObject({ derivative: { id: DRV(3) } })
    expect(pickFor(pdf, { derivative: 'thumb', page: 1 })).toMatchObject({ derivative: { id: DRV(1) } }) // 520 px >= 512
    expect(pickFor(pdf, { derivative: 'display', page: 1 })).toMatchObject({ derivative: { id: DRV(2) } })
    expect(pickFor(pdf, { derivative: 'thumb', page: 9 })).toBeNull()
    expect(pickFor(pdf, { derivative: 'thumb', page: null })).toMatchObject({ derivative: { id: DRV(1) } })
    expect(pickFor(meta({ derivatives: [thumb] }), { derivative: 'thumb', page: 1 })).toBeNull() // not a PDF
    const video = meta({
      kind: 'video',
      mimeType: 'video/mp4',
      derivatives: [derivative(4, { role: 'poster' })],
    })
    expect(pickFor(video, { derivative: 'thumb', page: null })).toMatchObject({ derivative: { id: DRV(4) } })
  })
})

describe('FileUrlResolver: asset, derivative and board ids', () => {
  it('learns version → asset from customData.lobby.file and builds the real routes', async () => {
    const asked: string[] = []
    const source: FileMetaSource = {
      load: async (b, a, v) => {
        asked.push(`${b}/${a}/${v}`)
        return {
          meta: meta({ assetId: a, versionId: v, derivatives: [derivative(7, {})] }),
          missing: false,
          error: false,
        }
      },
    }
    const r = new FileUrlResolver({ boardId: BOARD, meta: source })
    const key = parseFileKey(VER(1))
    if (!key) throw new Error('key')
    expect(await r.resolveUrl(VER(1), 'thumb', key)).toBeNull() // asset not known yet: retried later
    r.learn([
      {
        type: 'image',
        fileId: VER(1),
        customData: { lobby: { file: { assetId: AST(1), versionId: VER(1) } } },
      },
      {
        type: 'image',
        fileId: VER(2),
        customData: { lobby: { file: { assetId: '../evil', versionId: VER(2) } } },
      },
      { type: 'rectangle' },
    ])
    expect(r.assetOf(VER(2))).toBeNull()
    expect(await r.resolveUrl(VER(1), 'thumb', key)).toBe(
      `/files/${AST(1)}/${VER(1)}/d/${DRV(7)}?board=${BOARD}`,
    )
    expect(asked).toEqual([`${BOARD}/${AST(1)}/${VER(1)}`])
    const svgSource: FileMetaSource = {
      load: async () => ({ meta: meta({ mimeType: 'image/svg+xml' }), missing: false, error: false }),
    }
    const s = new FileUrlResolver({ boardId: BOARD, meta: svgSource })
    s.learnRef(VER(1), AST(1))
    expect(await s.resolveUrl(VER(1), 'thumb', key)).toBe(
      `/files/${AST(1)}/${VER(1)}/original?board=${BOARD}`,
    )
    const gone: FileMetaSource = { load: async () => ({ meta: null, missing: true, error: false }) }
    const g = new FileUrlResolver({ boardId: BOARD, meta: gone })
    g.learnRef(VER(1), AST(1))
    expect(await g.resolveUrl(VER(1), 'thumb', key)).toBeNull()
  })
})

describe('derivatives by zoom (§2.10.3)', () => {
  it('switches to display after 300 ms above 512 device px; at most 60 per session; never back', () => {
    let t = 0
    const u = new DerivativeUpgrades({ now: () => t })
    const img = (id: string, px: number, fileId = VER(1)) => ({ id, fileId, devicePx: px })
    expect(u.observe([img('a', 600)])).toEqual([])
    t = 299
    expect(u.observe([img('a', 600)])).toEqual([])
    t = 300
    expect(u.observe([img('a', 600)])).toEqual([{ id: 'a', from: VER(1), to: `${VER(1)}@display` }])
    // already display: nothing more; a dip below the threshold restarts the dwell
    expect(u.observe([img('a', 900, `${VER(1)}@display`)])).toEqual([])
    expect(u.observe([img('b', 600)])).toEqual([])
    t = 400
    expect(u.observe([img('b', 500)])).toEqual([])
    t = 700
    expect(u.observe([img('b', 600)])).toEqual([])
    t = 1000
    expect(u.observe([img('b', 600)])).toHaveLength(1)
    // off screen resets the dwell too
    expect(u.observe([img('c', 600)])).toEqual([])
    t = 1100
    expect(u.observe([])).toEqual([])
    t = 1500
    expect(u.observe([img('c', 600)])).toEqual([])
    // the session cap
    const capped = new DerivativeUpgrades({ now: () => t, maxUpgrades: 2 })
    const many = Array.from({ length: 5 }, (_, i) => img(`m${i}`, 1000, VER(10 + i)))
    capped.observe(many)
    t += 300
    expect(capped.observe(many)).toHaveLength(2)
    t += 300
    expect(capped.observe(many)).toHaveLength(0)
    expect(capped.upgrades).toBe(2)
  })
})
