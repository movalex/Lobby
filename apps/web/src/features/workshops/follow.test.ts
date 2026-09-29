import { describe, expect, it } from 'vitest'
import { NARROW_FOLLOW_RATIO, READABLE_FOLLOW_ZOOM, readableFollowViewport } from './follow.ts'

type Leader = { camera: { x: number; y: number; z: number }; screenBounds: { w: number; h: number } }

// tldraw's fit (Editor.getViewportPageBoundsForFollowing): the leader's whole viewport, widened to the
// follower's aspect ratio.
function fitted(leader: Leader, screen: { w: number; h: number }) {
  const lw = leader.screenBounds.w / leader.camera.z
  const lh = leader.screenBounds.h / leader.camera.z
  const ratio = screen.w / screen.h
  let w = lw
  let h = w / ratio
  if (h < lh) {
    h = lh
    w = h * ratio
  }
  const cx = -leader.camera.x + lw / 2
  const cy = -leader.camera.y + lh / 2
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

describe('readableFollowViewport (R2-04)', () => {
  const desktop: Leader = { camera: { x: 500, y: -100, z: 0.44 }, screenBounds: { w: 1440, h: 852 } }
  const phone = { w: 390, h: 740 }

  it("shows a phone the leader's view centre at the leader's zoom instead of about 11%", () => {
    const base = fitted(desktop, phone)
    expect(phone.w / base.w).toBeLessThan(0.12)
    const v = readableFollowViewport(base, desktop, phone)
    expect(v).not.toBeNull()
    if (!v) return
    expect(phone.w / v.w).toBeCloseTo(0.44, 5)
    expect(v.x + v.w / 2).toBeCloseTo(-500 + 1440 / 0.44 / 2, 5)
    expect(v.y + v.h / 2).toBeCloseTo(100 + 852 / 0.44 / 2, 5)
  })

  it('never takes a follower past READABLE_FOLLOW_ZOOM when the leader is zoomed in', () => {
    const close: Leader = { camera: { x: 0, y: 0, z: 1 }, screenBounds: { w: 1440, h: 852 } }
    const v = readableFollowViewport(fitted(close, phone), close, phone)
    expect(v).not.toBeNull()
    if (v) expect(phone.w / v.w).toBeCloseTo(READABLE_FOLLOW_ZOOM, 5)
  })

  it('keeps the fitted view when it is already readable (a leader zoomed right in)', () => {
    const closer: Leader = { camera: { x: 0, y: 0, z: 2 }, screenBounds: { w: 1440, h: 852 } }
    expect(readableFollowViewport(fitted(closer, phone), closer, phone)).toBeNull()
  })

  it("keeps tldraw's fitted view on a screen of similar size", () => {
    const laptop = { w: 1280, h: 720 }
    expect(readableFollowViewport(fitted(desktop, laptop), desktop, laptop)).toBeNull()
  })

  it('keeps the fitted view when it already shows the board at 60% of the target zoom or more', () => {
    const far: Leader = { camera: { x: 0, y: 0, z: 0.1 }, screenBounds: { w: 1440, h: 852 } }
    const tablet = { w: 1024, h: 700 }
    const base = fitted(far, tablet)
    expect(tablet.w / base.w).toBeGreaterThanOrEqual(0.1 * NARROW_FOLLOW_RATIO)
    expect(readableFollowViewport(base, far, tablet)).toBeNull()
  })

  it('ignores a presence without a usable camera', () => {
    const bad: Leader = { camera: { x: 0, y: 0, z: 0 }, screenBounds: { w: 1440, h: 852 } }
    expect(readableFollowViewport({ x: 0, y: 0, w: 100, h: 100 }, bad, phone)).toBeNull()
  })
})
