import type { TLAsset, TLAssetContext } from 'tldraw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssetStore, parseFileRef, pickImageDerivative } from './asset-store.ts'
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
    const store = createAssetStore({ boardId: TEST_BOARD, devUser: 'alice', metaStore })
    const asset = imageAsset(stableFileRef(meta.assetId, meta.versionId))
    const small = await store.resolve?.(asset, ctx({ steppedScreenScale: 0.125 }))
    const big = await store.resolve?.(asset, ctx({ steppedScreenScale: 2 }))
    expect(small).toBe(`/files/${meta.assetId}/${meta.versionId}/d/${thumb.id}?board=${TEST_BOARD}`)
    expect(big).toBe(`/files/${meta.assetId}/${meta.versionId}/d/${display.id}?board=${TEST_BOARD}`)
  })

  it('uses the original for copy/export, while previews are pending, and for video', async () => {
    const { meta } = readyImage()
    const original = `/files/${meta.assetId}/${meta.versionId}/original?board=${TEST_BOARD}`
    const store = createAssetStore({
      boardId: TEST_BOARD,
      devUser: 'alice',
      metaStore: serving(meta).metaStore,
    })
    const asset = imageAsset(stableFileRef(meta.assetId, meta.versionId))
    expect(await store.resolve?.(asset, ctx({ shouldResolveToOriginal: true }))).toBe(original)
    expect(await store.resolve?.({ ...asset, type: 'video' } as TLAsset, ctx())).toBe(original)

    const queued = makeMeta({ kind: 'image', status: 'processing' })
    const pendingStore = createAssetStore({
      boardId: TEST_BOARD,
      devUser: 'alice',
      metaStore: serving(queued).metaStore,
    })
    const pending = imageAsset(stableFileRef(queued.assetId, queued.versionId))
    expect(await pendingStore.resolve?.(pending, ctx())).toBe(
      `/files/${queued.assetId}/${queued.versionId}/original?board=${TEST_BOARD}`,
    )
  })

  it('resolves nothing for failed/missing versions or foreign URLs (no third-party fetches)', async () => {
    const failed = makeMeta({
      kind: 'image',
      status: 'failed',
      error: { code: 'IMAGE_INVALID', message: 'x' },
    })
    const store = createAssetStore({
      boardId: TEST_BOARD,
      devUser: 'a',
      metaStore: serving(failed).metaStore,
    })
    expect(
      await store.resolve?.(imageAsset(stableFileRef(failed.assetId, failed.versionId)), ctx()),
    ).toBeNull()
    const missing = createAssetStore({
      boardId: TEST_BOARD,
      devUser: 'a',
      metaStore: serving(null).metaStore,
    })
    expect(await missing.resolve?.(imageAsset(stableFileRef(newId('ast'), newId('ver'))), ctx())).toBeNull()
    const { fetchImpl, metaStore } = serving(failed)
    const foreign = createAssetStore({ boardId: TEST_BOARD, devUser: 'a', metaStore })
    expect(await foreign.resolve?.(imageAsset('https://tracker.example/pixel.png'), ctx())).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('upload() stores only stable ids in the record and reports the version to the uploading tab', async () => {
    const meta = makeMeta({ kind: 'image', name: 'photo.png' })
    const fetchMock = vi.fn(async () => Response.json(meta, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const onUploaded = vi.fn()
    const store = createAssetStore({
      boardId: TEST_BOARD,
      devUser: 'alice',
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
})
