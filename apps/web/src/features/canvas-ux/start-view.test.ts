import { describe, expect, it } from 'vitest'
import {
  boardLinkBase,
  cameraStorageKey,
  fitIfViewportEmpty,
  PHONE_MIN_FRAME_ZOOM,
  PHONE_WIDE_FRAME_ZOOM,
  parseStoredCamera,
  phoneFrameCamera,
  planStartView,
  prefersFirstFrame,
  READABLE_FIT_ZOOM,
  readStartParams,
  type StartParams,
  serializeCamera,
  withoutParams,
} from './start-view.ts'

describe('camera persistence keys', () => {
  it('is per board and per user', () => {
    const a = cameraStorageKey('brd_1', 'usr_a')
    expect(a).toBe('draftroom:camera:v1:usr_a:brd_1')
    expect(cameraStorageKey('brd_1', 'usr_b')).not.toBe(a)
    expect(cameraStorageKey('brd_2', 'usr_a')).not.toBe(a)
  })

  it('round-trips a camera', () => {
    const c = { pageId: 'page:page', x: -120.5, y: 40, z: 0.75 }
    expect(parseStoredCamera(serializeCamera(c))).toEqual(c)
  })

  it('rejects corrupt or hostile values', () => {
    for (const raw of [
      null,
      '',
      'not json',
      '[]',
      '{"pageId":"page:x","x":0,"y":0}',
      '{"pageId":"shape:x","x":0,"y":0,"z":1}',
      '{"pageId":"page:x","x":"0","y":0,"z":1}',
      '{"pageId":"page:x","x":0,"y":0,"z":0}',
      '{"pageId":"page:x","x":0,"y":0,"z":1000}',
      '{"pageId":"page:x","x":1e300,"y":0,"z":1}',
    ]) {
      expect(parseStoredCamera(raw)).toBeNull()
    }
  })
})

describe('URL params', () => {
  it('reads ?template and ?d', () => {
    expect(readStartParams('http://h/b/brd_1?template=storyboard')).toEqual({
      templateId: 'storyboard',
      deepLink: null,
    })
    expect(readStartParams('http://h/b/brd_1?d=sabc')).toEqual({ templateId: null, deepLink: 'sabc' })
    expect(readStartParams('http://h/b/brd_1?template=')).toEqual({ templateId: null, deepLink: null })
  })

  it('removes only the handled params, keeping others and the hash', () => {
    expect(withoutParams('http://h/b/brd_1?template=brainstorm&x=1#top', ['template', 'd'])).toBe(
      '/b/brd_1?x=1#top',
    )
    expect(withoutParams('http://h/b/brd_1?d=s1', ['template', 'd'])).toBe('/b/brd_1')
  })

  it('builds copy-link URLs from the bare board URL', () => {
    expect(boardLinkBase('http://h:5173/b/brd_1?template=x&d=v1.2.3.4#y')).toBe('http://h:5173/b/brd_1')
  })
})

describe('planStartView', () => {
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

  it('inserts the dashboard template on an empty board the user can edit', () => {
    const params = { templateId: 'retrospective', deepLink: null }
    const ok = { ...base, params, boardIsEmpty: true, templateIsKnown: true }
    expect(planStartView(ok)).toEqual({ kind: 'template', templateId: 'retrospective' })
    // not on a board that already has content (someone else got there first, or a reload)
    expect(planStartView({ ...ok, boardIsEmpty: false }).kind).toBe('fit')
    // not for viewers/commenters
    expect(planStartView({ ...ok, canEdit: false }).kind).toBe('none')
    // not twice in this tab
    expect(planStartView({ ...ok, templateAlreadyInserted: true }).kind).toBe('none')
    // not for unknown ids (e.g. "blank")
    expect(planStartView({ ...ok, templateIsKnown: false }).kind).toBe('none')
  })

  it('prefers a deep link over the saved camera', () => {
    expect(
      planStartView({ ...base, params: { templateId: null, deepLink: 'sabc' }, stored: camera }),
    ).toEqual({
      kind: 'deep-link',
      deepLink: 'sabc',
    })
  })

  it('restores the saved camera when its page still exists', () => {
    expect(planStartView({ ...base, stored: camera })).toEqual({ kind: 'restore', camera })
    expect(planStartView({ ...base, stored: camera, pageExists: () => false }).kind).toBe('fit')
  })

  it('fits content when there is no saved camera, and leaves an empty board alone', () => {
    expect(planStartView(base).kind).toBe('fit')
    expect(planStartView({ ...base, boardIsEmpty: true }).kind).toBe('none')
  })

  it('never leaves an empty viewport when content exists', () => {
    expect(fitIfViewportEmpty(false, true)).toBe(true)
    expect(fitIfViewportEmpty(true, true)).toBe(false)
    expect(fitIfViewportEmpty(false, false)).toBe(false)
  })
})

