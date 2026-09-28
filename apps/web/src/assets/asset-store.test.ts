import type { TLAsset, TLAssetContext } from 'tldraw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ANIMATED_ORIGINAL_LIMITS,
  createAssetStore,
  IMAGE_PROCESSING_URL,
  IMAGE_UNAVAILABLE_URL,
  PDF_PAGE_META_KEY,
  parseFileRef,
  pdfPageOf,
  pickImageDerivative,
  pickPageDerivative,
  playsAnimatedOriginal,
} from './asset-store.ts'
import { type AssetVersionMeta, newId, stableFileRef } from './contract.ts'
import { AssetMetaStore } from './meta-store.ts'
import { partitionFiles } from './partition.ts'
import { derivative, makeMeta, TEST_BOARD } from './test-fixtures.ts'

const ctx = (over: Partial<TLAssetContext> = {}): TLAssetContext => ({
  screenScale: 1,
  steppedScreenScale: 1,
  dpr: 1,
  networkEffectiveType: null,
  shouldResolveToOriginal: false,
  ...over,
})

function imageAsset(src: string, w = 1600): TLAsset {
  return {
    id: 'asset:img1',
    typeName: 'asset',
    type: 'image',
    props: { w, h: 1200, name: 'photo.png', isAnimated: false, mimeType: 'image/png', src, fileSize: 1 },
    meta: {},
  } as TLAsset
}

const readyImage = () => {
  const thumb = derivative({ role: 'thumb', width: 512, height: 384 })
  const display = derivative({ role: 'display', width: 1600, height: 1200 })
  const meta = makeMeta({
    kind: 'image',
    status: 'ready',
    derivatives: [thumb, display],
    probe: {
      width: 1600,
      height: 1200,
      pageCount: null,
      durationMs: null,
      videoCodec: null,
      audioCodec: null,
    },
  })
  return { meta, thumb, display }
}

const serving = (meta: AssetVersionMeta | null) => {
  const fetchImpl = vi.fn(async () => (meta ? Response.json(meta) : new Response('{}', { status: 404 })))
  return { fetchImpl, metaStore: new AssetMetaStore({ fetchImpl: fetchImpl as unknown as typeof fetch }) }
}

describe('parseFileRef', () => {
  it('accepts only the host-less stable reference with well-formed ids', () => {
    const a = newId('ast')
    const v = newId('ver')
    expect(parseFileRef(stableFileRef(a, v))).toEqual({ assetId: a, versionId: v })
    for (const bad of [
      `https://evil.example/files/${a}/${v}/original`,
      `/files/${a}/${v}/original?X-Amz-Signature=1`,
      `/files/../${v}/original`,
      'data:image/png;base64,AAAA',
      '',
      null,
    ]) {
      expect(parseFileRef(bad)).toBeNull()
    }
  })
})

describe('pickImageDerivative', () => {
  const { meta, thumb, display } = readyImage()
  it('uses the thumb while the image is small on screen, display once it would look soft', () => {
    expect(pickImageDerivative(meta, 1600, ctx({ steppedScreenScale: 0.25 }))).toBe(thumb) // 400 px
    expect(pickImageDerivative(meta, 1600, ctx({ steppedScreenScale: 0.25, dpr: 2 }))).toBe(display) // 800 device px
    expect(pickImageDerivative(meta, 1600, ctx({ steppedScreenScale: 1 }))).toBe(display)
  })
  it('prefers the thumb on very slow networks', () => {
    expect(pickImageDerivative(meta, 1600, ctx({ networkEffectiveType: '2g' }))).toBe(thumb)
  })
})

