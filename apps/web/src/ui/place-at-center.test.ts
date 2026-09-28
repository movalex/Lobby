import { describe, expect, it } from 'vitest'
import { type PlaceKeyState, placedSize, placeOnEnter } from './place-at-center.ts'

const idle = (path: string, over: Partial<PlaceKeyState> = {}): PlaceKeyState => ({
  onBoard: true,
  readonly: false,
  editing: false,
  menusOpen: false,
  modalOpen: false,
  path,
  onlySelectedType: null,
  ...over,
})
const enter = { key: 'Enter' }

describe('A11Y-07: Enter places the picked tool', () => {
  it('places a note, a shape or a text from their tools', () => {
    expect(placeOnEnter(enter, idle('note.idle'))).toBe('note')
    expect(placeOnEnter(enter, idle('geo.idle'))).toBe('geo')
    expect(placeOnEnter(enter, idle('text.idle'))).toBe('text')
    // A note selected while the note tool is picked still gets a new note (tldraw does nothing there).
    expect(placeOnEnter(enter, idle('note.idle', { onlySelectedType: 'note' }))).toBe('note')
  })

  it('leaves every other Enter alone', () => {
    // Select tool: canvas-ux edits the selected note or renames the frame.
    expect(placeOnEnter(enter, idle('select.idle'))).toBeNull()
    expect(placeOnEnter(enter, idle('draw.idle'))).toBeNull()
    expect(placeOnEnter(enter, idle('note.pointing'))).toBeNull()
    // tldraw's own: Enter in the shape tool edits the selected shape's label.
    expect(placeOnEnter(enter, idle('geo.idle', { onlySelectedType: 'geo' }))).toBeNull()
    for (const over of [
      { onBoard: false },
      { readonly: true },
      { editing: true },
      { menusOpen: true },
      { modalOpen: true },
    ])
      expect(placeOnEnter(enter, idle('note.idle', over)), JSON.stringify(over)).toBeNull()
  })

  it('only plain Enter (not with modifiers, not mid-composition, not other keys)', () => {
    const s = idle('note.idle')
    expect(placeOnEnter({ key: 'Enter', ctrlKey: true }, s)).toBeNull()
    expect(placeOnEnter({ key: 'Enter', metaKey: true }, s)).toBeNull()
    expect(placeOnEnter({ key: 'Enter', shiftKey: true }, s)).toBeNull()
    expect(placeOnEnter({ key: 'Enter', altKey: true }, s)).toBeNull()
    expect(placeOnEnter({ key: 'Enter', isComposing: true }, s)).toBeNull()
    expect(placeOnEnter({ key: ' ' }, s)).toBeNull()
  })

  it('sizes: a note is a note; shapes and text follow the resize scale', () => {
    expect(placedSize('note', 2)).toEqual({ w: 200, h: 200 })
    expect(placedSize('geo', 1)).toEqual({ w: 200, h: 200 })
    expect(placedSize('geo', 0.5)).toEqual({ w: 100, h: 100 })
    expect(placedSize('text', 1).h).toBeGreaterThan(0)
  })
})
