// 3b navigation on the Excalidraw board page: the level-of-detail pass for zoomed-out views
// (docs/EXCALIDRAW-MIGRATION.md §8.5, apps/web/src/canvas/lod): below zoom 0.2 each frame is drawn as one
// cached bitmap and its members are left out of the engine's render; a change to a frame (this tab's or
// another's) draws it live at once and re-renders its bitmap once quiet; hit tests, selection and the
// document are unchanged. Also Lobby's zoom wheel below Excalidraw's 0.1 (CR 3b-2) and Lobby's own fit.
// The fps gate itself is navigation-lod-fps.spec.ts (a measurement, opt-in).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- navigation-lod
import type { Page } from '@playwright/test'
import {
  clickItem,
  createItem,
  createNote,
  expect,
  expectSaved,
  itemCenterOnScreen,
  selection,
  test,
  updateItem,
} from '../tests/support/canvas.ts'
import { seed, setFrame, setView, viewport, waitForNavigation, zoom } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

interface LodState {
  enabled: boolean
  active: boolean
  frames: number
  ready: number
  stale: number
  rendering: number
  busy: number
  culled: number
  drawn: number
  renders: number
  layer: boolean
}

const lod = (page: Page) =>
  page.evaluate(() => {
    const h = (window as unknown as { __lobbyLod?: { state(): LodState } }).__lobbyLod
    if (!h) throw new Error('no window.__lobbyLod (not the Excalidraw board page, or not a dev build)')
    return h.state()
  })

/** The colour at a screen point on the level-of-detail layer and on the engine's static canvas. */
const pixelsAt = (page: Page, at: { x: number; y: number }) =>
  page.evaluate(({ x, y }) => {
    const read = (sel: string) => {
      const c = document.querySelector<HTMLCanvasElement>(sel)
      if (!c) return null
      const r = c.getBoundingClientRect()
      const sx = c.width / r.width
      const sy = c.height / r.height
      const d = c
        .getContext('2d')
        ?.getImageData(Math.round((x - r.left) * sx), Math.round((y - r.top) * sy), 1, 1)
      return d ? Array.from(d.data) : null
    }
    return { lod: read('canvas[data-lobby-lod]'), engine: read('canvas.excalidraw__canvas.static') }
  }, at)

/**
 * The same colours after each of the next `frames` painted frames, read once that frame's animation-frame
 * work is done (the layer's paint and the engine's static render both run there). One read right after a
 * change can come before any frame (both canvases still hold the previous one): "never missing" reads frames.
 */
const pixelsOverFrames = (page: Page, at: { x: number; y: number }, frames: number) =>
  page.evaluate(
    async ({ x, y, frames }) => {
      const read = (sel: string) => {
        const c = document.querySelector<HTMLCanvasElement>(sel)
        if (!c) return null
        const r = c.getBoundingClientRect()
        const sx = c.width / r.width
        const sy = c.height / r.height
        const d = c
          .getContext('2d')
          ?.getImageData(Math.round((x - r.left) * sx), Math.round((y - r.top) * sy), 1, 1)
        return d ? Array.from(d.data) : null
      }
      const out: { lod: number[] | null; engine: number[] | null }[] = []
      for (let i = 0; i < frames; i++) {
        await new Promise<void>((done) =>
          requestAnimationFrame(() => {
            const after = new MessageChannel()
            after.port1.onmessage = () => done()
            after.port2.postMessage(null)
          }),
        )
        out.push({ lod: read('canvas[data-lobby-lod]'), engine: read('canvas.excalidraw__canvas.static') })
      }
      return out
    },
    { ...at, frames },
  )

/** Waits until the pass is on and every frame's bitmap is current. */
async function settled(page: Page, frames: number) {
  await expect
    .poll(async () => {
      const s = await lod(page)
      return s.active && s.frames === frames && s.ready === frames && s.stale === 0 && s.rendering === 0
    })
    .toBe(true)
}