describe('TLAssetStore', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('resolves a ready image to a board-scoped derivative URL sized for the screen', async () => {
    const { meta, thumb, display } = readyImage()
    const { metaStore } = serving(meta)
    const store = createAssetStore({ boardId: TEST_BOARD, metaStore })
    const asset = imageAsset(stableFileRef(meta.assetId, meta.versionId))
    const small = await store.resolve?.(asset, ctx({ steppedScreenScale: 0.125 }))
    const big = await store.resolve?.(asset, ctx({ steppedScreenScale: 2 }))
    expect(small).toBe(`/files/${meta.assetId}/${meta.versionId}/d/${thumb.id}?board=${TEST_BOARD}`)
    expect(big).toBe(`/files/${meta.assetId}/${meta.versionId}/d/${display.id}?board=${TEST_BOARD}`)
  })

  it('uses the original for copy/export (even while previews are pending) and for video', async () => {
    const { meta } = readyImage()
    const original = `/files/${meta.assetId}/${meta.versionId}/original?board=${TEST_BOARD}`
    const store = createAssetStore({
      boardId: TEST_BOARD,
      metaStore: serving(meta).metaStore,
    })
    const asset = imageAsset(stableFileRef(meta.assetId, meta.versionId))
    expect(await store.resolve?.(asset, ctx({ shouldResolveToOriginal: true }))).toBe(original)
    expect(await store.resolve?.({ ...asset, type: 'video' } as TLAsset, ctx())).toBe(original)

    const queued = makeMeta({ kind: 'image', status: 'processing' })
    const { fetchImpl, metaStore } = serving(queued)
    const pendingStore = createAssetStore({ boardId: TEST_BOARD, metaStore })
    const pending = imageAsset(stableFileRef(queued.assetId, queued.versionId))
    expect(await pendingStore.resolve?.(pending, ctx({ shouldResolveToOriginal: true }))).toBe(
      `/files/${queued.assetId}/${queued.versionId}/original?board=${TEST_BOARD}`,
    )
    expect(fetchImpl).not.toHaveBeenCalled() // export never waits for previews
  })

  it('shows a readable tile for failed/missing versions, nothing for foreign URLs (no third-party fetches)', async () => {
    const failed = makeMeta({
      kind: 'image',
      status: 'failed',
      error: { code: 'IMAGE_INVALID', message: 'x' },
    })
    const store = createAssetStore({
      boardId: TEST_BOARD,
      metaStore: serving(failed).metaStore,
    })
    expect(await store.resolve?.(imageAsset(stableFileRef(failed.assetId, failed.versionId)), ctx())).toBe(
      IMAGE_UNAVAILABLE_URL,
    )
    const missing = createAssetStore({
      boardId: TEST_BOARD,
      metaStore: serving(null).metaStore,
    })
    expect(await missing.resolve?.(imageAsset(stableFileRef(newId('ast'), newId('ver'))), ctx())).toBe(
      IMAGE_UNAVAILABLE_URL,
    )
    // Download original / export still get the real bytes of a failed image.
    expect(
      await store.resolve?.(
        imageAsset(stableFileRef(failed.assetId, failed.versionId)),
        ctx({ shouldResolveToOriginal: true }),
      ),
    ).toBe(`/files/${failed.assetId}/${failed.versionId}/original?board=${TEST_BOARD}`)
    const { fetchImpl, metaStore } = serving(failed)
    const foreign = createAssetStore({ boardId: TEST_BOARD, metaStore })
    expect(await foreign.resolve?.(imageAsset('https://tracker.example/pixel.png'), ctx())).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  describe('while the worker is still making previews (F4)', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    /** A meta route that answers `processing` until `readyAfter` requests, then `ready`. */
    function processingThenReady(readyAfter: number) {
      const { meta: ready, thumb } = readyImage()
      const calls: string[] = []
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url))
        return Response.json(
          calls.length > readyAfter ? ready : { ...ready, status: 'processing', derivatives: [] },
        )
      }) as unknown as typeof fetch
      const metaStore = new AssetMetaStore({ fetchImpl, minDelayMs: 100, maxDelayMs: 100 })
      return { ready, thumb, calls, metaStore }
    }

    it('waits for the previews instead of returning the original', async () => {
      const { ready, thumb, calls, metaStore } = processingThenReady(3)
      const store = createAssetStore({ boardId: TEST_BOARD, metaStore })
      const asset = imageAsset(stableFileRef(ready.assetId, ready.versionId))
      let result: string | null | undefined
      void Promise.resolve(store.resolve?.(asset, ctx({ steppedScreenScale: 0.125 }))).then((r) => {
        result = r
      })
      await vi.advanceTimersByTimeAsync(150)
      expect(result).toBeUndefined() // still pending: tldraw keeps its preview / loading tile
      await vi.advanceTimersByTimeAsync(1000)
      expect(result).toBe(`/files/${ready.assetId}/${ready.versionId}/d/${thumb.id}?board=${TEST_BOARD}`)
      expect(calls.length).toBeGreaterThanOrEqual(4)
    })

    it('after the wait, shows a small original but keeps the tile for a big one', async () => {
      const small = makeMeta({ kind: 'image', status: 'processing', sizeBytes: 800_000 })
      const big = makeMeta({ kind: 'image', status: 'processing', sizeBytes: 9_000_000 })
      const fetchImpl = vi.fn(async (url: string | URL | Request) =>
        Response.json(String(url).includes(small.assetId) ? small : big),
      ) as unknown as typeof fetch
      const metaStore = new AssetMetaStore({ fetchImpl, minDelayMs: 100, maxDelayMs: 500 })
      const store = createAssetStore({ boardId: TEST_BOARD, metaStore, previewWaitMs: 2000 })
      const results: (string | null | undefined)[] = []
      for (const m of [small, big]) {
        void Promise.resolve(store.resolve?.(imageAsset(stableFileRef(m.assetId, m.versionId)), ctx())).then(
          (r) => results.push(r),
        )
      }
      await vi.advanceTimersByTimeAsync(2500)
      expect(results).toContain(`/files/${small.assetId}/${small.versionId}/original?board=${TEST_BOARD}`)
      expect(results).toContain(IMAGE_PROCESSING_URL)
    })

    it('never falls back to the original when the meta route keeps failing (PERF-01)', async () => {
      const meta = makeMeta({ kind: 'image', status: 'ready' })
      const fetchImpl = vi.fn(async () => {
        throw new TypeError('net::ERR_INSUFFICIENT_RESOURCES')
      }) as unknown as typeof fetch
      const metaStore = new AssetMetaStore({ fetchImpl, random: () => 0.5 })
      const store = createAssetStore({ boardId: TEST_BOARD, metaStore })
      const asset = imageAsset(stableFileRef(meta.assetId, meta.versionId))
      let result: string | null | undefined = 'unset'
      void Promise.resolve(store.resolve?.(asset, ctx())).then((r) => {
        result = r
      })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(result).toBeNull()
      expect(fetchImpl).toHaveBeenCalledTimes(4) // 1 + 3 retries at 0.5 / 1 / 2 s
    })
  })

  it('upload() stores only stable ids in the record and reports the version to the uploading tab', async () => {
    const meta = makeMeta({ kind: 'image', name: 'photo.png' })
    const fetchMock = vi.fn(async () => Response.json(meta, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const onUploaded = vi.fn()
    const store = createAssetStore({
      boardId: TEST_BOARD,
      metaStore: new AssetMetaStore(),
      onUploaded,
    })
    const asset = imageAsset('')
    const result = await store.upload(
      asset,
      new File([new Uint8Array(10)], 'photo.png', { type: 'image/png' }),
    )
    expect(result).toEqual({
      src: `/files/${meta.assetId}/${meta.versionId}/original`,
      meta: { assetId: meta.assetId, versionId: meta.versionId },
    })
    expect(JSON.stringify(result)).not.toMatch(/board=|http|data:/)
    expect(onUploaded).toHaveBeenCalledWith(asset.id, meta)
  })
})

