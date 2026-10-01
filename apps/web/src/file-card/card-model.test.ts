import type { FileCardShapeProps } from '@draftroom/canvas-schema'
import { describe, expect, it } from 'vitest'
import { derivative, makeMeta } from '../assets/test-fixtures.ts'
import {
  CARD_SIZE,
  cardView,
  changedHints,
  coverDerivative,
  hintPropsFromMeta,
  stripPages,
} from './card-model.ts'

function propsFor(meta: ReturnType<typeof makeMeta>): FileCardShapeProps {
  return {
    ...CARD_SIZE[meta.kind],
    assetId: meta.assetId,
    versionId: meta.versionId,
    kind: meta.kind,
    name: meta.name,
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
    ...hintPropsFromMeta(meta),
  }
}

describe('hint props written by the uploading tab', () => {
  it('produce records the shared server schema accepts, in every state', () => {
    const cover = derivative({ role: 'thumb' })
    const metas = [
      makeMeta({ status: 'queued' }),
      makeMeta({ status: 'processing', attempts: 1 }),
      makeMeta({
        status: 'ready',
        derivatives: [cover, derivative({ role: 'page', page: 1 }), derivative({ role: 'page', page: 2 })],
        probe: {
          width: null,
          height: null,
          pageCount: 12,
          durationMs: null,
          videoCodec: null,
          audioCodec: null,
        },
      }),
      makeMeta({
        kind: 'video',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        status: 'ready',
        derivatives: [derivative({ role: 'poster' }), derivative({ role: 'thumb' })],
        // ffprobe durations are fractional; the schema wants a non-negative integer
        probe: {
          width: 1280,
          height: 720,
          pageCount: null,
          durationMs: 83_456.7,
          videoCodec: 'h264',
          audioCodec: null,
        },
      }),
      makeMeta({
        status: 'failed',
        error: { code: 'PDF_ENCRYPTED', message: 'This PDF is password-protected.' },
      }),
      makeMeta({ kind: 'other', name: 'data.zip', mimeType: 'application/zip', status: 'ready' }),
    ]
    for (const _meta of metas) {
    }
    expect(hintPropsFromMeta(metas[2] as never)).toMatchObject({
      status: 'ready',
      pageCount: 12,
      posterDerivativeId: cover.id,
    })
    expect(hintPropsFromMeta(metas[3] as never)).toMatchObject({ durationMs: 83_457 })
  })

  it('never writes a derivative id that is not a well-formed drv_ id (no URLs in the room)', () => {
    const meta = makeMeta({
      status: 'ready',
      derivatives: [derivative({ role: 'thumb', id: '/files/x/y/d/z?board=b' })],
    })
    expect(hintPropsFromMeta(meta).posterDerivativeId).toBeNull()
  })

  it('patches only fields that changed, so an unchanged poll does not write to the room', () => {
    const meta = makeMeta({ status: 'processing' })
    const props = propsFor(meta)
    expect(changedHints(props, hintPropsFromMeta(meta))).toBeNull()
    expect(changedHints(props, { ...hintPropsFromMeta(meta), status: 'ready', pageCount: 3 })).toEqual({
      status: 'ready',
      pageCount: 3,
    })
  })
})

describe('what a card renders', () => {
  it('prefers server meta over (possibly stale) hint props', () => {
    const meta = makeMeta({ status: 'failed', error: { code: 'PDF_INVALID', message: 'Not a valid PDF.' } })
    const stale = { ...propsFor(makeMeta({ status: 'queued' })), assetId: meta.assetId }
    expect(cardView(stale, meta)).toMatchObject({ status: 'failed', errorMessage: 'Not a valid PDF.' })
    expect(cardView(stale, null)).toMatchObject({ status: 'queued', errorMessage: null })
  })

  it('picks poster/cover images per kind and orders the PDF page strip', () => {
    const poster = derivative({ role: 'poster' })
    expect(
      coverDerivative(
        makeMeta({ kind: 'video', status: 'ready', derivatives: [derivative({ role: 'thumb' }), poster] }),
      ),
    ).toBe(poster)
    expect(coverDerivative(makeMeta({ status: 'processing', derivatives: [poster] }))).toBeNull()
    const p3 = derivative({ role: 'page', page: 3 })
    const p2 = derivative({ role: 'page', page: 2 })
    const pdf = makeMeta({ status: 'ready', derivatives: [p3, derivative({ role: 'page', page: 1 }), p2] })
    expect(stripPages(pdf)).toEqual([p2, p3])
  })
})
