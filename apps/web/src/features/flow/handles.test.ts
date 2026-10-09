// L4-1: the + handles keep clear of the engine's rotation handle of the selection (./Handles.tsx): the up button of
// a selected shape would sit right on it (22 px above the top edge, the rotation handle 20 px above it) and take
// the press that rotates the shape.
import { describe, expect, it } from 'vitest'
import { clearOfRotation, HANDLE_OFFSET, ROTATION_CLEARANCE, rotationHandleAt } from './Handles.tsx'

type El = { id: string; type: string; x: number; y: number; width: number; height: number; angle?: number }

/** A canvas at `zoom` whose overlay is the scene scaled by the zoom. */
function canvasOf(
  els: El[],
  selection: string[],
  zoom = 1,
  opts: { locked?: boolean; editing?: string } = {},
) {
  const byId = new Map(els.map((e) => [e.id, { isDeleted: false, ...e }]))
  return {
    selection,
    get: (id: string) => byId.get(id),
    isLocked: () => opts.locked === true,
    editingId: () => opts.editing ?? null,
    viewport: { get: () => ({ x: 0, y: 0, width: 1000, height: 800, zoom }) },
    boundsOf: (ids: readonly string[]) => {
      const bs = ids.map((id) => byId.get(id)).filter((e) => !!e) as El[]
      const x = Math.min(...bs.map((e) => e.x))
      const y = Math.min(...bs.map((e) => e.y))
      return {
        x,
        y,
        width: Math.max(...bs.map((e) => e.x + e.width)) - x,
        height: Math.max(...bs.map((e) => e.y + e.height)) - y,
      }
    },
    sceneToOverlay: (p: { x: number; y: number }) => ({ x: p.x * zoom, y: p.y * zoom }),
  } as unknown as Parameters<typeof rotationHandleAt>[0]
}

const RECT: El = { id: 'r', type: 'rectangle', x: 100, y: 100, width: 200, height: 100 }

describe('the rotation handle of the selection', () => {
  it('20 screen px above the top edge of the one selected shape, at any zoom', () => {
    expect(rotationHandleAt(canvasOf([RECT], ['r']))).toEqual({ x: 200, y: 80 })
    const at2 = rotationHandleAt(canvasOf([RECT], ['r'], 2))
    expect(at2?.x).toBeCloseTo(400)
    expect(at2?.y).toBeCloseTo(180)
  })

  it('turned with the shape: a quarter turn puts it beyond the right side', () => {
    const at = rotationHandleAt(canvasOf([{ ...RECT, angle: Math.PI / 2 }], ['r']))
    expect(at?.x).toBeCloseTo(200 + 50 + 20)
    expect(at?.y).toBeCloseTo(150)
  })

  it('above the bounds of several; none with nothing selected, a locked shape, a connector or an editor open', () => {
    const two = [RECT, { ...RECT, id: 's', x: 400, y: 50 }]
    expect(rotationHandleAt(canvasOf(two, ['r', 's']))).toEqual({ x: 350, y: 30 })
    expect(rotationHandleAt(canvasOf([RECT], []))).toBeNull()
    expect(rotationHandleAt(canvasOf([RECT], ['r'], 1, { locked: true }))).toBeNull()
    expect(rotationHandleAt(canvasOf([{ ...RECT, type: 'arrow' }], ['r']))).toBeNull()
    expect(rotationHandleAt(canvasOf([RECT], ['r'], 1, { editing: 'r' }))).toBeNull()
  })
})

describe('the + buttons keep clear of it', () => {
  it('the up button of a selected shape moves above the rotation handle; the others stay where they are', () => {
    const rot = rotationHandleAt(canvasOf([RECT], ['r']))
    const up = clearOfRotation({ x: 200, y: 100 - HANDLE_OFFSET }, 'up', rot)
    expect(up.x).toBe(200)
    expect(Math.hypot(up.x - 200, up.y - 80)).toBeGreaterThanOrEqual(ROTATION_CLEARANCE)
    expect(up.y).toBeLessThan(100 - HANDLE_OFFSET)
    const right = { x: 300 + HANDLE_OFFSET, y: 150 }
    expect(clearOfRotation(right, 'right', rot)).toEqual(right)
    const down = { x: 200, y: 200 + HANDLE_OFFSET }
    expect(clearOfRotation(down, 'down', rot)).toEqual(down)
  })

  it('a quarter-turned shape: its right button moves out instead', () => {
    const rot = rotationHandleAt(canvasOf([{ ...RECT, angle: Math.PI / 2 }], ['r']))
    // the turned shape's box is 100 wide, 200 high, centred at (200, 150): its right side at x 250
    const right = clearOfRotation({ x: 250 + HANDLE_OFFSET, y: 150 }, 'right', rot)
    expect(right.y).toBe(150)
    expect(right.x - (rot?.x ?? 0)).toBeGreaterThanOrEqual(ROTATION_CLEARANCE - 0.001)
    const up = { x: 200, y: 50 - HANDLE_OFFSET }
    expect(clearOfRotation(up, 'up', rot)).toEqual(up)
  })

  it('no selection, no move', () => {
    const p = { x: 1, y: 2 }
    expect(clearOfRotation(p, 'up', null)).toBe(p)
  })
})