describe('PDF pages placed as images (FIL-04)', () => {
  function readyPdf() {
    const page1 = derivative({ role: 'page', page: 1, width: 1024, height: 1325 })
    const thumb1 = derivative({ role: 'thumb', page: 1, width: 512, height: 663 })
    const page2 = derivative({ role: 'page', page: 2, width: 1024, height: 1325 })
    const meta = makeMeta({ kind: 'pdf', status: 'ready', derivatives: [page1, thumb1, page2] })
    return { meta, page1, thumb1, page2 }
  }
  const pageAsset = (meta: AssetVersionMeta, page: unknown, w = 1024): TLAsset =>
    ({
      id: 'asset:page',
      typeName: 'asset',
      type: 'image',
      props: {
        w,
        h: 1325,
        name: 'deck — page 2.webp',
        isAnimated: false,
        mimeType: 'image/webp',
        src: stableFileRef(meta.assetId, meta.versionId),
      },
      meta: { [PDF_PAGE_META_KEY]: page },
    }) as unknown as TLAsset
  const url = (meta: AssetVersionMeta, id: string) =>
    `/files/${meta.assetId}/${meta.versionId}/d/${id}?board=${TEST_BOARD}`

  it('reads the page marker defensively', () => {
    const { meta } = readyPdf()
    expect(pdfPageOf(pageAsset(meta, 2))).toBe(2)
    for (const bad of [0, -1, 1.5, '2', null, undefined, Number.NaN]) {
      expect(pdfPageOf(pageAsset(meta, bad))).toBeNull()
    }
  })

  it("resolves to the page's own derivative, never to the PDF, and to its largest rendering for export", async () => {
    const { meta, page1, thumb1, page2 } = readyPdf()
    const store = createAssetStore({ boardId: TEST_BOARD, metaStore: serving(meta).metaStore })
    const onScreen = ctx({ steppedScreenScale: 0.5 }) // a 512-wide shape of a 1024 px asset at 100 %
    expect(await store.resolve?.(pageAsset(meta, 2), onScreen)).toBe(url(meta, page2.id))
    // Page 1 also has a 512 px thumb: enough at that size, the page image once zoomed in.
    expect(await store.resolve?.(pageAsset(meta, 1), onScreen)).toBe(url(meta, thumb1.id))
    expect(await store.resolve?.(pageAsset(meta, 1), ctx({ steppedScreenScale: 1 }))).toBe(
      url(meta, page1.id),
    )
    // Export / copy / Download original: the page image (the PDF itself is not an image).
    for (const page of [1, 2]) {
      const r = await store.resolve?.(pageAsset(meta, page), ctx({ shouldResolveToOriginal: true }))
      expect(r).toBe(url(meta, page === 1 ? page1.id : page2.id))
      expect(r).not.toContain('/original')
    }
  })

  it('shows the unavailable tile for a page without a rendering, a failed or a missing version', async () => {
    const { meta } = readyPdf()
    const store = createAssetStore({ boardId: TEST_BOARD, metaStore: serving(meta).metaStore })
    expect(await store.resolve?.(pageAsset(meta, 9), ctx())).toBe(IMAGE_UNAVAILABLE_URL)
    const failed = makeMeta({ kind: 'pdf', status: 'failed' })
    const failedStore = createAssetStore({ boardId: TEST_BOARD, metaStore: serving(failed).metaStore })
    expect(await failedStore.resolve?.(pageAsset(failed, 1), ctx())).toBe(IMAGE_UNAVAILABLE_URL)
    const gone = createAssetStore({ boardId: TEST_BOARD, metaStore: serving(null).metaStore })
    expect(await gone.resolve?.(pageAsset(meta, 1), ctx({ shouldResolveToOriginal: true }))).toBe(
      IMAGE_UNAVAILABLE_URL,
    )
  })

  it('pickPageDerivative: the smallest sharp one, the smallest on 2g, the largest when nothing is big enough', () => {
    const { meta, page1, thumb1 } = readyPdf()
    const c = (over: Partial<TLAssetContext>) => ({ ...ctx(), ...over })
    expect(pickPageDerivative(meta, 1, 1024, c({ steppedScreenScale: 0.25 }))).toBe(thumb1)
    expect(pickPageDerivative(meta, 1, 1024, c({ steppedScreenScale: 2 }))).toBe(page1)
    expect(pickPageDerivative(meta, 1, 1024, c({ steppedScreenScale: 2, networkEffectiveType: '2g' }))).toBe(
      thumb1,
    )
    expect(pickPageDerivative(meta, 3, 1024, c({}))).toBeNull()
  })
})

