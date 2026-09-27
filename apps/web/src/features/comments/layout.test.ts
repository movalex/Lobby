import { describe, expect, it } from 'vitest'
import {
  coveredBottom,
  MIN_POPOVER_WIDTH,
  markerCovered,
  PIN_SIZE,
  panelBlocksPopover,
  popoverLayout,
  revealTarget,
  sheetHeight,
} from './layout.ts'

const DESKTOP = { w: 1236, h: 668 }
// A 390×844 phone with the dock rail (44 px) and the top bar: the canvas left for the editor.
const PHONE = { w: 346, h: 790 }

describe('popoverLayout', () => {
  it('puts the popover right of the marker on wide boards, or left of it near the right edge', () => {
    expect(popoverLayout(DESKTOP, { x: 200, y: 300 })).toEqual({
      left: 200 + PIN_SIZE + 10,
      top: 300 - PIN_SIZE - 8,
      bottom: null,
      width: 340,
      docked: false,
      maxHeight: null,
    })
    const nearRight = popoverLayout(DESKTOP, { x: 1100, y: 300 })
    expect(nearRight.left).toBe(1100 - 340 - 10)
    expect(nearRight.left + nearRight.width).toBeLessThanOrEqual(DESKTOP.w - 12)
    // A thread without a place on this page opens top-left.
    expect(popoverLayout(DESKTOP, null)).toMatchObject({ left: 12, top: 12, docked: false })
  })

  it('keeps the popover inside the viewport vertically', () => {
    expect(popoverLayout(DESKTOP, { x: 200, y: 5 }).top).toBe(12)
    expect(popoverLayout(DESKTOP, { x: 200, y: 660 }).top).toBe(DESKTOP.h - 320)
  })

  it('on a phone is a bottom sheet across the canvas, at least 300 px wide, whatever the anchor', () => {
    for (const anchor of [{ x: 20, y: 700 }, { x: 330, y: 40 }, null]) {
      const l = popoverLayout(PHONE, anchor)
      expect(l.docked).toBe(true)
      expect(l.top).toBeNull()
      expect(l.bottom).toBe(8)
      expect(l.left).toBe(8)
      expect(l.width).toBe(PHONE.w - 16)
      expect(l.width).toBeGreaterThanOrEqual(MIN_POPOVER_WIDTH)
      expect(l.left + l.width).toBeLessThanOrEqual(PHONE.w)
      expect(l.maxHeight).toBe(sheetHeight(PHONE))
    }
  })
})

describe('bringing a marker into view', () => {
  it('centres it on wide boards and above the bottom sheet on phones', () => {
    expect(coveredBottom(DESKTOP)).toBe(0)
    expect(revealTarget(DESKTOP)).toEqual({ x: DESKTOP.w / 2, y: DESKTOP.h / 2 })
    const t = revealTarget(PHONE)
    expect(t.x).toBe(PHONE.w / 2)
    // The whole marker is above the sheet.
    expect(t.y).toBeGreaterThan(PIN_SIZE)
    expect(t.y).toBeLessThan(PHONE.h - coveredBottom(PHONE))
    expect(markerCovered(PHONE, t)).toBe(false)
  })

  it('knows when the sheet covers a marker', () => {
    expect(markerCovered(PHONE, { x: 100, y: PHONE.h - 20 })).toBe(true)
    expect(markerCovered(PHONE, { x: -5, y: 100 })).toBe(true)
    expect(markerCovered(PHONE, { x: 100, y: 100 })).toBe(false)
    expect(markerCovered(DESKTOP, { x: 100, y: DESKTOP.h - 20 })).toBe(false)
  })
})

describe('panelBlocksPopover', () => {
  it('closes the dock panel on phones and when it leaves too little canvas', () => {
    expect(panelBlocksPopover(390, 26)).toBe(true)
    expect(panelBlocksPopover(1280, 916)).toBe(false)
    expect(panelBlocksPopover(700, 300)).toBe(true)
    expect(panelBlocksPopover(768, 404)).toBe(false)
  })
})
