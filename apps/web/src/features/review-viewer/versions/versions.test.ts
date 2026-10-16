// WS2 (wave S): the version list's client, the page's store of lists (fetch once, refresh on the board event and on
// a version it does not know), what the chip and the list say, and "Upload new version"'s retries.
import {
  ASSET_VERSION_EVENT,
  type AssetVersionEntry,
  type ListAssetVersionsResponse,
} from '@draftroom/contracts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../api/client.ts'
import type { AssetVersionMeta } from '../../../assets/contract.ts'
import { UploadError } from '../../../assets/upload.ts'
import { createFeatureRegistries } from '../../../canvas/api/index.ts'
import { uploadVersion } from '../../../file-card/ported/edit-media.tsx'
import { listAssetVersions, setVersionsRequester, supersedesHeader } from './client.ts'
import {
  chipText,
  compareRefusal,
  defaultPair,
  entryDetail,
  entryFacts,
  pageCountNote,
  versionLabel,
} from './model.ts'
import { UNKNOWN_VERSION_REFETCH_MS, VersionStore, versionStoreOf } from './store.ts'

const B = 'b-0123456789'
const AST = 'ast_0123456789abcdefghij'
const ver = (i: number) => `ver_${String(i).padStart(10, '0')}abcdefghij`

const entry = (n: number, extra: Partial<AssetVersionEntry> = {}): AssetVersionEntry => ({
  n,
  versionId: ver(n),
  supersedes: n > 1 ? ver(n - 1) : null,
  name: `cut-${n}.png`,
  kind: 'image',
  sizeBytes: 2_200_000,
  uploadedBy: { id: null, name: 'Ana', kind: 'guest', external: false },
  createdAt: '2026-10-16T15:04:00.000Z',
  status: 'ready',
  pageCount: null,
  durationMs: null,
  threads: { open: 0, resolved: 0 },
  review: null,
  ...extra,
})
const listOf = (n: number): ListAssetVersionsResponse => ({
  assetId: AST,
  versions: Array.from({ length: n }, (_, i) => entry(i + 1)),
  latestVersionId: ver(n),
})

describe('the client', () => {
  it('asks the list route and parses the answer; any failure or another asset answers null', async () => {
    const request = vi.fn(async () => listOf(2))
    setVersionsRequester({ request } as never)
    try {
      expect(await listAssetVersions(B, AST)).toEqual(listOf(2))
      expect(request).toHaveBeenCalledWith('GET', `/api/boards/${B}/asset-versions/${AST}`, expect.anything())
      request.mockResolvedValueOnce({ ...listOf(2), assetId: 'ast_zzzzzzzzzzzzzzzzzzzz' })
      expect(await listAssetVersions(B, AST)).toBeNull()
      request.mockRejectedValueOnce(new ApiError('not-found', 404, 'NOT_FOUND', 'Not found.'))
      expect(await listAssetVersions(B, AST)).toBeNull()
    } finally {
      setVersionsRequester(null)
    }
    expect(supersedesHeader(ver(1))).toEqual({ 'x-lobby-supersedes': ver(1) })
  })
})

describe('the store', () => {
  it('fetches once per asset, refreshes on its event, and again (throttled) for a version it does not know', async () => {
    let now = 1_000_000
    let answer = listOf(2)
    const fetcher = vi.fn(async () => answer)
    const store = new VersionStore(B, fetcher, () => now)
    const list = store.list(AST)
    store.list(AST)
    await vi.waitFor(() => expect(list.get()).toEqual(listOf(2)))
    expect(fetcher).toHaveBeenCalledTimes(1)
    // a version the list knows: nothing
    store.ensure(AST, ver(2))
    expect(fetcher).toHaveBeenCalledTimes(1)
    // one it does not (another tab's write arrived first): once, then throttled
    answer = listOf(3)
    now += UNKNOWN_VERSION_REFETCH_MS
    store.ensure(AST, ver(3))
    await vi.waitFor(() => expect(list.get()?.versions).toHaveLength(3))
    answer = listOf(4)
    store.ensure(AST, ver(9))
    expect(fetcher).toHaveBeenCalledTimes(2)
    now += UNKNOWN_VERSION_REFETCH_MS
    store.ensure(AST, ver(9))
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))
    // the board event for this asset (another asset's is ignored, and so is a malformed one)
    answer = listOf(5)
    store.onEvent({ assetId: 'ast_zzzzzzzzzzzzzzzzzzzz', versionId: ver(1) })
    store.onEvent({ nope: true })
    expect(fetcher).toHaveBeenCalledTimes(3)
    store.onEvent({ assetId: AST, versionId: ver(5) })
    await vi.waitFor(() => expect(list.get()?.latestVersionId).toBe(ver(5)))
    // a failed refresh keeps what the page knew
    fetcher.mockResolvedValueOnce(null as never)
    await store.refresh(AST)
    expect(list.get()?.latestVersionId).toBe(ver(5))
  })

  it('an ask while a fetch runs makes one more fetch after it, never two at once', async () => {
    let release: () => void = () => {}
    const fetcher = vi.fn(
      () =>
        new Promise<ListAssetVersionsResponse>((r) => {
          release = () => r(listOf(2))
        }),
    )
    const store = new VersionStore(B, fetcher)
    store.list(AST)
    void store.refresh(AST)
    void store.refresh(AST)
    expect(fetcher).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    release()
  })

  it('per board page: the store listens to its event stream (the event and every resync)', () => {
    const handlers = new Map<string, (d: unknown) => void>()
    const resyncs: (() => void)[] = []
    const events = {
      on: (type: string, fn: (d: unknown) => void) => {
        handlers.set(type, fn)
        return () => {}
      },
      onResync: (fn: () => void) => {
        resyncs.push(fn)
        return () => {}
      },
    }
    const registries = createFeatureRegistries()
    const ctx = { registries, board: { id: B }, events } as never
    const s = versionStoreOf(ctx)
    expect(versionStoreOf(ctx)).toBe(s)
    expect([...handlers.keys()]).toEqual([ASSET_VERSION_EVENT])
    expect(resyncs).toHaveLength(1)
  })
})

