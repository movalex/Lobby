// P-021: the style panel opens on request (a choice this browser keeps) and never covers the selection.
import { afterEach, describe, expect, it } from 'vitest'
import {
  readStylePanelPref,
  STYLE_PANEL_KEY,
  setStylePanelOpen,
  stylePanelOpen,
  stylePanelSide,
} from './style-panel-place.ts'

afterEach(() => stylePanelOpen.set(false))

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
}

describe('the choice', () => {
  it('closed unless this browser opened it; storage that throws or is missing reads closed', () => {
    expect(readStylePanelPref(memory())).toBe(false)
    expect(readStylePanelPref(null)).toBe(false)
    const broken = {
      getItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(readStylePanelPref(broken)).toBe(false)
  })
  it('kept: opening writes it, and a new page reads it back', () => {
    const s = memory()
    setStylePanelOpen(true, s)
    expect(stylePanelOpen.get()).toBe(true)
    expect(s.m.get(STYLE_PANEL_KEY)).toBe('true')
    expect(readStylePanelPref(s)).toBe(true)
    setStylePanelOpen(false, s)
    expect(readStylePanelPref(s)).toBe(false)
    // storage that refuses: the page still has the choice
    setStylePanelOpen(true, {
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    expect(stylePanelOpen.get()).toBe(true)
  })
})

describe('stylePanelSide: never over the selection', () => {
  const right = { x: 1200, y: 60, w: 216, h: 400 }
  const left = { x: 60, y: 108, w: 216, h: 400 }
  it('stays at the right with nothing selected or a selection clear of it', () => {
    expect(stylePanelSide(right, left, null)).toBe('right')
    expect(stylePanelSide(right, left, { x: 500, y: 200, w: 200, h: 200 })).toBe('right')
  })
  it('moves to the left while the selection is under it at the right', () => {
    expect(stylePanelSide(right, left, { x: 1250, y: 200, w: 120, h: 120 })).toBe('left')
  })
  it('a selection under both places: the one that covers less', () => {
    // under 100 px of the right place, all of the left one: it stays
    expect(stylePanelSide(right, left, { x: 0, y: 100, w: 1300, h: 300 })).toBe('right')
    // under all of the right place, a sliver of the left one: it moves
    expect(stylePanelSide(right, left, { x: 250, y: 100, w: 1190, h: 300 })).toBe('left')
    // the same at both: it stays
    expect(stylePanelSide(right, left, { x: 0, y: 0, w: 1440, h: 900 })).toBe('right')
  })
})
