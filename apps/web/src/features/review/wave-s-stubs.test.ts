// The wave S foundation's web side (docs/WAVE-S-CONTRACTS.md §7): nothing changes for a user. Every switch is off (a
// dev-auth page may turn them on); "My notifications" offers no review kind; the review and version clients answer
// empty and reject writes with 'unavailable' without a request; the review viewer's shell renders nothing while its
// switches are off, and its slots, state and layout are what WS1-WS3 build on.
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
  viewerLayout,
} from '../review-viewer/ViewerHost.tsx'
import { listAssetVersions, supersedesHeader } from '../review-viewer/versions/client.ts'
import { closeReviewViewer, openReviewViewer, reviewViewerRequest } from '../review-viewer/viewer-state.ts'
import {
  addReviewItem,
  closeReviewRound,
  EMPTY_REVIEW,
  getReview,
  listReviewEvents,
  patchReviewItem,
  ReviewRequestError,
  removeReviewItem,
  reviewAvailable,
  setReviewStatus,
  startReviewRound,
} from './client.ts'
import { REVIEW_FLAG_KEYS, REVIEW_FLAGS, reviewFlags, reviewViewerEnabled } from './flags.ts'

const B = 'b-pitch0001'
const AST = 'ast_0123456789abcdefghij'
const VER = 'ver_0123456789abcdefghij'
const RVI = 'rvi_0123456789abcdefghij'

describe('the wave S switches', () => {
  it('ship off, and a production page ignores any override', () => {
    expect(REVIEW_FLAGS).toEqual({ status: false, versions: false, mediaComments: false, reviewPage: false })
    expect(reviewFlags(false, () => '1')).toEqual(REVIEW_FLAGS)
    expect(reviewViewerEnabled(REVIEW_FLAGS)).toBe(false)
  })

  it('a dev-auth page may turn each on or off; a blocked store keeps the shipped value', () => {
    const store: Record<string, string> = { [REVIEW_FLAG_KEYS.versions]: '1', [REVIEW_FLAG_KEYS.status]: '0' }
    const f = reviewFlags(true, (k) => store[k])
    expect(f).toEqual({ status: false, versions: true, mediaComments: false, reviewPage: false })
    expect(reviewViewerEnabled(f)).toBe(true)
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

  const rejectsUnavailable = async (p: Promise<unknown>) => {
    const e = await p.then(
      () => null,
      (err: unknown) => err,
    )
    expect(e).toBeInstanceOf(ReviewRequestError)
    expect((e as ReviewRequestError).code).toBe('unavailable')
  }

  it('review: empty reads, refused writes, no request', async () => {
    expect(reviewAvailable()).toBe(false)
    expect(await getReview(B)).toEqual(EMPTY_REVIEW)
    expect(await listReviewEvents(B, RVI)).toEqual({ events: [], nextBefore: null })
    await rejectsUnavailable(addReviewItem(B, { elementId: 'frame-1', kind: 'frame', label: 'Key art' }))
    await rejectsUnavailable(patchReviewItem(B, RVI, { label: 'x' }))
    await rejectsUnavailable(removeReviewItem(B, RVI))
    await rejectsUnavailable(setReviewStatus(B, RVI, { status: 'approved' }))
    await rejectsUnavailable(startReviewRound(B, {}))
    await rejectsUnavailable(closeReviewRound(B, 'rvr_0123456789abcdefghij'))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('versions: no list, no request; the header Replace media will send', async () => {
    expect(await listAssetVersions(B, AST)).toBeNull()
    expect(supersedesHeader(VER)).toEqual({ 'x-lobby-supersedes': VER })
    expect(fetchSpy).not.toHaveBeenCalled()
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

  it('the host renders nothing while the switches are off, even when asked', () => {
    const registries = createFeatureRegistries()
    const element = {
      id: 'card-1',
      type: 'image',
      isDeleted: false,
      customData: { lobby: { file: { assetId: AST, versionId: VER, kind: 'video', name: 'cut.mov' } } },
    }
    const ctx = { registries, canvas: { get: () => element } } as unknown as CanvasFeatureContext
    openReviewViewer(registries, { elementId: 'card-1', assetId: AST, versionId: VER })
    expect(renderToStaticMarkup(createElement(ReviewViewerHost, { ctx }))).toBe('')
    expect(reviewViewerRequest(registries).get()).not.toBeNull()
  })
})
