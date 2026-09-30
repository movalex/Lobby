// OWNER: 3a. The toolbar's layout by canvas width (./toolbar-layout.ts), against tldraw's own rules.
import { describe, expect, it } from 'vitest'
import { historyChordOf } from './chrome-keys.ts'
import { modulate, planToolbar, type ToolbarRoom, tldrawItemsToShow } from './toolbar-layout.ts'

// the editor's toolbar on the Excalidraw page: 12 main slots (8 tools, Media, Comment, a feature's, Templates)
const MAIN = [
  'select',
  'hand',
  'note',
  'text',
  'rectangle',
  'freedraw',
  'arrow',
  'frame',
  'asset',
  'comment',
  'mindmap',
  'dr-templates',
]
const MORE = ['eraser', 'ellipse', 'diamond', 'line', 'highlight', 'laser', 'lasso']
const ORDERED = [...MAIN, ...MORE]

const room = (width: number, left = 12): ToolbarRoom => ({ width, left, right: 12 })
const plan = (width: number, lastUsed: string | null = null, left = 12, editor = true) =>
  planToolbar({
    ordered: ORDERED,
    mainCount: MAIN.length,
    lastUsed,
    room: room(width, left),
    editor,
    styles: true,
  })

describe("tldraw's overflow rule", () => {
  it('modulates 5 items at 320 px up to every main item at 560 px', () => {
    expect(modulate(440, [320, 560], [5, 12])).toBeCloseTo(8.5)
    expect(tldrawItemsToShow(300, 12)).toBe(5)
    expect(tldrawItemsToShow(390, 12)).toBe(7)
    expect(tldrawItemsToShow(560, 12)).toBe(12)
    expect(tldrawItemsToShow(1400, 12)).toBe(12)
  })
})

describe('planToolbar', () => {
  it('on a desktop canvas: every main tool, the eraser in the extra slot, the rest in More; quick actions by the menu', () => {
    const p = plan(1395)
    expect(p.shown).toEqual([...MAIN, 'eraser'])
    expect(p.more).toEqual(MORE.slice(1))
    expect(p.quickOnToolbar).toBe(false)
    expect(p.stylesButton).toBe(false)
    expect(p.shift).toBe(0)
  })

  it('the overflow tool used last takes the extra slot, and the main tools never move', () => {
    const p = plan(1395, 'ellipse')
    expect(p.shown).toEqual([...MAIN, 'ellipse'])
    expect(p.more).toEqual(MORE.filter((t) => t !== 'ellipse'))
  })

  it('at 840 px or less the quick actions sit on the toolbar; at 640 px or less a Styles button joins it', () => {
    expect(plan(841).quickOnToolbar).toBe(false)
    expect(plan(840).quickOnToolbar).toBe(true)
    expect(plan(700).stylesButton).toBe(false)
    expect(plan(640).stylesButton).toBe(true)
    // read-only roles get neither
    expect(plan(390, null, 12, false).quickOnToolbar).toBe(false)
    expect(plan(390, null, 12, false).stylesButton).toBe(false)
  })

  it('on a phone the tools that fit beside the zoom button show, in order, and the rest wait in More', () => {
    // 390 px, the navigation slot's fit button ends at 52 px: 390 - 58 - 12 - 46 (Styles) = 274 px
    const p = plan(390, null, 58)
    expect(p.shown).toEqual(MAIN.slice(0, 5))
    expect(p.more[0]).toBe('freedraw')
    expect(p.more).toHaveLength(ORDERED.length - 5)
    // the bar (5 tools, More, Styles) moves right to clear the zoom button, and stays inside the canvas
    const width = 6 * 40 + 8 + 46
    expect(390 / 2 - width / 2 + p.shift).toBeGreaterThanOrEqual(58)
    expect(390 / 2 + width / 2 + p.shift).toBeLessThanOrEqual(390 - 12)
  })

  it('a tool picked from More on a phone takes the last slot', () => {
    const p = plan(390, 'frame', 58)
    expect(p.shown).toEqual([...MAIN.slice(0, 4), 'frame'])
    expect(p.more).toContain('rectangle')
    expect(p.more).not.toContain('frame')
  })

  it('a viewer’s few tools all show, with no More', () => {
    const p = planToolbar({
      ordered: ['select', 'hand', 'comment'],
      mainCount: 3,
      lastUsed: null,
      room: room(390, 58),
      editor: false,
      styles: true,
    })
    expect(p.shown).toEqual(['select', 'hand', 'comment'])
    expect(p.more).toEqual([])
    expect(p.shift).toBe(0)
  })
})

describe('the history keys from the chrome (./chrome-keys.ts)', () => {
  const key = (
    code: string,
    mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {},
  ) => ({
    key: code.replace(/^Key/, '').toLowerCase(),
    code,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  })
  it('Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl+Y redo; nothing else', () => {
    expect(historyChordOf(key('KeyZ', { ctrl: true }), 'other')).toBe('undo')
    expect(historyChordOf(key('KeyZ', { meta: true }), 'mac')).toBe('undo')
    expect(historyChordOf(key('KeyZ', { ctrl: true, shift: true }), 'other')).toBe('redo')
    expect(historyChordOf(key('KeyY', { ctrl: true }), 'other')).toBe('redo')
    expect(historyChordOf(key('KeyZ'), 'other')).toBeNull()
    expect(historyChordOf(key('KeyZ', { ctrl: true, alt: true }), 'other')).toBeNull()
    expect(historyChordOf(key('KeyX', { ctrl: true }), 'other')).toBeNull()
  })
})