describe('prefersFirstFrame (F15: what "fit all content" shows where the whole page is unreadable)', () => {
  // The Lobby tour: six 1600 x 1000 frames in one 10,400 x 1,268 row.
  const tour = { w: 10_400, h: 1_268 }
  const minZoom = 0.05

  it('a phone-sized canvas (a 390 px phone minus the dock rail) opens on the first frame', () => {
    expect(prefersFirstFrame({ screen: { w: 345, h: 796 }, content: tour, minZoom, hasFrame: true })).toBe(
      true,
    )
    const small = { w: 300, h: 200 }
    expect(prefersFirstFrame({ screen: { w: 480, h: 700 }, content: small, minZoom, hasFrame: true })).toBe(
      true,
    )
  })

  it('DANA-06: a desktop opens on the first frame when the whole page only fits unreadably small (the tour at about 9-12 %)', () => {
    expect(prefersFirstFrame({ screen: { w: 1395, h: 852 }, content: tour, minZoom, hasFrame: true })).toBe(
      true,
    )
    // The Retrospective (a 2,560 px row over three frames) fits at about 40 %: still too small.
    const retro = { w: 2_560, h: 1_600 }
    expect(prefersFirstFrame({ screen: { w: 1235, h: 700 }, content: retro, minZoom, hasFrame: true })).toBe(
      true,
    )
  })

  it('a desktop keeps "fit all" while the whole page is readable (at least READABLE_FIT_ZOOM)', () => {
    const twoFrames = { w: 1_500, h: 700 }
    expect(READABLE_FIT_ZOOM).toBe(0.5)
    expect(
      prefersFirstFrame({ screen: { w: 1395, h: 852 }, content: twoFrames, minZoom, hasFrame: true }),
    ).toBe(false)
  })

  it('a desktop gets the first frame when even the smallest zoom would clip the content', () => {
    const huge = { w: 60_000, h: 2_000 }
    expect(prefersFirstFrame({ screen: { w: 1395, h: 852 }, content: huge, minZoom, hasFrame: true })).toBe(
      true,
    )
  })

  it('without a frame (or with no screen size yet) it stays "fit all"', () => {
    expect(prefersFirstFrame({ screen: { w: 345, h: 796 }, content: tour, minZoom, hasFrame: false })).toBe(
      false,
    )
    expect(prefersFirstFrame({ screen: { w: 0, h: 0 }, content: tour, minZoom, hasFrame: true })).toBe(false)
  })
})

describe('phoneFrameCamera (R13: a frame far wider than a phone)', () => {
  const screen = { w: 345, h: 700 }
  const inset = 16
  const toScreen = (c: { x: number; y: number; z: number }, p: { x: number; y: number }) => ({
    x: (p.x + c.x) * c.z,
    y: (p.y + c.y) * c.z,
  })

  it('the tour’s 1,600 px frames still fit whole (about 20 %)', () => {
    expect(phoneFrameCamera({ x: 0, y: 0, w: 1600, h: 1000 }, screen, inset)).toBeNull()
  })

  it('the Retrospective’s 2,560 x 420 Check-in opens at its left end at a readable zoom, centred vertically', () => {
    const frame = { x: 100, y: -200, w: 2560, h: 420 }
    const c = phoneFrameCamera(frame, screen, inset)
    if (!c) throw new Error('expected a camera')
    expect(c.z).toBe(PHONE_WIDE_FRAME_ZOOM)
    expect(c.z).toBeGreaterThan(PHONE_MIN_FRAME_ZOOM)
    const topLeft = toScreen(c, { x: frame.x, y: frame.y })
    expect(topLeft.x).toBeCloseTo(inset)
    const mid = toScreen(c, { x: frame.x, y: frame.y + frame.h / 2 })
    expect(mid.y).toBeCloseTo(screen.h / 2)
  })

  it('a very tall and wide frame opens at a zoom that still fits its height, never below the minimum', () => {
    const c = phoneFrameCamera({ x: 0, y: 0, w: 20_000, h: 6_000 }, screen, inset)
    expect(c?.z).toBe(PHONE_MIN_FRAME_ZOOM)
  })
})