describe('animated GIFs (FIL-08)', () => {
  const MiB = 1024 * 1024
  function readyGif(over: Partial<AssetVersionMeta> = {}) {
    const thumb = derivative({ role: 'thumb', width: 480, height: 320 })
    const display = derivative({ role: 'display', width: 480, height: 320 })
    const meta = makeMeta({
      kind: 'image',
      status: 'ready',
      name: 'loop.gif',
      declaredMimeType: 'image/gif',
      mimeType: 'image/gif',
      sizeBytes: 600_000,
      derivatives: [thumb, display],
      probe: {
        width: 480,
        height: 320,
        pageCount: null,
        durationMs: null,
        videoCodec: null,
        audioCodec: null,
      },
      ...over,
    })
    return { meta, thumb, display }
  }
  const gifAsset = (meta: AssetVersionMeta, props: Record<string, unknown> = {}): TLAsset =>
    ({
      id: 'asset:gif',
      typeName: 'asset',
      type: 'image',
      props: {
        w: 480,
        h: 320,
        name: 'loop.gif',
        isAnimated: true,
        mimeType: 'image/gif',
        src: stableFileRef(meta.assetId, meta.versionId),
        ...props,
      },
      meta: {},
    }) as TLAsset
  const original = (m: AssetVersionMeta) => `/files/${m.assetId}/${m.versionId}/original?board=${TEST_BOARD}`

  it('plays the original once it is readable on screen, a still when zoomed far out', async () => {
    const { meta, thumb } = readyGif()
    const store = createAssetStore({
      boardId: TEST_BOARD,
      metaStore: serving(meta).metaStore,
      reducedMotion: () => false,
    })
    // 480 px wide at 100 %: plays.
    expect(await store.resolve?.(gifAsset(meta), ctx({ screenScale: 1 }))).toBe(original(meta))
    // At 10 % it is 48 px on screen: the static thumb.
    expect(await store.resolve?.(gifAsset(meta), ctx({ screenScale: 0.1, steppedScreenScale: 0.125 }))).toBe(
      `/files/${meta.assetId}/${meta.versionId}/d/${thumb.id}?board=${TEST_BOARD}`,
    )
  })

  it('keeps the still for big files, huge frames, reduced motion, slow networks and unconfirmed types', () => {
    const on = { screenScale: 1, networkEffectiveType: null }
    const props = { w: 480, h: 320, isAnimated: true }
    expect(playsAnimatedOriginal(readyGif().meta, props, on, false)).toBe(true)
    expect(playsAnimatedOriginal(readyGif({ sizeBytes: 8 * MiB + 1 }).meta, props, on, false)).toBe(false)
    expect(playsAnimatedOriginal(readyGif({ sizeBytes: 8 * MiB }).meta, props, on, false)).toBe(true)
    const huge = readyGif({
      probe: {
        width: 6000,
        height: 5000,
        pageCount: null,
        durationMs: null,
        videoCodec: null,
        audioCodec: null,
      },
    }).meta
    expect(playsAnimatedOriginal(huge, props, on, false)).toBe(false)
    expect(playsAnimatedOriginal(readyGif().meta, props, on, true)).toBe(false)
    expect(playsAnimatedOriginal(readyGif().meta, props, { ...on, networkEffectiveType: '2g' }, false)).toBe(
      false,
    )
    // Worker has not confirmed the content yet, or it is not a GIF at all.
    expect(playsAnimatedOriginal(readyGif({ status: 'processing' }).meta, props, on, false)).toBe(false)
    expect(playsAnimatedOriginal(readyGif({ mimeType: 'image/png' }).meta, props, on, false)).toBe(false)
    // Animated WebP only when tldraw flagged the upload as animated.
    const webp = readyGif({ mimeType: 'image/webp' }).meta
    expect(playsAnimatedOriginal(webp, props, on, false)).toBe(true)
    expect(playsAnimatedOriginal(webp, { ...props, isAnimated: false }, on, false)).toBe(false)
    // The threshold is the longer side on screen.
    expect(playsAnimatedOriginal(readyGif().meta, props, { ...on, screenScale: 159 / 480 }, false)).toBe(
      false,
    )
    expect(playsAnimatedOriginal(readyGif().meta, props, { ...on, screenScale: 160 / 480 }, false)).toBe(true)
    expect(ANIMATED_ORIGINAL_LIMITS.minScreenPx).toBe(160)
  })

  it('never loads the original of a static image type, whatever the zoom (FIL-02)', async () => {
    const { meta, display } = readyImage()
    const store = createAssetStore({
      boardId: TEST_BOARD,
      metaStore: serving(meta).metaStore,
      reducedMotion: () => false,
    })
    const r = await store.resolve?.(
      imageAsset(stableFileRef(meta.assetId, meta.versionId)),
      ctx({ screenScale: 4 }),
    )
    expect(r).toBe(`/files/${meta.assetId}/${meta.versionId}/d/${display.id}?board=${TEST_BOARD}`)
  })
})

