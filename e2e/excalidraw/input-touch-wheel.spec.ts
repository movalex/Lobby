// OWNER: B2 (wave B). Touch, wheel and tool defaults on the Excalidraw board page:
//   W5-33 / CR-W5-3A-4     Preferences > Input device: what a plain mouse wheel does (auto, mouse, trackpad)
//   W5-40 / CR-W5-3A-1     Straight after Elbow draws straight connectors (it drew curved ones)
//   W5-52                  a freshly drawn rectangle has sharp corners, as templates and converted shapes do
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/input-touch-wheel.spec.ts --workers=1
import type { Page } from '@playwright/test'
import {
  createNote,
  expect,
  expectSaved,
  items,
  screenToScene,
  select,
  setTool,
  setViewport,
  test,
  viewport,
} from '../tests/support/canvas.ts'
import { emptyCanvasPoint, settled } from './board-kit.ts'
import { waitForCanvasUx, withCanvas } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const zoomOf = async (page: Page) => (await viewport(page)).zoom

/** The elements on the board (a note is two: the note and its words). */
const liveCount = async (page: Page) =>
  (await items(page)).filter((e) => !(e as { isDeleted?: boolean }).isDeleted).length

type Pt = { x: number; y: number }

// ---- Preferences > Input device -----------------------------------------------------------------------------

test('W5-33 (CR-W5-3A-4): Preferences > Input device: auto zooms on a mouse wheel and pans on a trackpad scroll, Mouse always zooms, Trackpad always pans, and it is remembered', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  await waitForCanvasUx(page)
  await settled(page, createNote(page, { x: 100, y: 100, text: 'wheel' }))
  const seeded = await liveCount(page)
  const wheelSetting = () => withCanvas(page, (c) => c.settings.get().wheel, null)
  const at = await emptyCanvasPoint(page)
  const reset = async () => {
    await setViewport(page, { x: 0, y: 0, zoom: 1 })
    await page.mouse.move(at.x, at.y)
    // a wheel builds on the previous one while the engine may not have drawn it yet (120 ms): let that pass
    await page.waitForTimeout(200)
  }
  const chooseDevice = async (pref: 'auto' | 'mouse' | 'trackpad') => {
    await page.getByTestId('main-menu.button').click()
    await page.getByTestId('main-menu-sub.preferences-button').click()
    await page.getByTestId('main-menu-sub.input-device-button').click()
    await page.getByTestId(`main-menu.input-device-${pref}`).click()
    await expect.poll(wheelSetting).toBe(pref)
  }

  await test.step('the menu: Auto is the default, and the three are a radio list', async () => {
    expect(await wheelSetting()).toBe('auto')
    await page.getByTestId('main-menu.button').click()
    await page.getByTestId('main-menu-sub.preferences-button').click()
    await page.getByTestId('main-menu-sub.input-device-button').click()
    await expect(page.getByTestId('main-menu.input-device-auto')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('main-menu.input-device-mouse')).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('main-menu.input-device-trackpad')).toHaveAttribute('aria-checked', 'false')
    await page.getByTestId('main-menu.button').click()
    await expect(page.getByTestId('main-menu-root')).toHaveCount(0)
  })

  await test.step('auto: a mouse wheel notch zooms around the pointer; a trackpad-sized scroll pans', async () => {
    await reset()
    const before = await screenToScene(page, at)
    await page.mouse.wheel(0, 100)
    await expect.poll(() => zoomOf(page)).toBeCloseTo(0.9, 2)
    const after = await screenToScene(page, at)
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(2)
    await reset()
    await page.mouse.wheel(3, 40)
    await expect.poll(async () => (await viewport(page)).y).toBeGreaterThan(5)
    expect(await zoomOf(page)).toBe(1)
  })

  await test.step('Trackpad: the wheel pans, a notch included (the engine’s own)', async () => {
    await chooseDevice('trackpad')
    await reset()
    await page.mouse.wheel(0, 100)
    await expect.poll(async () => (await viewport(page)).y).toBeGreaterThan(20)
    expect(await zoomOf(page)).toBe(1)
  })

  await test.step('Mouse: the wheel zooms, a small step too, in and out, 10% a notch', async () => {
    await chooseDevice('mouse')
    await reset()
    await page.mouse.wheel(0, 7)
    await expect.poll(() => zoomOf(page)).toBeCloseTo(0.93, 2)
    await reset()
    await page.mouse.wheel(0, -100)
    await expect.poll(() => zoomOf(page)).toBeCloseTo(1.1, 2)
    // it is not a pan: the top-left only moved with the zoom's pivot, never by a notch of 100 px
    await reset()
    await page.mouse.wheel(0, 100)
    await expect.poll(() => zoomOf(page)).toBeCloseTo(0.9, 2)
  })

  await test.step('Ctrl + wheel still zooms and Shift + wheel pans sideways, with Mouse chosen', async () => {
    await reset()
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -100)
    await page.keyboard.up('Control')
    await expect.poll(() => zoomOf(page)).toBeGreaterThan(1.05)
    await reset()
    await page.keyboard.down('Shift')
    await page.mouse.wheel(0, 100)
    await page.keyboard.up('Shift')
    await expect.poll(async () => Math.abs((await viewport(page)).x)).toBeGreaterThan(20)
    expect(await zoomOf(page)).toBe(1)
  })

  await test.step('it is remembered in this browser and stays local: a reload keeps Mouse, nothing was written to the board', async () => {
    await page.reload()
    await waitForCanvasUx(page)
    expect(await wheelSetting()).toBe('mouse')
    await page.getByTestId('main-menu.button').click()
    await page.getByTestId('main-menu-sub.preferences-button').click()
    await page.getByTestId('main-menu-sub.input-device-button').click()
    await expect(page.getByTestId('main-menu.input-device-mouse')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('main-menu.button').click()
    await expect(page.getByTestId('main-menu-root')).toHaveCount(0)
    await reset()
    await page.mouse.wheel(0, 100)
    await expect.poll(() => zoomOf(page)).toBeCloseTo(0.9, 2)
    // back to Auto for the rest of the browser's life
    await chooseDevice('auto')
    expect(await liveCount(page)).toBe(seeded)
  })
})

