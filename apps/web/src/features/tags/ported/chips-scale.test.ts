// R2-10: tag chips and dots keep a minimum size on screen at overview zoom; F2-08: "Zoom to matches" brings
// the carriers of the filtered tag into view. Pure parts; the browser paths are e2e/excalidraw/c3-polish.spec.ts.
import { describe, expect, it, vi } from 'vitest'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import { CHIP_COMPACT_BELOW, chipScaleFor, chipsCompactAt, MIN_CHIP_TEXT_PX, MIN_DOT_PX } from './Chips.tsx'
import { matchingIds, zoomToMatches } from './Filter.tsx'
import { LOD_DOTS_ZOOM, LOD_FULL_ZOOM, tagsLodFor } from './model.ts'
import type { TagsRuntime } from './runtime.ts'

describe('chips keep a minimum size on screen (R2-10)', () => {
  it('are the same size as before from 100 % up', () => {
    for (const zoom of [1, 1.5, 2, 4, 8]) expect(chipScaleFor(zoom)).toBe(1)
  })

  it('full chips grow so their 11 px text stays at least MIN_CHIP_TEXT_PX on screen', () => {
    for (const zoom of [0.99, 0.9, 0.75, 0.6]) {
      const scale = chipScaleFor(zoom)
      expect(scale, `zoom ${zoom}`).toBeGreaterThan(1)
      expect(11 * scale * zoom, `zoom ${zoom}`).toBeGreaterThanOrEqual(MIN_CHIP_TEXT_PX - 0.05)
    }
    expect(tagsLodFor(0.6)).toBe('full')
  })

  it('colour dots (22 scene px at 100 %) keep at least MIN_DOT_PX on screen down to where they go', () => {
    for (const zoom of [0.59, 0.4, 0.3, LOD_DOTS_ZOOM]) {
      expect(tagsLodFor(zoom)).toBe('dots')
      expect(22 * chipScaleFor(zoom) * zoom, `zoom ${zoom}`).toBeGreaterThanOrEqual(MIN_DOT_PX - 0.1)
    }
  })

  it('never shrinks them, and ignores a zoom that is not a number', () => {
    for (const zoom of [0.25, 0.4, 0.6, 0.9, 1, 3]) expect(chipScaleFor(zoom)).toBeGreaterThanOrEqual(1)
    for (const zoom of [0, -1, Number.NaN]) expect(chipScaleFor(zoom)).toBe(1)
  })

  it('from 75 % down a note shows its first tag and "+N" (full chips only: dots show every tag)', () => {
    expect(CHIP_COMPACT_BELOW).toBe(0.75)
    expect(chipsCompactAt(1)).toBe(false)
    expect(chipsCompactAt(0.75)).toBe(false)
    expect(chipsCompactAt(0.74)).toBe(true)
    expect(chipsCompactAt(LOD_FULL_ZOOM)).toBe(true)
    expect(chipsCompactAt(LOD_FULL_ZOOM - 0.01)).toBe(false) // dots now
    expect(chipsCompactAt(0.1)).toBe(false)
  })
})

describe('Zoom to matches (F2-08)', () => {
  let n = 0
  const tagged = (keys: string[], over: Record<string, unknown> = {}) =>
    ({
      id: `e${++n}`,
      type: 'stickynote',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      angle: 0,
      isDeleted: false,
      customData: {
        lobby: Object.fromEntries(keys.map((k) => [`tag:${k}`, { name: k, color: 'blue' }])),
      },
      ...over,
    }) as unknown as CanvasElement

  it('lists the visible, live carriers of the tag in scene order, and nobody else', () => {
    const a = tagged(['research'])
    const b = tagged(['research', 'idea'])
    const other = tagged(['idea'])
    const untagged = tagged([])
    const hidden = tagged(['research'])
    const gone = tagged(['research'], { isDeleted: true })
    const arrow = tagged(['research'], { type: 'arrow' })
    const ids = matchingIds(
      [a, other, b, untagged, hidden, gone, arrow],
      'research',
      (id) => id === hidden.id,
    )
    expect(ids).toEqual([a.id, b.id])
  })

  it('moves the camera to fit them, animated, and says false when there is nothing to go to', () => {
    const a = tagged(['research'])
    const b = tagged(['research'])
    const fit = vi.fn()
    const rt = {
      canvas: { items: () => [a, tagged(['idea']), b], isHidden: () => false, viewport: { fit } },
    } as unknown as TagsRuntime
    expect(zoomToMatches(rt, 'research')).toBe(true)
    expect(fit).toHaveBeenCalledWith([a.id, b.id], { animate: true })

    fit.mockClear()
    expect(zoomToMatches(rt, 'nothing-has-this')).toBe(false)
    expect(fit).not.toHaveBeenCalled()
  })
})
