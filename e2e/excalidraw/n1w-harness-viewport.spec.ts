// Wave N1 (wave L follow-up, "the L-compat 3 flake"): the test harness's setViewport (window.lobbyCanvas.setViewport) sets
// the camera without stopping a camera animation of the board's own, so a harness move made while Lobby was animating (a
// focus, a fit, a "go to") was taken back by the animation's next frame, and a spec that meant to move the camera ended
// where the animation was going. The shared spec helper (tests/support/canvas.ts setViewport) now lets a running camera
// animation finish first, so the harness move is the last word. (The page-side one-liner, test-facade.ts, is the canvas
// workstream's: it calls the port's raw set, the board's own viewport.set stops the animation first.)
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n1w-harness-viewport.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { expect, setViewport, test, viewport, waitForCanvas } from '../tests/support/canvas.ts'
import { cameraIdle } from './navigation-kit.ts'

/** Starts the board's own animated camera move (what a focus or a fit does). */
const animateTo = (page: Page, to: { x: number; y: number; zoom: number }, ms: number) =>
  page.evaluate(
    ({ to, ms }) => {
      const b = (
        window as unknown as {
          __lobbyBoard?: {
            canvas: {
              viewport: {
                set(v: object, o: object): void
                moving(): boolean
              }
            }
          }
        }
      ).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard')
      b.canvas.viewport.set(to, { animate: { durationMs: ms } })
      return b.canvas.viewport.moving()
    },
    { to, ms },
  )

test('N1: a harness setViewport made during the board’s own camera animation is the camera’s last word', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvas(a.page)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  await cameraIdle(a.page)

  // the board starts an animation towards one place...
  expect(await animateTo(a.page, { x: 4000, y: 3000, zoom: 1 }, 900)).toBe(true)
  // ...and the spec moves the camera to another, a moment later
  await a.page.waitForTimeout(120)
  await setViewport(a.page, { x: -250, y: -125, zoom: 1 })

  // the animation has ended by now (and would have taken the camera to 4000, 3000)
  await a.page.waitForTimeout(1_300)
  await cameraIdle(a.page)
  const v = await viewport(a.page)
  expect({ x: Math.round(v.x), y: Math.round(v.y) }).toEqual({ x: -250, y: -125 })
})

test('N1: with no animation running the harness move is immediate (the helper does not slow a plain call)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvas(a.page)
  await cameraIdle(a.page)
  const t0 = Date.now()
  await setViewport(a.page, { x: 321, y: 123, zoom: 1 })
  expect(Date.now() - t0).toBeLessThan(1_000)
  const v = await viewport(a.page)
  expect({ x: Math.round(v.x), y: Math.round(v.y) }).toEqual({ x: 321, y: 123 })
})
