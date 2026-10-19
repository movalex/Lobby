import { describe, expect, it } from 'vitest'
import { PANEL_TEXT_EDITORS, panelEditorTarget } from './dblclick.ts'
import { DOUBLE_TAP_POSITION_THRESHOLD, DoubleTapMirror, TAP_TWICE_TIMEOUT } from './doubleTap.ts'

const one = (time: number, x: number, y: number) => ({ time, touches: [{ clientX: x, clientY: y }] })
const two = (time: number) => ({
  time,
  touches: [
    { clientX: 10, clientY: 10 },
    { clientX: 200, clientY: 200 },
  ],
})

describe('DoubleTapMirror (mirrors App.onTouchStart, index.js:43477-43517)', () => {
  it("uses Excalidraw's thresholds", () => {
    expect(TAP_TWICE_TIMEOUT).toBe(300)
    expect(DOUBLE_TAP_POSITION_THRESHOLD).toBe(35)
  })

  it('reports the second one-finger tap within 300 ms and 35 px', () => {
    const m = new DoubleTapMirror()
    expect(m.onTouchStart(one(0, 100, 100)).kind).toBe('pass')
    expect(m.onTouchStart(one(200, 120, 110))).toEqual({ kind: 'double', clientX: 120, clientY: 110 })
  })

  it('passes a second tap after the timeout (Excalidraw reset its state) and starts a new pair', () => {
    const m = new DoubleTapMirror()
    m.onTouchStart(one(0, 100, 100))
    expect(m.onTouchStart(one(300, 100, 100)).kind).toBe('pass')
    expect(m.onTouchStart(one(450, 101, 101)).kind).toBe('double')
  })

  it('passes a far second tap and ends the pair (didTapTwice = false)', () => {
    const m = new DoubleTapMirror()
    m.onTouchStart(one(0, 100, 100))
    expect(m.onTouchStart(one(100, 100 + 36, 100)).kind).toBe('pass')
    // Excalidraw: that tap ended the pair, so the next one is a FIRST tap again.
    expect(m.onTouchStart(one(150, 136, 100)).kind).toBe('pass')
    expect(m.onTouchStart(one(200, 136, 100)).kind).toBe('double')
  })

  it('lets pinch and pan (two fingers) through without ending the pair', () => {
    const m = new DoubleTapMirror()
    m.onTouchStart(one(0, 100, 100))
    expect(m.onTouchStart(two(50)).kind).toBe('pass')
    expect(m.onTouchStart(one(100, 100, 100)).kind).toBe('double')
  })

  it('after a swallowed double, a third quick tap near the first pairs again (Excalidraw state did not advance)', () => {
    const m = new DoubleTapMirror()
    m.onTouchStart(one(0, 100, 100))
    expect(m.onTouchStart(one(100, 100, 100)).kind).toBe('double')
    expect(m.onTouchStart(one(200, 100, 100)).kind).toBe('double')
    expect(m.onTouchStart(one(301, 100, 100)).kind).toBe('pass')
  })

  it('a two-finger first touch records no position, so a following tap cannot pair', () => {
    const m = new DoubleTapMirror()
    expect(m.onTouchStart(two(0)).kind).toBe('pass')
    expect(m.onTouchStart(one(50, 10, 10)).kind).toBe('pass')
  })
})

describe('the panel editors take a double-tap on what they own (wave W, the guard list)', () => {
  it('the swallowed double on a doc card (or its label) is the doc card panel, never the engine editor', () => {
    const card = { id: 'card', type: 'rectangle', customData: { lobby: { kind: 'doc-card' } } }
    const label = { id: 'card.t', type: 'text', containerId: 'card' }
    const get = (id: string) => [card, label].find((e) => e.id === id)
    const m = new DoubleTapMirror()
    m.onTouchStart(one(0, 100, 100))
    const second = m.onTouchStart(one(120, 104, 102))
    expect(second.kind).toBe('double')
    // what CanvasInput.runDoubleTap offers the features first: the element under the tap
    for (const hit of [card, label])
      expect(panelEditorTarget(hit, get)).toEqual({ editor: 'doc-card-panel', id: 'card' })
    expect(PANEL_TEXT_EDITORS.find((e) => e.id === 'doc-card-panel')?.opens).toContain('double-tap')
  })
})
