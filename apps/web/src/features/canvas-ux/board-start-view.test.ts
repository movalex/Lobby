import { describe, expect, it } from 'vitest'
import { parseBoardStartView, START_VIEW_META_KEY, withBoardStartView } from './board-start-view.ts'
import { planStartView, type StartParams } from './start-view.ts'

const view = { pageId: 'page:page', x: -120.5, y: 40, w: 1440, h: 900 }

describe('board start view in document meta', () => {
  it('round-trips, keeping other features’ meta keys', () => {
    const meta = withBoardStartView({ drWorkshop: { hideNoteAuthors: true } }, view)
    expect(meta.drWorkshop).toEqual({ hideNoteAuthors: true })
    expect(parseBoardStartView(meta)).toEqual(view)
    const frame = { ...view, frameId: 'shape:intro' }
    expect(parseBoardStartView(withBoardStartView({}, frame))).toEqual(frame)
  })

  it('clears to null (a nested meta key the sync diff can patch), keeping the rest', () => {
    const meta = withBoardStartView({ other: 1, [START_VIEW_META_KEY]: { ...view } }, null)
    expect(meta).toEqual({ other: 1, [START_VIEW_META_KEY]: null })
    expect(parseBoardStartView(meta)).toBeNull()
  })

  it('reads anything malformed as no start view', () => {
    for (const raw of [
      undefined,
      null,
      'x',
      [],
      { ...view, pageId: 'shape:x' },
      { ...view, pageId: 7 },
      { ...view, w: 0 },
      { ...view, h: -5 },
      { ...view, x: Number.NaN },
      { ...view, y: 1e300 },
      { ...view, x: '0' },
    ]) {
      expect(parseBoardStartView({ [START_VIEW_META_KEY]: raw })).toBeNull()
    }
    expect(parseBoardStartView(null)).toBeNull()
    expect(parseBoardStartView([])).toBeNull()
    // A bad frame id is dropped, the view itself kept.
    expect(parseBoardStartView({ [START_VIEW_META_KEY]: { ...view, frameId: 'page:x' } })).toEqual(view)
  })
})

describe('planStartView with a board start view (PRE-08)', () => {
  const none: StartParams = { templateId: null, deepLink: null }
  const base = {
    params: none,
    canEdit: true,
    boardIsEmpty: false,
    templateIsKnown: false,
    templateAlreadyInserted: false,
    stored: null,
    pageExists: () => true,
  }
  const camera = { pageId: 'page:p', x: 1, y: 2, z: 1 }

  it('first visits (no saved camera) land on it instead of fitting everything', () => {
    expect(planStartView({ ...base, boardStart: view })).toEqual({ kind: 'start-view', view })
  })

  it('a returning person’s own last camera still wins', () => {
    expect(planStartView({ ...base, stored: camera, boardStart: view })).toEqual({ kind: 'restore', camera })
  })

  it('deep links and the dashboard template still win', () => {
    const link = { templateId: null, deepLink: 'sabc' }
    expect(planStartView({ ...base, params: link, boardStart: view }).kind).toBe('deep-link')
    const template = { templateId: 'retrospective', deepLink: null }
    expect(
      planStartView({
        ...base,
        params: template,
        boardIsEmpty: true,
        templateIsKnown: true,
        boardStart: view,
      }).kind,
    ).toBe('template')
  })

  it('a start view on a deleted page falls back to fitting the content', () => {
    expect(planStartView({ ...base, boardStart: view, pageExists: (id) => id !== view.pageId }).kind).toBe(
      'fit',
    )
  })
})
