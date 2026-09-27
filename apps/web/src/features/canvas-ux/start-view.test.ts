import { describe, expect, it } from 'vitest'
import {
  boardLinkBase,
  cameraStorageKey,
  fitIfViewportEmpty,
  parseStoredCamera,
  planStartView,
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