// ---- tool defaults --------------------------------------------------------------------------------------------

interface Drawn {
  id: string
  type: string
  roundness: unknown
  elbowed?: boolean
}

/** Drawing with the real pointer on an empty board, and the style panel's Line row. */
async function drawing(page: Page) {
  await waitForCanvasUx(page)
  await setViewport(page, { x: 0, y: 0, zoom: 1 })
  const live = async () =>
    (await items(page)).filter((e) => !(e as { isDeleted?: boolean }).isDeleted) as unknown as Drawn[]
  let n = 0
  return {
    live,
    /** Draws 300 px long in a free place (two columns of rows) with the tool; returns the new element. */
    async draw(toolName: string): Promise<Drawn> {
      const known = new Set((await live()).map((e) => e.id))
      expect(await setTool(page, toolName)).toBe(true)
      const box = await page.locator('canvas.excalidraw__canvas.interactive').boundingBox()
      if (!box) throw new Error('no canvas')
      const y = box.y + 140 + Math.floor(n / 2) * 110
      const x = box.x + box.width * (n++ % 2 === 0 ? 0.12 : 0.5)
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 150, y + 40, { steps: 8 })
      await page.mouse.move(x + 300, y + 60, { steps: 8 })
      await page.mouse.up()
      await expectSaved(page)
      const made = (await live()).filter((e) => !known.has(e.id))
      expect(made.length).toBe(1)
      return made[0] as Drawn
    },
    async pickKind(kind: 'straight' | 'curved' | 'elbow') {
      await expect(page.getByTestId('style.arrow-kind')).toBeVisible()
      await page.getByTestId(`style.arrow-kind.${kind}`).click()
      await expect(page.getByTestId(`style.arrow-kind.${kind}`)).toHaveAttribute('aria-pressed', 'true')
    },
  }
}

test('W5-52: a freshly drawn rectangle has sharp corners (roundness null), as a template’s and a converted shape’s do', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const { draw } = await drawing(a.page)
  const r = await draw('rectangle')
  expect(r.type).toBe('rectangle')
  expect(r.roundness).toBeNull()
  // a diamond too: the engine's rounded default is one setting for every shape (`currentItemRoundness`)
  expect((await draw('diamond')).roundness).toBeNull()
})

test('W5-40 (CR-W5-3A-1): new connectors are straight, Straight after Elbow draws a straight one (it drew a curved one), and a connector pick never rounds the next rectangle', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  const { draw, live, pickKind } = await drawing(page)

  await test.step('the first connector, before anything is picked, is straight', async () => {
    const c = await draw('arrow')
    expect(c.type).toBe('arrow')
    expect(c.roundness).toBeNull()
    expect(c.elbowed ?? false).toBe(false)
  })

  await test.step('the Line row shows Straight while the arrow tool is on, and Elbow draws an elbow connector', async () => {
    await setTool(page, 'arrow')
    await expect(page.getByTestId('style.arrow-kind.straight')).toHaveAttribute('aria-pressed', 'true')
    await pickKind('elbow')
    const e = await draw('arrow')
    expect(e.elbowed).toBe(true)
  })

  await test.step('Straight after Elbow draws a straight connector (it drew a curved one)', async () => {
    await setTool(page, 'arrow')
    await expect(page.getByTestId('style.arrow-kind.elbow')).toHaveAttribute('aria-pressed', 'true')
    await pickKind('straight')
    const s = await draw('arrow')
    expect(s.elbowed ?? false).toBe(false)
    expect(s.roundness).toBeNull()
  })

  await test.step('Curved draws a curved one, and the next rectangle keeps its sharp corners', async () => {
    await setTool(page, 'arrow')
    await pickKind('curved')
    const c = await draw('arrow')
    expect(c.elbowed ?? false).toBe(false)
    expect(c.roundness).not.toBeNull()
    const r = await draw('rectangle')
    expect(r.roundness).toBeNull()
  })

  await test.step('picking Straight on a selected curved connector straightens it, and sets the next one’s kind without rounding the next rectangle', async () => {
    const curved = (await live()).filter((e) => e.type === 'arrow' && e.roundness !== null).at(-1)
    if (!curved) throw new Error('no curved connector')
    await select(page, [curved.id])
    await expect(page.getByTestId('style.arrow-kind.curved')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('style.arrow-kind.straight').click()
    await expect
      .poll(async () => ((await live()).find((e) => e.id === curved.id) as Drawn).roundness)
      .toBeNull()
    await withCanvas(page, (c) => c.select([]), null)
    const next = await withCanvas(page, (c) => c.styles.next(), null)
    expect(next.arrowKind).toBe('straight')
    expect(next.roundness).toBe('sharp')
    const s = await draw('arrow')
    expect(s.roundness).toBeNull()
    const r = await draw('rectangle')
    expect(r.roundness).toBeNull()
  })

  await test.step('nothing but the drawn shapes was written to the board', async () => {
    await expectSaved(page)
    const types = (await live()).map((e) => e.type).sort()
    expect(types.filter((t) => t === 'rectangle').length).toBe(2)
    expect(types.filter((t) => t === 'arrow').length).toBe(5)
  })
})
