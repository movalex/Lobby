// The wave S foundation's web side (docs/WAVE-S-CONTRACTS.md §7), as the integration ships it: every switch is on (a
// dev-auth page may turn one off); "My notifications" offers the review kind only with the status switch on; WS1's review client is live
// (./client.test.ts) and WS2's version list asks the api and answers null for any failure; the review viewer's shell
// renders nothing while its switches are off, and its slots, state and layout are what WS1-WS3 build on.
import { CHAT_HOOK_KINDS } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CanvasFeatureContext, createFeatureRegistries } from '../../canvas/api/index.ts'
import { offeredChatKinds } from '../notify-settings/model.ts'
import { registerViewerSlot, type ViewerSlotProps, viewerSlotEntries } from '../review-viewer/slots.ts'
import {
  ReviewViewerHost,
  ReviewViewerMarkup,
  VIEWER_EMPTY_TEXT,
  viewedFile,
  viewerLayout,
} from '../review-viewer/ViewerHost.tsx'
import { listAssetVersions, supersedesHeader } from '../review-viewer/versions/client.ts'
import { closeReviewViewer, openReviewViewer, reviewViewerRequest } from '../review-viewer/viewer-state.ts'
import {
  addReviewItem,
  EMPTY_REVIEW,
  getReview,
  listReviewEvents,
  ReviewRequestError,
  reviewAvailable,
} from './client.ts'
import { REVIEW_FLAG_KEYS, REVIEW_FLAGS, reviewFlags, reviewViewerEnabled } from './flags.ts'

const B = 'b-pitch0001'
const AST = 'ast_0123456789abcdefghij'
const VER = 'ver_0123456789abcdefghij'
const RVI = 'rvi_0123456789abcdefghij'

describe('the wave S switches', () => {
  it('ship on (the integration), and a production page ignores any override', () => {
    expect(REVIEW_FLAGS).toEqual({ status: true, versions: true, mediaComments: true, reviewPage: true })
    expect(reviewFlags(false, () => '0')).toEqual(REVIEW_FLAGS)
    expect(reviewViewerEnabled(REVIEW_FLAGS)).toBe(true)
    expect(reviewViewerEnabled({ ...REVIEW_FLAGS, versions: false, mediaComments: false })).toBe(false)
  })

  it('a dev-auth page may turn each on or off; a blocked store keeps the shipped value', () => {
    const store: Record<string, string> = {
      [REVIEW_FLAG_KEYS.versions]: '1',
      [REVIEW_FLAG_KEYS.status]: '0',
      [REVIEW_FLAG_KEYS.mediaComments]: '0',
    }
    const f = reviewFlags(true, (k) => store[k])
    expect(f).toEqual({ status: false, versions: true, mediaComments: false, reviewPage: true })
    expect(reviewViewerEnabled(f)).toBe(true)
    const off = reviewFlags(true, (k) => (k === REVIEW_FLAG_KEYS.status ? null : '0'))
    expect(reviewViewerEnabled(off)).toBe(false)
    expect(
      reviewFlags(true, () => {
        throw new Error('blocked')
      }),
    ).toEqual(REVIEW_FLAGS)
  })

  it('"My notifications" offers review_status only with the status switch on', () => {
    expect(offeredChatKinds(false)).toEqual(CHAT_HOOK_KINDS.filter((k) => k !== 'review_status'))
    expect(offeredChatKinds(true)).toEqual([...CHAT_HOOK_KINDS])
  })
})

describe('the wave S clients (stubs)', () => {
  const fetchSpy = vi.fn()
  beforeEach(() => {
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('review (WS1: live, ./client.test.ts): the reads answer empty on a refusal, the writes reject its code', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'No.' } }), { status: 403 }),
    )
    expect(await getReview(B)).toEqual(EMPTY_REVIEW)
    expect(await listReviewEvents(B, RVI)).toEqual({ events: [], nextBefore: null })
    expect(reviewAvailable()).toBe(true)
    const e = await addReviewItem(B, { elementId: 'frame-1', kind: 'frame', label: 'Key art' }).then(
      () => null,
      (err: unknown) => err,
    )
    expect(e).toBeInstanceOf(ReviewRequestError)
    expect((e as ReviewRequestError).code).toBe('FORBIDDEN')
  })

  it('versions (live since WS2): the list asks the api and answers null when it fails; the header', async () => {
    expect(await listAssetVersions(B, AST)).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(`/api/boards/${B}/asset-versions/${AST}`)
    expect(supersedesHeader(VER)).toEqual({ 'x-lobby-supersedes': VER })
  })
})

