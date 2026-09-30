// OWNER: 3f. Dot voting on the canvas (Excalidraw page): what a press votes on, the keyboard order,
// the markers' corners, the camera fallbacks and the session settings.
import { describe, expect, it } from 'vitest'
import { NotImplementedError } from '../../../canvas/api/index.ts'
import { ensureVisible, followingNow, onFollowChanged, startFollowing, zoomToBounds } from './camera.ts'
import { parseWorkshopDoc, workshopSettingsOf, writeWorkshopSettings } from './session-settings.ts'
import { el, fakeCanvas, note } from './test-kit.ts'
import { cornersOf, eligibleAt, eligibleInOrder, selectEligible, selectedEligible } from './voting-canvas.ts'

const board = { scope: 'board' as const, frameId: null, shapeTypes: null }

function board3() {
  return fakeCanvas([
    ...note('a', 'Alpha', { x: 0, y: 0 }),
    ...note('b', 'Beta', { x: 260, y: 0 }),
    ...note('c', 'Gamma', { x: 0, y: 300 }),
    el('arrow', 'arrow', { x: 0, y: 0, width: 600, height: 600 }),
  ])
}

describe('click-to-vote targets', () => {
  it('the topmost element the vote accepts, never a label or an arrow', () => {
    const f = board3()
    expect(eligibleAt(f.canvas, { x: 50, y: 50 }, board)?.id).toBe('a')
    expect(eligibleAt(f.canvas, { x: 300, y: 50 }, board)?.id).toBe('b')
    expect(eligibleAt(f.canvas, { x: 590, y: 590 }, board)).toBeNull()
    expect(eligibleAt(f.canvas, { x: 50, y: 50 }, { ...board, shapeTypes: ['geo'] })).toBeNull()
  })

  it('keyboard order is reading order; Tab selects the next one without wrapping', () => {
    const f = board3()
    expect(eligibleInOrder(f.canvas, board)).toEqual(['a', 'b', 'c'])
    expect(selectedEligible(f.canvas, board)).toBeNull()
    expect(selectEligible(f.canvas, board, 1)).toBe(true)
    expect(f.selection).toEqual(['a'])
    expect(selectedEligible(f.canvas, board)).toBe('a')
    expect(selectEligible(f.canvas, board, 1)).toBe(true)
    expect(selectEligible(f.canvas, board, 1)).toBe(true)
    expect(f.selection).toEqual(['c'])
    expect(selectEligible(f.canvas, board, 1)).toBe(false)
    expect(selectEligible(f.canvas, board, -1)).toBe(true)
    expect(f.selection).toEqual(['b'])
    f.selection = ['arrow']
    expect(selectedEligible(f.canvas, board)).toBeNull()
  })

  it('markers sit on the top-right corner, in overlay pixels, for live objects only', () => {
    const f = board3()
    f.viewport = { x: -100, y: -50, width: 500, height: 400, zoom: 2 }
    expect(cornersOf(f.canvas, ['shape:a', 'shape:nope', 'bad'])).toEqual([
      { ref: 'shape:a', id: 'a', x: 600, y: 100 },
    ])
  })
})

describe('the camera without 3b and 3c', () => {
  it('zoomToBounds fits the bounds (tldraw targetZoom caps it), centred', () => {
    const f = fakeCanvas()
    f.viewport = { x: 0, y: 0, width: 1000, height: 800, zoom: 1 }
    zoomToBounds(f.canvas, { x: 1000, y: 1000, width: 200, height: 100 }, { maxZoom: 1 })
    expect(f.moves.at(-1)).toMatchObject({ zoom: 1, x: 600, y: 650 })
    zoomToBounds(f.canvas, { x: 0, y: 0, width: 4000, height: 1000 }, { inset: 0 })
    expect(f.viewport.zoom).toBeCloseTo(0.25)
  })

  it('ensureVisible moves only for something off screen', () => {
    const f = fakeCanvas()
    ensureVisible(f.canvas, { x: 400, y: 300, width: 100, height: 100 })
    expect(f.moves).toHaveLength(0)
    ensureVisible(f.canvas, { x: 5000, y: 300, width: 100, height: 100 })
    expect(f.moves).toHaveLength(1)
  })

  it('follow stubs read as not following, and cannot start', () => {
    const f = fakeCanvas()
    expect(followingNow(f.canvas)).toBeNull()
    expect(startFollowing(f.canvas, 'sid')).toBe(false)
    const stubbed = {
      on: () => {
        throw new NotImplementedError('3c', 'on:followChanged')
      },
    }
    expect(typeof onFollowChanged(stubbed as never, () => {})).toBe('function')
  })
})

describe('session settings (lb_doc workshop)', () => {
  it('parses leniently and writes the whole value', () => {
    expect(parseWorkshopDoc(null)).toEqual({ hideNoteAuthors: false, hideCursors: false })
    expect(parseWorkshopDoc({ hideCursors: true, x: 1 })).toEqual({
      hideNoteAuthors: false,
      hideCursors: true,
    })
    const f = fakeCanvas()
    writeWorkshopSettings(f.canvas, { hideNoteAuthors: true })
    expect(f.doc.workshop).toEqual({ hideNoteAuthors: true, hideCursors: false })
    writeWorkshopSettings(f.canvas, { hideCursors: true })
    expect(workshopSettingsOf(f.canvas)).toEqual({ hideNoteAuthors: true, hideCursors: true })
  })
})
