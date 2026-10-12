// LobbyCanvas.gesture() (board/handles.ts gestureOf). Wave N.1: with the Hand tool a press reads as a pan only when
// it is on the canvas; a press on the board's chrome (a toolbar button, the selection bar) is a press of the tool.
import { describe, expect, it } from 'vitest'
import { type GestureState, gestureOf } from './handles.ts'

const state = (tool: string, extra: Partial<GestureState> = {}): GestureState => ({
  editingTextElement: null,
  isResizing: false,
  isRotating: false,
  selectedElementsAreBeingDragged: false,
  selectionElement: null,
  newElement: null,
  multiElement: null,
  activeTool: { type: tool },
  ...extra,
})

describe('gestureOf', () => {
  it('the select tool: idle at rest, pressing while the button is down', () => {
    expect(gestureOf(state('selection'), 'idle', null)).toBe('idle')
    expect(gestureOf(state('selection'), 'idle', { down: false, overCanvas: true })).toBe('idle')
    expect(gestureOf(state('selection'), 'idle', { down: true, overCanvas: true })).toBe('pressing')
  })

  it('the engine’s own states win over the pointer, in order', () => {
    const down = { down: true, overCanvas: true }
    expect(gestureOf(state('selection', { isResizing: true }), 'idle', down)).toBe('resizing')
    expect(gestureOf(state('selection', { isRotating: true }), 'idle', down)).toBe('rotating')
    const dragging = state('selection', { selectedElementsAreBeingDragged: true })
    expect(gestureOf(dragging, 'idle', down)).toBe('dragging')
    expect(gestureOf(state('selection', { selectionElement: {} }), 'idle', down)).toBe('box-selecting')
    expect(gestureOf(state('rectangle', { newElement: {} }), 'idle', down)).toBe('drawing')
    expect(gestureOf(state('selection', { editingTextElement: {} }), 'idle', down)).toBe('editing-text')
    expect(gestureOf(state('selection'), 'open', null)).toBe('editing-text')
  })

  it('the Hand tool: a press on the canvas pans; at rest, or a press on the chrome, is the tool', () => {
    expect(gestureOf(state('hand'), 'idle', null)).toBe('tool')
    expect(gestureOf(state('hand'), 'idle', { down: false, overCanvas: true })).toBe('tool')
    expect(gestureOf(state('hand'), 'idle', { down: true, overCanvas: true })).toBe('panning')
    // a press on a toolbar or selection-bar button is not a pan (it hid the bar under the finger, M1-4)
    expect(gestureOf(state('hand'), 'idle', { down: true, overCanvas: false })).toBe('tool')
  })

  it('other tools are the tool, pressed or not', () => {
    for (const tool of ['rectangle', 'laser', 'eraser'])
      for (const down of [false, true])
        expect(gestureOf(state(tool), 'idle', { down, overCanvas: true }), tool).toBe('tool')
  })
})
