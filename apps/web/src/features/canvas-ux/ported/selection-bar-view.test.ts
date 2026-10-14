// The selection bar's view (./SelectionBar.tsx selectionBarView): when the bar is drawn, and its anchor. Wave M
// (M1-4): with the Hand tool (a phone's first tool) a press reads as a pan wherever it lands, so a tap on the bar's
// own buttons hid the bar under the finger and the tap was lost; only a pan that starts on the canvas hides it. Wave
// N.1: the canvas's gesture() now says so itself (a Hand press off the canvas is 'tool', board/gesture.test.ts), so the
// bar needs no look at the pointer.
import { describe, expect, it } from 'vitest'
import {
  type CanvasFeatureContext,
  type CanvasGesture,
  createFeatureRegistries,
} from '../../../canvas/api/index.ts'
import { FRAME_NAME_BAND_PX } from './FrameRename.tsx'
import { selectionBarView } from './SelectionBar.tsx'

function ctxWith(
  gesture: CanvasGesture,
  pointer: { overCanvas: boolean; down: boolean } | null,
  type = 'stickynote',
) {
  const registries = createFeatureRegistries()
  registries.selectionBar.register({ id: 'x.item', order: 10, component: () => null })
  const canvas = {
    selection: ['n1'],
    get: (id: string) => (id === 'n1' ? { id, type } : undefined),
    editingId: () => null,
    gesture: () => gesture,
    pointer: () => pointer,
    boundsOf: () => ({ x: 100, y: 100, width: 200, height: 100 }),
    viewport: { screenRect: () => ({ x: 0, y: 0, width: 1000, height: 800 }) },
    sceneToOverlay: (p: { x: number; y: number }) => p,
  }
  return { canvas, registries } as unknown as CanvasFeatureContext
}

describe('selectionBarView', () => {
  it('is drawn while idle, pressing or with a tool, its anchor the selection’s box', () => {
    for (const g of ['idle', 'pressing', 'tool'] as const) {
      const v = selectionBarView(ctxWith(g, null))
      expect(v?.anchor, g).toEqual({ x: 100, y: 100, w: 200, h: 100 })
    }
    expect(selectionBarView(ctxWith('dragging', null))).toBeNull()
    expect(selectionBarView(ctxWith('resizing', null))).toBeNull()
  })

  it('P-040: a selected frame’s name (drawn above it) counts as part of the selection: the bar keeps clear of it', () => {
    expect(selectionBarView(ctxWith('idle', null, 'frame'))?.anchor).toEqual({
      x: 100,
      y: 100 - FRAME_NAME_BAND_PX,
      w: 200,
      h: 100 + FRAME_NAME_BAND_PX,
    })
  })

  it('M1-4: a press on the bar with the Hand tool (a press of the tool) keeps it; a pan on the canvas hides it', () => {
    expect(selectionBarView(ctxWith('tool', { overCanvas: false, down: true }))).not.toBeNull()
    expect(selectionBarView(ctxWith('panning', { overCanvas: true, down: true }))).toBeNull()
    expect(selectionBarView(ctxWith('panning', null))).toBeNull()
  })
})