describe('partitionFiles', () => {
  const f = (name: string, type: string, size = 10) => {
    const file = new File([new Uint8Array(Math.min(size, 16))], name, { type })
    Object.defineProperty(file, 'size', { value: size })
    return file
  }
  it('sends decodable images to tldraw, everything else to file cards', () => {
    const png = f('a.png', 'image/png')
    const pdf = f('deck.pdf', 'application/pdf')
    const mp4 = f('clip.mp4', 'video/mp4')
    const svg = f('logo.svg', 'image/svg+xml')
    const typeless = f('scan.png', '')
    const zip = f('x.zip', 'application/zip')
    const out = partitionFiles([png, pdf, mp4, svg, typeless, zip])
    expect(out.images).toEqual([png])
    expect(out.cards.map((c) => [c.file.name, c.kind])).toEqual([
      ['deck.pdf', 'pdf'],
      ['clip.mp4', 'video'],
      ['logo.svg', 'other'], // untrusted SVG is never rendered inline
      ['scan.png', 'image'],
      ['x.zip', 'other'],
    ])
  })
  it('rejects files over the per-kind limit before uploading', () => {
    const big = f('huge.pdf', 'application/pdf', 101 * 1024 * 1024)
    const ok = f('fine.mp4', 'video/mp4', 101 * 1024 * 1024)
    const out = partitionFiles([big, ok])
    expect(out.rejected.map((r) => r.file.name)).toEqual(['huge.pdf'])
    expect(out.rejected[0]?.reason).toContain('100 MB')
    expect(out.cards.map((c) => c.file.name)).toEqual(['fine.mp4'])
  })
  it('rejects an oversize image by name before tldraw sees it (its own toast names no file)', () => {
    const big = f('oversize-31mb-dunes.jpg', 'image/jpeg', 31 * 1024 * 1024)
    const ok = f('photo.jpg', 'image/jpeg', 25 * 1024 * 1024)
    const out = partitionFiles([big, ok])
    expect(out.images).toEqual([ok])
    expect(out.rejected.map((r) => `${r.file.name} ${r.reason}.`)).toEqual([
      'oversize-31mb-dunes.jpg is larger than 25 MB, the limit for images.',
    ])
  })
})