describe('the review viewer shell', () => {
  it('state: open fills the defaults and a fresh nonce; close clears', () => {
    const registries = createFeatureRegistries()
    const req = reviewViewerRequest(registries)
    expect(req.get()).toBeNull()
    openReviewViewer(registries, { elementId: 'card-1', assetId: AST, versionId: VER })
    const first = req.get()
    expect(first).toMatchObject({ mode: 'view', compareWith: null, at: null, threadId: null })
    openReviewViewer(registries, {
      elementId: 'card-1',
      assetId: AST,
      versionId: VER,
      mode: 'compare',
      compareWith: 'ver_abcdefghij0123456789',
      at: { timeMs: 12_400 },
    })
    expect(req.get()?.nonce).not.toBe(first?.nonce)
    expect(req.get()?.at).toEqual({ timeMs: 12_400 })
    closeReviewViewer(registries)
    expect(req.get()).toBeNull()
    // per board page: another page's registries have their own
    expect(reviewViewerRequest(createFeatureRegistries()).get()).toBeNull()
  })

  it('slots: per slot and kind, by order then id; an entry is removed by its undo', () => {
    const C = () => null
    const offs = [
      registerViewerSlot({ id: 'ws1.status', slot: 'header', order: 20, Component: C }),
      registerViewerSlot({ id: 'ws2.versions', slot: 'header', order: 10, Component: C }),
      registerViewerSlot({ id: 'ws3.video', slot: 'body', kinds: ['video'], Component: C }),
      registerViewerSlot({ id: 'ws3.image', slot: 'body', kinds: ['image'], Component: C }),
    ]
    try {
      expect(viewerSlotEntries('header', 'pdf').map((e) => e.id)).toEqual(['ws2.versions', 'ws1.status'])
      expect(viewerSlotEntries('body', 'video').map((e) => e.id)).toEqual(['ws3.video'])
      expect(viewerSlotEntries('body', 'pdf')).toEqual([])
      offs[2]?.()
      expect(viewerSlotEntries('body', 'video')).toEqual([])
    } finally {
      for (const off of offs) off()
    }
    expect(viewerSlotEntries('header', 'pdf')).toEqual([])
  })

  it('layout: the body, or the compare slot in compare mode, between the header and the threads', () => {
    expect(viewerLayout({ mode: 'view' })).toEqual(['header', 'body', 'threads'])
    expect(viewerLayout({ mode: 'compare' })).toEqual(['header', 'compare', 'threads'])
  })

  const props = (mode: 'view' | 'compare'): ViewerSlotProps => ({
    ctx: {} as CanvasFeatureContext,
    request: {
      elementId: 'card-1',
      assetId: AST,
      versionId: VER,
      mode,
      compareWith: null,
      at: null,
      threadId: null,
      nonce: 1,
    },
    file: { kind: 'video', name: 'Trailer cut 3.mov', mimeType: 'video/quicktime' },
    close: () => {},
  })

  it('the modal: the name, the slots that are filled, an honest empty body', () => {
    const empty = renderToStaticMarkup(createElement(ReviewViewerMarkup, { props: props('view') }))
    expect(empty).toContain('data-testid="review-viewer"')
    expect(empty).toContain('Trailer cut 3.mov')
    expect(empty).toContain(VIEWER_EMPTY_TEXT)
    expect(empty).toContain('aria-label="Close"')
    const off = registerViewerSlot({
      id: 'ws3.video',
      slot: 'body',
      kinds: ['video'],
      Component: ({ file }) => createElement('p', { 'data-testid': 'slot-video' }, file.kind),
    })
    try {
      const filled = renderToStaticMarkup(createElement(ReviewViewerMarkup, { props: props('view') }))
      expect(filled).toContain('data-testid="slot-video"')
      expect(filled).not.toContain(VIEWER_EMPTY_TEXT)
      // compare mode shows the compare slot instead of the body
      const compare = renderToStaticMarkup(createElement(ReviewViewerMarkup, { props: props('compare') }))
      expect(compare).toContain('data-slot="compare"')
      expect(compare).not.toContain('data-testid="slot-video"')
    } finally {
      off()
    }
  })

  it('the host renders nothing while nothing asks for it, or when the element shows another deliverable', () => {
    const registries = createFeatureRegistries()
    const element = {
      id: 'card-1',
      type: 'image',
      isDeleted: false,
      customData: { lobby: { file: { assetId: AST, versionId: VER, kind: 'video', name: 'cut.mov' } } },
    }
    const ctx = {
      registries,
      board: { id: B },
      canvas: { get: () => element },
    } as unknown as CanvasFeatureContext
    expect(renderToStaticMarkup(createElement(ReviewViewerHost, { ctx }))).toBe('')
    openReviewViewer(registries, { elementId: 'card-1', assetId: 'ast_another0123456789', versionId: VER })
    expect(renderToStaticMarkup(createElement(ReviewViewerHost, { ctx }))).toBe('')
  })

  it('the header names the version being viewed (its meta), not the card’s current file', () => {
    const card = { kind: 'video', name: 'cut-3.mov', mimeType: 'video/quicktime', versionId: VER } as const
    const V1 = 'ver_v1v1v1v1v1v1v1v1v1v1'
    // the card's own version: its facts until the meta answers, then the meta
    expect(viewedFile(card, VER, null)).toEqual({
      kind: 'video',
      name: 'cut-3.mov',
      mimeType: 'video/quicktime',
    })
    // an older version: never the card's name; its own once its meta has come
    expect(viewedFile(card, V1, null).name).toBe('')
    const meta = { versionId: V1, name: 'cut-1.mp4', mimeType: 'video/mp4', kind: 'video' } as const
    expect(viewedFile(card, V1, meta)).toEqual({ kind: 'video', name: 'cut-1.mp4', mimeType: 'video/mp4' })
    // a meta of another version (a late answer) is not used
    expect(viewedFile(card, VER, meta).name).toBe('cut-3.mov')
  })
})