describe('what the chip and the list say', () => {
  it('the chip only for a deliverable with more than one version here; labels; the default pair', () => {
    expect(chipText(listOf(1), ver(1))).toBeNull()
    expect(chipText(null, ver(1))).toBeNull()
    expect(chipText(listOf(3), ver(2))).toBe('v2')
    expect(chipText(listOf(3), ver(9))).toBeNull()
    expect(versionLabel(listOf(3), ver(3))).toBe('v3')
    expect(defaultPair(listOf(1), ver(1))).toBeNull()
    expect(defaultPair(listOf(3), ver(3))).toEqual({ a: ver(2), b: ver(3) })
    expect(defaultPair(listOf(3), ver(1))).toEqual({ a: ver(1), b: ver(2) })
    expect(defaultPair(listOf(3), ver(9))).toEqual({ a: ver(2), b: ver(3) })
  })

  it('rows name a guest "(guest)", the comments and the status the version got', () => {
    expect(entryDetail(entry(1))).toMatch(/^Ana \(guest\) · Oct 16, .* · 2\.1 MB$/)
    expect(entryFacts(entry(1))).toBeNull()
    expect(
      entryFacts(
        entry(2, {
          threads: { open: 1, resolved: 2 },
          review: {
            status: 'approved',
            by: { id: null, name: 'Ana', kind: 'guest', external: false },
            at: '2026-10-16T16:00:00.000Z',
          },
        }),
      ),
    ).toBe('3 comments · Approved')
  })

  it('compare refuses different kinds and files without previews; a page count mismatch is stated', () => {
    expect(compareRefusal({ kind: 'pdf', label: 'v1' }, { kind: 'video', label: 'v2' })).toBe(
      "v1 is a document and v2 is a video: they can't be compared side by side.",
    )
    expect(compareRefusal({ kind: 'other', label: 'v1' }, { kind: 'other', label: 'v2' })).toMatch(
      /no preview/,
    )
    expect(compareRefusal({ kind: 'image', label: 'v1' }, { kind: 'image', label: 'v2' })).toBeNull()
    expect(pageCountNote({ label: 'v2', pages: 14 }, { label: 'v3', pages: 16 })).toBe(
      'v2 has 14 pages, v3 has 16 pages.',
    )
    expect(pageCountNote({ label: 'v2', pages: 3 }, { label: 'v3', pages: 3 })).toBeNull()
  })
})

describe('"Upload new version"', () => {
  const facts = {
    assetId: AST,
    versionId: ver(1),
    kind: 'image',
    name: 'cut.png',
    mimeType: 'image/png',
    sizeBytes: 1,
  } as const
  const meta = (v: string) => ({ assetId: AST, versionId: v }) as AssetVersionMeta
  function page(list: ListAssetVersionsResponse | null) {
    const notes: string[] = []
    const registries = createFeatureRegistries()
    const ctx = {
      registries,
      board: { id: B },
      events: { on: () => () => {}, onResync: () => () => {} },
      notify: (n: { text: string }) => notes.push(n.text),
    } as never
    setVersionsRequester({ request: async () => list } as never)
    return { ctx, notes }
  }
  const notLatest = (latest: string) =>
    new UploadError('VERSION_NOT_LATEST', 'newer', 409, { latestVersionId: latest })

  it('supersedes the newest version the list knows (not the element’s older one)', async () => {
    const { ctx } = page(listOf(3))
    const send = vi.fn(async (s: string | null) => meta(s ?? 'fresh'))
    expect(await uploadVersion(ctx, facts, send)).toEqual(meta(ver(3)))
    expect(send.mock.calls).toEqual([[ver(3)]])
    setVersionsRequester(null)
  })

  it('a newer version meanwhile: once on top of it; the chain moved on elsewhere, or a 404: a fresh asset, said', async () => {
    const { ctx, notes } = page(null)
    const send = vi.fn(async (s: string | null) => {
      if (s === ver(1)) throw notLatest(ver(2))
      return meta(s ?? 'fresh')
    })
    expect(await uploadVersion(ctx, facts, send)).toEqual(meta(ver(2)))
    expect(send.mock.calls).toEqual([[ver(1)], [ver(2)]])
    expect(notes).toEqual([])

    const elsewhere = vi.fn(async (s: string | null) => {
      if (s) throw notLatest(s)
      return meta('fresh')
    })
    expect(await uploadVersion(ctx, facts, elsewhere)).toEqual(meta('fresh'))
    expect(elsewhere.mock.calls).toEqual([[ver(1)], [null]])
    expect(notes).toHaveLength(1)

    const gone = vi.fn(async (s: string | null) => {
      if (s) throw new UploadError('NOT_FOUND', 'Not found.', 404)
      return meta('fresh')
    })
    expect(await uploadVersion(ctx, facts, gone)).toEqual(meta('fresh'))
    // any other refusal is the upload's own (a quota, a size)
    const full = vi.fn(async () => {
      throw new UploadError('STORAGE_QUOTA_EXCEEDED', 'full', 413)
    })
    await expect(uploadVersion(ctx, facts, full)).rejects.toMatchObject({ status: 413 })
    expect(full).toHaveBeenCalledTimes(1)
    setVersionsRequester(null)
  })
})
