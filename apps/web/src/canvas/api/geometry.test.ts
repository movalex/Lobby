import { describe, expect, it } from 'vitest'
import {
  center,
  containsPoint,
  containsRect,
  corners,
  expand,
  fromPoints,
  intersection,
  intersects,
  rect,
  sameRect,
  union,
} from './geometry.ts'

describe('canvas api geometry', () => {
  it('union and fromPoints', () => {
    expect(union([])).toBeNull()
    expect(union([rect(0, 0, 10, 10), null, rect(20, -5, 5, 5)])).toEqual(rect(0, -5, 25, 15))
    expect(fromPoints([{ x: 3, y: 4 }])).toEqual(rect(3, 4, 0, 0))
  })

  it('contains, intersects, intersection', () => {
    const a = rect(0, 0, 10, 10)
    expect(containsPoint(a, { x: 10, y: 0 })).toBe(true)
    expect(containsPoint(a, { x: 10.1, y: 0 })).toBe(false)
    expect(containsRect(a, rect(1, 1, 9, 9))).toBe(true)
    expect(containsRect(a, rect(1, 1, 10, 9))).toBe(false)
    expect(intersects(a, rect(10, 10, 1, 1))).toBe(true)
    expect(intersects(a, rect(11, 0, 1, 1))).toBe(false)
    expect(intersection(a, rect(5, 5, 10, 10))).toEqual(rect(5, 5, 5, 5))
    expect(intersection(a, rect(20, 0, 1, 1))).toBeNull()
  })

  it('expand, center, sameRect', () => {
    expect(expand(rect(0, 0, 10, 10), 2)).toEqual(rect(-2, -2, 14, 14))
    expect(expand(rect(0, 0, 2, 2), -5)).toEqual(rect(5, 5, 0, 0))
    expect(center(rect(0, 0, 10, 20))).toEqual({ x: 5, y: 10 })
    expect(sameRect(rect(0, 0, 10, 10), rect(0.4, 0, 10, 10.4))).toBe(true)
    expect(sameRect(rect(0, 0, 10, 10), rect(0.6, 0, 10, 10))).toBe(false)
  })

  it('corners rotate around the centre', () => {
    const [a] = corners(rect(0, 0, 10, 10), Math.PI / 2)
    expect(a?.x).toBeCloseTo(10)
    expect(a?.y).toBeCloseTo(0)
  })
})
