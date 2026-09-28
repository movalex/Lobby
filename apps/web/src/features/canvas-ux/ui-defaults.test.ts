// canvas-ux UI defaults that need no browser: the minimap preference (PERF-03), when the style panel
// shows (RETRO-20), the Arrange menu labels and the Preferences menu (F20).
import type { Editor, TLUiActionsContextType, TLUiOverrideHelpers } from 'tldraw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MINIMAP_KEY, readMinimapPref } from './bridge.ts'
import { ARRANGE_LABELS, canvasUxOverrides } from './overrides.tsx'
import { showStylePanel } from './StylePanel.tsx'

const store = (value: string | null) => ({ getItem: (k: string) => (k === MINIMAP_KEY ? value : null) })

describe('minimap preference (PERF-03)', () => {
  it('is closed when nothing is stored, or storage is unavailable', () => {
    expect(readMinimapPref(store(null))).toBe(false)
    expect(readMinimapPref(null)).toBe(false)
    expect(
      readMinimapPref({
        getItem: () => {
          throw new Error('blocked')
        },
      }),
    ).toBe(false)
  })
  it('an explicit stored choice wins', () => {
    expect(readMinimapPref(store('true'))).toBe(true)
    expect(readMinimapPref(store('false'))).toBe(false)
  })
})

describe('style panel visibility (RETRO-20)', () => {
  it('shows for a selection or a creation tool only', () => {
    expect(showStylePanel(0, 'select')).toBe(false)
    expect(showStylePanel(0, 'hand')).toBe(false)
    expect(showStylePanel(0, 'frame')).toBe(false)
    expect(showStylePanel(0, 'eraser')).toBe(false)
    expect(showStylePanel(1, 'select')).toBe(true)
    for (const tool of ['note', 'text', 'geo', 'draw', 'arrow', 'line', 'highlight']) {
      expect(showStylePanel(0, tool)).toBe(true)
    }
  })

  it('R16: hides for a selection of frames only (a lone opacity slider was all it showed)', () => {
    expect(showStylePanel(1, 'select', true)).toBe(false)
    expect(showStylePanel(3, 'select', true)).toBe(false)
    expect(showStylePanel(2, 'select', false)).toBe(true)
  })
})

describe('menu copy (F20, RETRO-23b)', () => {
  it('gives every Arrange entry a plain label (no "Align H", "Distribute V")', () => {
    const en = (canvasUxOverrides.translations as Record<string, Record<string, string>>).en ?? {}
    for (const [key, label] of Object.entries(ARRANGE_LABELS)) {
      expect(en[key]).toBe(label)
      expect(label).toMatch(/^(Align|Distribute|Stretch|Flip|Stack) (horizontally|vertically)$/)
    }
    expect(Object.keys(ARRANGE_LABELS)).toHaveLength(10)
  })

  const editorStub = new Proxy({}, { get: () => () => undefined }) as unknown as Editor
  const helpersStub = new Proxy({}, { get: () => () => undefined }) as unknown as TLUiOverrideHelpers
  const actions = () =>
    ({
      'toggle-debug-mode': { id: 'toggle-debug-mode', label: 'x', onSelect() {} },
      'toggle-lock': { id: 'toggle-lock', label: 'x', kbd: 'shift+l', onSelect() {} },
    }) as unknown as TLUiActionsContextType
  afterEach(() => vi.unstubAllEnvs())

  it('drops Preferences → Debug mode outside dev builds', () => {
    vi.stubEnv('DEV', false)
    const out = canvasUxOverrides.actions?.(editorStub, actions(), helpersStub) ?? {}
    expect(out['toggle-debug-mode']).toBeUndefined()
    expect(out['toggle-lock']).toBeDefined()
  })
  it('keeps it in dev builds', () => {
    vi.stubEnv('DEV', true)
    const out = canvasUxOverrides.actions?.(editorStub, actions(), helpersStub) ?? {}
    expect(out['toggle-debug-mode']).toBeDefined()
  })
})