// the canvas colour: tldraw's #f9fafb since wave 5 (W5-10, canvas/engine/theme.ts CANVAS_LIGHT)
const CANVAS = [249, 250, 251, 255]
const isBackground = (px: number[] | null) => !!px && px.every((v, i) => Math.abs(v - (CANVAS[i] ?? 0)) <= 2)
const inked = (px: number[] | null) => !!px && (px[3] ?? 0) > 0 && !isBackground(px)

test('below zoom 0.2 a frame is one bitmap and its notes leave the engine’s render; a change (own or another tab’s) draws the frame live until its bitmap is current again; clicks still select; at 0.5 the pass is off', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForNavigation(a.page)
  const [F1, F2, N1, N2, LOOSE] = (await seed(a.page, [
    () => createItem(a.page, 'frame', { x: 0, y: 0, width: 1200, height: 800, name: 'One' }),
    () => createItem(a.page, 'frame', { x: 1500, y: 0, width: 1200, height: 800, name: 'Two' }),
    () => createNote(a.page, { x: 200, y: 200, text: 'In one' }),
    () => createNote(a.page, { x: 1700, y: 200, text: 'In two' }),
    () => createNote(a.page, { x: 3000, y: 200, text: 'Loose' }),
  ])) as [string, string, string, string, string]
  await setFrame(a.page, [N1], F1)
  await setFrame(a.page, [N2], F2)
  await expectSaved(a.page)

  await test.step('at 0.15 both frames are bitmaps: the layer draws the notes, the engine does not; a loose note stays the engine’s', async () => {
    await setView(a.page, { x: -1500, y: -1800, zoom: 0.15 })
    await settled(a.page, 2)
    const s = await lod(a.page)
    expect(s.layer).toBe(true)
    expect(s.culled).toBe(2) // the two framed notes (labels follow their container)
    expect(s.drawn).toBe(2)
    const inOne = await pixelsAt(a.page, await itemCenterOnScreen(a.page, N1))
    expect(inked(inOne.lod), 'the bitmap draws the framed note').toBe(true)
    expect(isBackground(inOne.engine), 'the engine leaves it out').toBe(true)
    const loose = await pixelsAt(a.page, await itemCenterOnScreen(a.page, LOOSE))
    expect(inked(loose.engine), 'a loose note is still the engine’s').toBe(true)
  })

  await test.step('a click on a culled note still selects it (hit tests use the document)', async () => {
    await clickItem(a.page, N1)
    await expect.poll(() => selection(a.page)).toEqual([N1])
    await a.page.keyboard.press('Escape')
  })

  await test.step('this tab moves the note: its frame is live at once, then a bitmap again with the note at its new place', async () => {
    await updateItem(a.page, N1, { x: 700 })
    // the change is taken in the update's own task (the frame goes stale there) and both canvases repaint in
    // the next animation frame, so the point is read after each of the next frames: one read at once can come
    // before any frame and see the old frame's canvases (the wave Q flake: no frame between update and read)
    const frames = await pixelsOverFrames(a.page, await itemCenterOnScreen(a.page, N1), 4)
    // drawn by the engine (the frame is stale) or already by the fresh bitmap: never missing, in any frame
    expect(frames.map((f) => inked(f.engine) || inked(f.lod))).toEqual([true, true, true, true])
    await settled(a.page, 2)
    const moved = await pixelsAt(a.page, await itemCenterOnScreen(a.page, N1))
    expect(inked(moved.lod)).toBe(true)
    expect(isBackground(moved.engine)).toBe(true)
  })

  await test.step('another tab moves a note: it is painted as it arrives (edit visibility unchanged), then cached again', async () => {
    await expect.poll(async () => await b.page.evaluate(() => !!window.lobbyCanvas)).toBe(true)
    await updateItem(b.page, N2, { y: 450 })
    await expect
      .poll(async () => {
        const p = await pixelsAt(a.page, await itemCenterOnScreen(a.page, N2))
        return inked(p.engine) || inked(p.lod)
      })
      .toBe(true)
    await expect.poll(async () => (await lod(a.page)).renders).toBeGreaterThanOrEqual(4)
    await settled(a.page, 2)
    const p = await pixelsAt(a.page, await itemCenterOnScreen(a.page, N2))
    expect(inked(p.lod)).toBe(true)
  })

  await test.step('at 0.5 the pass is off: nothing culled, the engine draws every note', async () => {
    await setView(a.page, { x: -200, y: -200, zoom: 0.5 })
    await expect.poll(async () => (await lod(a.page)).active).toBe(false)
    expect((await lod(a.page)).culled).toBe(2) // the bitmaps are kept for the next time
    const p = await pixelsAt(a.page, await itemCenterOnScreen(a.page, N1))
    expect(inked(p.engine)).toBe(true)
  })
})

