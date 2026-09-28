import { describe, expect, it } from 'vitest'
import { classifyDoubleClick, type DblClickElement, type DblClickView } from './dblclick.ts'

const el = (id: string, type: string, extra: Partial<DblClickElement> = {}): DblClickElement => ({
  id,
  type,
  groupIds: [],
  ...extra,
})

const base: DblClickView = {
  interactionEnabled: true,
  editingText: false,
  drawingMultiElement: false,
  activeToolType: 'selection',
  preferredSelectionToolType: 'selection',
  selected: [],
  selectedLinear: null,
  selectedGroupIds: [],
  hit: null,
  ctrlOrCmd: false,
}

describe('classifyDoubleClick (mirrors handleCanvasDoubleClick, index.js:44726-44871)', () => {
  it('stops the double-clicks that open the text editor: a note, a shape, empty canvas', () => {
    expect(classifyDoubleClick({ ...base, hit: el('n', 'stickynote') })).toEqual({ kind: 'text' })
    expect(
      classifyDoubleClick({ ...base, selected: [el('n', 'stickynote')], hit: el('n', 'stickynote') }),
    ).toEqual({
      kind: 'text',
    })
    expect(classifyDoubleClick(base)).toEqual({ kind: 'text' })
  })

  it('a plain double-click on a selected simple arrow is a text path (its label), not the linear editor', () => {
    const arrow = el('a', 'arrow')
    expect(classifyDoubleClick({ ...base, selected: [arrow], hit: arrow })).toEqual({ kind: 'text' })
  })

  it('forwards Ctrl+double-click on a simple arrow and any double-click on a line (linear editor)', () => {
    const arrow = el('a', 'arrow')
    expect(classifyDoubleClick({ ...base, selected: [arrow], hit: arrow, ctrlOrCmd: true })).toEqual({
      kind: 'forward',
      reason: 'linear-editor',
    })
    const line = el('l', 'line')
    expect(classifyDoubleClick({ ...base, selected: [line], hit: line })).toEqual({
      kind: 'forward',
      reason: 'linear-editor',
    })
    // A line already in its editor: Excalidraw returns (nothing).
    expect(
      classifyDoubleClick({ ...base, selected: [line], selectedLinear: { elementId: 'l', isEditing: true } })
        .kind,
    ).toBe('forward')
  })

  it('forwards entering a selected group, an image crop, an elbow-arrow segment edit', () => {
    const r = el('r', 'rectangle', { groupIds: ['g1'] })
    expect(
      classifyDoubleClick({
        ...base,
        selected: [r, el('r2', 'rectangle')],
        selectedGroupIds: ['g1'],
        hit: r,
      }),
    ).toEqual({
      kind: 'forward',
      reason: 'enter-group',
    })
    expect(classifyDoubleClick({ ...base, selected: [el('i', 'image')] })).toEqual({
      kind: 'forward',
      reason: 'crop',
    })
    const elbow = el('e', 'arrow', { elbowed: true })
    expect(
      classifyDoubleClick({
        ...base,
        selected: [elbow],
        selectedLinear: { elementId: 'e', isEditing: false },
      }),
    ).toEqual({ kind: 'forward', reason: 'elbow-segment' })
  })

  it('a selected group that the pointer is NOT on falls through to text editing', () => {
    expect(
      classifyDoubleClick({
        ...base,
        selectedGroupIds: ['g1'],
        hit: el('n', 'stickynote', { groupIds: ['g2'] }),
      }),
    ).toEqual({ kind: 'text' })
  })

  it('forwards when Excalidraw would do nothing: editor open, non-interactive, custom tool, drawing', () => {
    expect(classifyDoubleClick({ ...base, editingText: true }).kind).toBe('forward')
    expect(classifyDoubleClick({ ...base, interactionEnabled: false }).kind).toBe('forward')
    expect(classifyDoubleClick({ ...base, activeToolType: 'custom' }).kind).toBe('forward')
    expect(classifyDoubleClick({ ...base, drawingMultiElement: true }).kind).toBe('forward')
    expect(classifyDoubleClick({ ...base, selectedLinear: { elementId: 'x', isEditing: true } }).kind).toBe(
      'forward',
    )
  })

  it('autoshape double-clicks are text paths (P8; Lobby never activates autoshape anyway)', () => {
    expect(classifyDoubleClick({ ...base, activeToolType: 'autoshape' })).toEqual({ kind: 'text' })
  })
})
