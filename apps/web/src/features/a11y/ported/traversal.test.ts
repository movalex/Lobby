import { describe, expect, it } from 'vitest'
import { type Bounds, type LobbyCanvas, NotImplementedError } from '../../../canvas/api/index.ts'
import { sheetTools } from './PhoneSheet.tsx'
import { frame, input, note } from './test-kit.ts'
import {
  bringIntoView,
  enterCanvas,
  isOnScreen,
  selectAdjacent,
  selectFirstChild,
  selectParent,
} from './traversal.ts'

/** Just enough of a LobbyCanvas for traversal: elements, selection, a camera, and 3b's stub (or not). */
function fakeCanvas(elements = board(), opts: { ensureVisible?: boolean } = {}) {
  const level = input(elements)
  const state = {
    selection: [] as string[],
    view: { x: 0, y: 0, width: 1600, height: 900, zoom: 1 },
    focused: 0,
    sets: [] as { x?: number; y?: number }[],
    ensured: [] as string[][],
  }
  const canvas = {
    items: () => elements.filter((e) => !(e as { isDeleted?: boolean }).isDeleted),
    get: (id: string) => elements.find((e) => e.id === id),
    bounds: (id: string) => level.bounds(id),
    boundsOf: (ids: readonly string[]) => {
      const bs = ids.map((id) => level.bounds(id)).filter((b): b is Bounds => !!b)
      if (!bs.length) return null
      const x = Math.min(...bs.map((b) => b.x))
      const y = Math.min(...bs.map((b) => b.y))
      return {
        x,
        y,
        width: Math.max(...bs.map((b) => b.x + b.width)) - x,
        height: Math.max(...bs.map((b) => b.y + b.height)) - y,
      }
    },
    isHidden: () => false,
    get selection() {
      return state.selection
    },
    select: (ids: readonly string[]) => {
      state.selection = [...ids]
    },
    focus: () => {
      state.focused++
    },
    viewport: {
      get: () => state.view,
      set: (v: { x?: number; y?: number }) => {
        state.sets.push(v)
        state.view = { ...state.view, ...v }
      },
      ensureVisible: (ids: readonly string[]) => {
        if (!opts.ensureVisible) throw new NotImplementedError('3b', 'viewport.ensureVisible')
        state.ensured.push([...ids])
      },
    },
  } as unknown as LobbyCanvas
  return { canvas, state }
}

function board() {
  return [
    frame('f', 0, 0, 800, 500, 'Retro'),
    ...note('in-a', 100, 100, 'A', { frameId: 'f' }),
    ...note('in-b', 400, 100, 'B', { frameId: 'f' }),
    ...note('loose', 1000, 100, 'Loose'),
    ...note('far', 5000, 3000, 'Far away'),
  ]
}

describe('keyboard traversal', () => {
  it('Alt+Arrow walks the top level in reading order and wraps', () => {
    const { canvas, state } = fakeCanvas()
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      expect(selectAdjacent(canvas, 'next')).toBe(true)
      seen.push(state.selection.join())
    }
    expect(seen).toEqual(['f', 'loose', 'far', 'f'])
    selectAdjacent(canvas, 'prev')
    expect(state.selection).toEqual(['far'])
  })

  it('inside a frame, Alt+Arrow walks the frame; Ctrl+Shift+Down goes in and Ctrl+Shift+Up comes out', () => {
    const { canvas, state } = fakeCanvas()
    state.selection = ['f']
    expect(selectFirstChild(canvas)).toBe(true)
    expect(state.selection).toEqual(['in-a'])
    selectAdjacent(canvas, 'next')
    expect(state.selection).toEqual(['in-b'])
    selectAdjacent(canvas, 'next')
    expect(state.selection).toEqual(['in-a'])
    expect(selectParent(canvas)).toBe(true)
    expect(state.selection).toEqual(['f'])
    // nothing to go into or out of
    state.selection = ['loose']
    expect(selectFirstChild(canvas)).toBe(false)
    expect(selectParent(canvas)).toBe(false)
    expect(state.selection).toEqual(['loose'])
  })

  it('entering the canvas focuses it and selects the first item when nothing is selected', () => {
    const { canvas, state } = fakeCanvas()
    expect(enterCanvas(canvas)).toBe(true)
    expect(state.focused).toBe(1)
    expect(state.selection).toEqual(['f'])
    state.selection = ['loose']
    enterCanvas(canvas)
    expect(state.selection).toEqual(['loose'])
    const empty = fakeCanvas([])
    expect(enterCanvas(empty.canvas)).toBe(false)
    expect(empty.state.focused).toBe(1)
  })

  it("brings an item into view through 3b's ensureVisible, or re-centres while it is a stub", () => {
    const stub = fakeCanvas()
    bringIntoView(stub.canvas, ['loose'])
    expect(stub.state.sets).toEqual([]) // already on screen
    bringIntoView(stub.canvas, ['far'])
    expect(stub.state.sets).toEqual([{ x: 5100 - 800, y: 3100 - 450 }])
    const real = fakeCanvas(board(), { ensureVisible: true })
    bringIntoView(real.canvas, ['far'])
    expect(real.state.ensured).toEqual([['far']])
    expect(real.state.sets).toEqual([])
  })

  it('on screen means inside the view, a margin in (or filling it)', () => {
    const v = { x: 0, y: 0, width: 1000, height: 800 }
    expect(isOnScreen({ x: 100, y: 100, width: 100, height: 100 }, v, 64)).toBe(true)
    expect(isOnScreen({ x: 10, y: 100, width: 100, height: 100 }, v, 64)).toBe(false)
    expect(isOnScreen({ x: 0, y: 0, width: 1000, height: 800 }, v, 64)).toBe(true)
    expect(isOnScreen({ x: 900, y: 0, width: 300, height: 100 }, v, 0)).toBe(false)
  })
})

describe('the phone sheet', () => {
  const tool = (id: string, readOnlyAllowed: boolean, group?: 'main' | 'more', order = 0) =>
    ({
      id,
      label: id,
      readOnlyAllowed,
      ...(group ? { toolbar: { group, order, icon: () => null } } : {}),
    }) as never

  it("lists the role's built-in tools, then the features' toolbar tools (main before more)", () => {
    const features = [tool('vote', true, 'more', 1), tool('comment', true, 'main', 5), tool('hidden', true)]
    const edit = sheetTools(false, features).map((t) => t.id)
    expect(edit.slice(0, 8)).toEqual([
      'select',
      'hand',
      'note',
      'text',
      'rectangle',
      'freedraw',
      'arrow',
      'frame',
    ])
    expect(edit.slice(-2)).toEqual(['comment', 'vote'])
    expect(edit).not.toContain('hidden')
    expect(sheetTools(true, [...features, tool('open-card', false, 'main')]).map((t) => t.id)).toEqual([
      'select',
      'hand',
      'laser',
      'comment',
      'vote',
    ])
  })
})
