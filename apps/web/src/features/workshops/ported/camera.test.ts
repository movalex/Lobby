// OWNER: 3f. R2-04's readable follow on the Excalidraw page (./camera.ts readableFollowCamera): the camera
// rule a gathered follower's `follow.start(sid, {camera})` gets (CR-3F-3), and the canvas size a summon
// carries (summonScreen).
import { describe, expect, it } from 'vitest'
import type { Bounds, FollowCamera, LobbyCanvas } from '../../../canvas/api/index.ts'
import { READABLE_FOLLOW_ZOOM } from '../follow.ts'
import { readableFollowCamera, summonScreen } from './camera.ts'

type Screen = { width: number; height: number }

/** 3c's default: the leader's whole view fitted into the screen, centred (canvas/api/parts/follow.ts). */
function fit(view: Bounds, screen: Screen): FollowCamera {
  const zoom = Math.min(screen.width / view.width, screen.height / view.height)
  return {
    x: view.x + view.width / 2 - screen.width / zoom / 2,
    y: view.y + view.height / 2 - screen.height / zoom / 2,
    zoom,
  }
}

/** What a leader's presence `view` is: their canvas at a camera, rounded as the board page sends it. */
function viewOf(canvas: { w: number; h: number }, at: { x: number; y: number; zoom: number }): Bounds {
  return {
    x: Math.round(at.x),
    y: Math.round(at.y),
    width: Math.round(canvas.w / at.zoom),
    height: Math.round(canvas.h / at.zoom),
  }
}

const run = (leaderScreen: { w: number; h: number } | null | undefined, leader: Bounds, screen: Screen) =>
  readableFollowCamera(leaderScreen)({ leader, screen, fit: fit(leader, screen) })

const centre = (c: FollowCamera, s: Screen) => ({
  x: c.x + s.width / c.zoom / 2,
  y: c.y + s.height / c.zoom / 2,
})

describe('readableFollowCamera (R2-04)', () => {
  const desktop = { w: 1396, h: 844 }
  const phone = { width: 390, height: 788 }

  it("shows a phone the leader's view centre at the leader's zoom (not the whole view at about 11 %)", () => {
    const leader = viewOf(desktop, { x: 400, y: 200, zoom: 0.44 })
    expect(fit(leader, phone).zoom).toBeLessThan(0.13)
    const c = run(desktop, leader, phone)
    expect(c).not.toBeNull()
    if (!c) return
    expect(c.zoom).toBeCloseTo(0.44, 3)
    const at = centre(c, phone)
    expect(at.x).toBeCloseTo(leader.x + leader.width / 2, 6)
    expect(at.y).toBeCloseTo(leader.y + leader.height / 2, 6)
  })

  it('reads the zoom from the height, so a dock panel the leader opens later (a narrower canvas) changes nothing', () => {
    const narrower = viewOf({ w: desktop.w - 360, h: desktop.h }, { x: 400, y: 200, zoom: 0.44 })
    expect(run(desktop, narrower, phone)?.zoom).toBeCloseTo(0.44, 3)
  })

  it('never takes a follower past READABLE_FOLLOW_ZOOM when the leader is zoomed in', () => {
    const leader = viewOf(desktop, { x: 0, y: 0, zoom: 1 })
    expect(run(desktop, leader, phone)?.zoom).toBeCloseTo(READABLE_FOLLOW_ZOOM, 6)
  })

  it('keeps the fit on a screen of similar size, and when the fit is readable already', () => {
    const leader = viewOf(desktop, { x: 0, y: 0, zoom: 0.44 })
    expect(run(desktop, leader, { width: 1280, height: 720 })).toBeNull()
    const closer = viewOf(desktop, { x: 0, y: 0, zoom: 2 })
    expect(run(desktop, closer, phone)).toBeNull()
  })

  it('keeps the fit without the summoner’s canvas size (an older client) or with an empty view', () => {
    const leader = viewOf(desktop, { x: 0, y: 0, zoom: 0.44 })
    expect(run(undefined, leader, phone)).toBeNull()
    expect(run(null, leader, phone)).toBeNull()
    const rule = readableFollowCamera(desktop)
    const empty = { x: 0, y: 0, width: 0, height: 0 }
    expect(rule({ leader: empty, screen: phone, fit: { x: 0, y: 0, zoom: 1 } })).toBeNull()
  })
})

describe('summonScreen', () => {
  const canvasWith = (screenRect: () => Bounds) => ({ viewport: { screenRect } }) as unknown as LobbyCanvas

  it('is the canvas size in whole CSS pixels', () => {
    expect(summonScreen(canvasWith(() => ({ x: 44, y: 56, width: 1395.6, height: 844.2 })))).toEqual({
      w: 1396,
      h: 844,
    })
  })

  it('is undefined on an empty canvas or without the board page (a bare port throws)', () => {
    expect(summonScreen(canvasWith(() => ({ x: 0, y: 0, width: 0, height: 0 })))).toBeUndefined()
    expect(
      summonScreen(
        canvasWith(() => {
          throw new Error('not implemented (2C): viewport.screenRect')
        }),
      ),
    ).toBeUndefined()
  })
})
