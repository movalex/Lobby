// OWNER: 3a. The toolbar's layout by canvas width (./toolbar-layout.ts), against tldraw's own rules.
import { describe, expect, it } from 'vitest'
import { historyChordOf } from './chrome-keys.ts'
import { modulate, planToolbar, stylesFold, type ToolbarRoom, tldrawItemsToShow } from './toolbar-layout.ts'

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
    // W5-33: Undo and Redo beside the tools instead; 38 px tools
    expect(p.historyBar).toBe(true)
    expect(p.toolPx).toBe(38)
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

  it('on a phone the 44 px tools that fit beside the zoom button show, in order, and the rest wait in More', () => {
    // 390 px, the navigation slot's fit button ends at 52 px: 390 - 58 - 12 - 46 (Styles) = 274 px, room for
    // five 46 px slots (W5-31: 44 px touch targets)
    const p = plan(390, null, 58)
    expect(p.toolPx).toBe(44)
    expect(p.historyBar).toBe(false)
    expect(p.shown).toEqual(MAIN.slice(0, 4))
    expect(p.more[0]).toBe('rectangle')
    expect(p.more).toHaveLength(ORDERED.length - 4)
    // the bar (4 tools, More, Styles) moves right to clear the zoom button, and stays inside the canvas
    const width = 5 * 46 + 8 + 46
    expect(390 / 2 - width / 2 + p.shift).toBeGreaterThanOrEqual(58)
    expect(390 / 2 + width / 2 + p.shift).toBeLessThanOrEqual(390 - 12)
  })

  it('the quick-actions strip starts right of a navigation slot lifted into its band (the wave-3b integration)', () => {
    const at = (width: number, quickLeft: number) =>
      planToolbar({
        ordered: ORDERED,
        mainCount: MAIN.length,
        lastUsed: null,
        room: { width, left: 12, right: 12, quickLeft },
        editor: true,
        styles: true,
      })
    for (const width of [390, 560, 700]) {
      const p = at(width, 58)
      const slot = width <= 640 ? 46 : 40
      const shownWidth = (p.shown.length + (p.more.length ? 1 : 0)) * slot + 8 + (p.stylesButton ? 46 : 0)
      // the strip's left: the bar's left, its own 8 px margin and the indent
      const stripLeft = width / 2 - shownWidth / 2 + p.shift + 8 + p.quickIndent
      expect(stripLeft).toBeGreaterThanOrEqual(58)
    }
    // no slot in the band: the strip keeps its place; a wide canvas has no strip at all
    expect(at(560, 0).quickIndent).toBe(0)
    expect(at(1280, 58).quickIndent).toBe(0)
  })

  it('a tool picked from More on a phone takes the last slot', () => {
    const p = plan(390, 'frame', 58)
    expect(p.shown).toEqual([...MAIN.slice(0, 3), 'frame'])
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

describe('W5-33: the history bar hangs left of the tools', () => {
  it('the tools stay centred on a wide canvas; near the navigation slot the bar moves so that neither covers it', () => {
    const wide = plan(1395)
    expect(wide.historyBar).toBe(true)
    expect(wide.shift).toBe(0)
    // 900 px with the navigation slot reaching 160 px: the history bar (82 px) left of the tools stays right of it
    const p = plan(900, null, 160)
    const width = (p.shown.length + (p.more.length ? 1 : 0)) * 40 + 8
    const toolsLeft = 900 / 2 - width / 2 + p.shift
    expect(toolsLeft - 82).toBeGreaterThanOrEqual(160)
    expect(toolsLeft + width).toBeLessThanOrEqual(900 - 12)
  })
})

describe('W5-46: the style panel folds on a narrow or a low canvas', () => {
  it('at 640 px wide or less, or 500 px high or less (a laptop at 200% zoom)', () => {
    expect(stylesFold({ width: 640, height: 900 })).toBe(true)
    expect(stylesFold({ width: 700, height: 900 })).toBe(false)
    expect(stylesFold({ width: 672, height: 400 })).toBe(true)
    expect(stylesFold({ width: 1395, height: 500 })).toBe(true)
    expect(stylesFold({ width: 1395 })).toBe(false)
    const low = planToolbar({
      ordered: ORDERED,
      mainCount: MAIN.length,
      lastUsed: null,
      room: { width: 672, height: 400, left: 12, right: 12 },
      editor: true,
      styles: true,
    })
    expect(low.stylesButton).toBe(true)
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