test('the zoom wheel (Ctrl + wheel, a trackpad pinch) goes below Excalidraw’s 0.1 down to the whole-board fit and back; Lobby’s own fit does too', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  await seed(a.page, [
    () => createNote(a.page, { x: -30_000, y: 0, text: 'West' }),
    () => createNote(a.page, { x: 30_000, y: 0, text: 'East' }),
  ])
  const fit = await a.page.evaluate(() => {
    const c = (
      window as unknown as {
        __lobbyBoard: { canvas: { viewport: { limits(): { min: number }; fit(): void } } }
      }
    ).__lobbyBoard.canvas
    return c.viewport.limits().min
  })
  expect(fit).toBeLessThan(0.1)

  await test.step('Lobby’s fit (viewport.fit) shows the whole board below 0.1', async () => {
    await a.page.evaluate(() =>
      (
        window as unknown as { __lobbyBoard: { canvas: { viewport: { fit(): void } } } }
      ).__lobbyBoard.canvas.viewport.fit(),
    )
    await expect.poll(() => zoom(a.page)).toBeLessThan(0.1)
    expect(await zoom(a.page)).toBeGreaterThanOrEqual(fit - 1e-6)
  })

  await test.step('Ctrl + wheel out from 0.1 keeps zooming out, stops at the fit, and zooms back in past 0.1', async () => {
    await setView(a.page, { x: -7000, y: -4000, zoom: 0.1 })
    const box = await a.page.locator('canvas.excalidraw__canvas.interactive').boundingBox()
    if (!box) throw new Error('no canvas')
    await a.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await a.page.keyboard.down('Control')
    let last = await zoom(a.page)
    for (let i = 0; i < 3; i++) {
      await a.page.mouse.wheel(0, 100)
      await expect.poll(() => zoom(a.page)).toBeLessThan(last)
      last = await zoom(a.page)
    }
    expect(last).toBeLessThan(0.1)
    for (let i = 0; i < 40; i++) await a.page.mouse.wheel(0, 100)
    await expect.poll(async () => Math.abs((await zoom(a.page)) - fit)).toBeLessThan(1e-6)
    // at the floor another notch changes nothing (the engine would snap back to 0.1)
    await a.page.mouse.wheel(0, 100)
    await a.page.waitForTimeout(300)
    expect(Math.abs((await zoom(a.page)) - fit)).toBeLessThan(1e-6)
    for (let i = 0; i < 40; i++) await a.page.mouse.wheel(0, -100)
    await expect.poll(() => zoom(a.page)).toBeGreaterThan(0.1)
    await a.page.keyboard.up('Control')
  })

  await test.step('the point under the pointer stays put while zooming below 0.1', async () => {
    await setView(a.page, { x: -7000, y: -4000, zoom: 0.08 })
    const box = await a.page.locator('canvas.excalidraw__canvas.interactive').boundingBox()
    if (!box) throw new Error('no canvas')
    const at = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.6 }
    const before = await viewport(a.page)
    const scene = (v: { x: number; y: number; zoom: number }) => ({
      x: v.x + (at.x - box.x) / v.zoom,
      y: v.y + (at.y - box.y) / v.zoom,
    })
    await a.page.mouse.move(at.x, at.y)
    await a.page.keyboard.down('Control')
    await a.page.mouse.wheel(0, 100)
    await a.page.keyboard.up('Control')
    await expect.poll(() => zoom(a.page)).toBeLessThan(before.zoom)
    const after = await viewport(a.page)
    const [p, q] = [scene(before), scene(after)]
    expect(Math.hypot(p.x - q.x, p.y - q.y) * after.zoom).toBeLessThan(1.5)
  })
})
