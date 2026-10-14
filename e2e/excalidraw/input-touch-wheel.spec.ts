// OWNER: B2 (wave B). Touch, wheel and tool defaults on the Excalidraw board page:
//   CR 3b-10 (W5-19)       a two-finger touch pinch goes below Excalidraw's 0.1 down to the whole-board fit,
//                          and a pinch that starts below 0.1 does not snap up to it
//   W5-33 / CR-W5-3A-4     Preferences > Input device: what a plain mouse wheel does (auto, mouse, trackpad)
//   W5-40 / CR-W5-3A-1     Straight after Elbow draws straight connectors (it drew curved ones)
//   W5-52                  a freshly drawn rectangle has sharp corners, as templates and converted shapes do
//   wave B follow-up 3     Input device Auto reads devicePixelRatio: a notch is 100 px over the ratio (125%, 150%, 200%)
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/input-touch-wheel.spec.ts --workers=1
import type { Browser, CDPSession, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
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
import type { Users } from '../tests/support/users.ts'
import { openPhoneSession } from './a11y-kit.ts'
import { emptyCanvasPoint, settled } from './board-kit.ts'
import { showStylePanel, waitForCanvasUx, withCanvas } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

// ---- two-finger touch, through the browser's own touch input (CDP) ---------------------------------------

type Pt = { x: number; y: number }

class Fingers {
  private readonly cdp: CDPSession

  private constructor(cdp: CDPSession) {
    this.cdp = cdp
  }

  static async on(page: Page): Promise<Fingers> {
    return new Fingers(await page.context().newCDPSession(page))
  }

  private send(type: 'touchStart' | 'touchMove' | 'touchEnd', points: readonly (Pt & { id: number })[]) {
    return this.cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })),
    })
  }

  /** The two fingers go down `gap` px apart around `at` (one at a time, as hands do). */
  async down(at: Pt, gap: number): Promise<void> {
    const a = { id: 1, x: at.x - gap / 2, y: at.y }
    const b = { id: 2, x: at.x + gap / 2, y: at.y }
    await this.send('touchStart', [a])
    await this.send('touchStart', [a, b])
  }

  /** Both fingers move so that they are `gap` px apart around `at`. */
  async to(at: Pt, gap: number): Promise<void> {
    await this.send('touchMove', [
      { id: 1, x: at.x - gap / 2, y: at.y },
      { id: 2, x: at.x + gap / 2, y: at.y },
    ])
  }

  /** From `from` px apart to `to` px apart in `steps` moves, with a frame between them. */
  async spread(page: Page, at: Pt, from: number, to: number, steps: number): Promise<void> {
    for (let i = 1; i <= steps; i++) {
      await this.to(at, from + ((to - from) * i) / steps)
      await page.waitForTimeout(24)
    }
  }

  async up(): Promise<void> {
    await this.send('touchEnd', [])
  }
}

const zoomOf = async (page: Page) => (await viewport(page)).zoom

/** The elements on the board (a note is two: the note and its words). */
const liveCount = async (page: Page) =>
  (await items(page)).filter((e) => !(e as { isDeleted?: boolean }).isDeleted).length

const canvasCentre = async (page: Page): Promise<Pt> => {
  const box = await page.locator('canvas.excalidraw__canvas.interactive').boundingBox()
  if (!box) throw new Error('no canvas')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test('CR 3b-10 (W5-19): a two-finger touch pinch goes below 0.1 down to the whole-board fit; one that starts below 0.1 does not snap up to it; one above 0.1 is still the engine’s', async ({
  browser,
  board,
  users,
}) => {
  const phone = await openPhoneSession(browser, board, users, 'alice')
  try {
    const page = phone.page
    // a board 6,000 px wide: its whole-board fit is below 0.1 on a phone (about 0.04)
    for (const x of [-3000, 3000]) {
      await createNote(page, { x, y: 0, text: `n${x}` })
      await expectSaved(page)
    }
    const seeded = await liveCount(page)
    const fit = await withCanvas(page, (c) => c.viewport.limits().min, null)
    expect(fit).toBeLessThan(0.08)
    expect(fit).toBeGreaterThan(0.01)
    const at = await canvasCentre(page)
    const touch = await Fingers.on(page)
    const sceneUnder = (p: Pt) => screenToScene(page, p)

    await test.step('a pinch above 0.1 is the engine’s: 1 pinched to a half is about 0.5', async () => {
      await setViewport(page, { x: -200, y: -300, zoom: 1 })
      await touch.down(at, 240)
      await touch.spread(page, at, 240, 120, 6)
      await touch.up()
      await expect.poll(() => zoomOf(page)).toBeGreaterThan(0.45)
      expect(await zoomOf(page)).toBeLessThan(0.55)
    })

    await test.step('pinching from 0.5 to a tenth of the spread goes to 0.05, below the engine’s 0.1, around the fingers', async () => {
      await setViewport(page, { x: -1500, y: -800, zoom: 0.5 })
      await touch.down(at, 300)
      // the engine pinches down to its floor; the next spread takes it below 0.1 (to about 0.097)
      await touch.spread(page, at, 300, 58, 14)
      await expect.poll(() => zoomOf(page)).toBeLessThan(0.1)
      await page.waitForTimeout(120)
      // from here the camera is Lobby's, and the scene point between the fingers stays between them
      const held = await sceneUnder(at)
      await touch.spread(page, at, 58, 30, 8)
      // still held: the camera is where the fingers have it
      await expect.poll(() => zoomOf(page)).toBeLessThan(0.07)
      expect(await zoomOf(page)).toBeGreaterThanOrEqual(fit - 1e-6)
      await touch.up()
      const z = await zoomOf(page)
      expect(z).toBeLessThan(0.07)
      expect(z).toBeGreaterThan(0.04)
      const after = await sceneUnder(at)
      expect(Math.hypot(after.x - held.x, after.y - held.y) * z).toBeLessThan(3)
      // and it is not snapped back to 0.1 once the fingers are up
      await page.waitForTimeout(400)
      expect(await zoomOf(page)).toBeCloseTo(z, 6)
    })

    await test.step('a pinch out from 0.05 grows from 0.05 (the engine snapped it to 0.1 at the first move)', async () => {
      await setViewport(page, { x: -3000, y: -1500, zoom: 0.05 })
      await touch.down(at, 100)
      await touch.to(at, 110)
      await page.waitForTimeout(60)
      await touch.to(at, 120)
      await expect.poll(() => zoomOf(page)).toBeGreaterThan(0.054)
      // one step of 20%: 0.06, nowhere near 0.1
      expect(await zoomOf(page)).toBeLessThan(0.07)
      // on up through 0.1 in the same gesture, no jump at it
      let last = await zoomOf(page)
      for (let gap = 130; gap <= 300; gap += 10) {
        await touch.to(at, gap)
        await page.waitForTimeout(24)
        const z = await zoomOf(page)
        expect(z).toBeGreaterThanOrEqual(last - 1e-9)
        expect(z).toBeLessThan(last * 1.25)
        last = z
      }
      expect(last).toBeGreaterThan(0.12)
      await touch.up()
    })

    await test.step('the pinch stops at the whole-board fit, however far the fingers close', async () => {
      await setViewport(page, { x: -1500, y: -800, zoom: 0.5 })
      await touch.down(at, 300)
      await touch.spread(page, at, 300, 4, 14)
      await touch.up()
      await expect.poll(async () => Math.abs((await zoomOf(page)) - fit)).toBeLessThan(1e-6)
    })

    await test.step('a pinch moves nothing in the document', async () => {
      await expectSaved(page)
      expect(await liveCount(page)).toBe(seeded)
    })
  } finally {
    await phone.context.close()
  }
})

test('CR 3b-10 (W5-19): a viewer on a phone, who only ever moves the camera, pinches out below 0.1 to the whole board too', async ({
  browser,
  board,
  users,
}) => {
  const owner = await openPhoneSession(browser, board, users, 'alice')
  const viewer = await openPhoneSession(browser, board, users, 'bob', 'viewer')
  try {
    for (const x of [-3000, 3000]) {
      await createNote(owner.page, { x, y: 0, text: `n${x}` })
      await expectSaved(owner.page)
    }
    const page = viewer.page
    await expect.poll(() => liveCount(page)).toBe(await liveCount(owner.page))
    expect(await withCanvas(page, (c) => c.readOnly(), null)).toBe(true)
    const fit = await withCanvas(page, (c) => c.viewport.limits().min, null)
    expect(fit).toBeLessThan(0.08)
    const at = await canvasCentre(page)
    const touch = await Fingers.on(page)
    await setViewport(page, { x: -1500, y: -800, zoom: 0.5 })
    await touch.down(at, 300)
    await touch.spread(page, at, 300, 30, 18)
    await touch.up()
    await expect.poll(() => zoomOf(page)).toBeLessThan(0.07)
    expect(await zoomOf(page)).toBeGreaterThanOrEqual(fit - 1e-6)
    // and on to the fit, from below 0.1 (the engine would snap it back up)
    await touch.down(at, 300)
    await touch.spread(page, at, 300, 4, 14)
    await touch.up()
    await expect.poll(async () => Math.abs((await zoomOf(page)) - fit)).toBeLessThan(1e-6)
  } finally {
    await viewer.context.close()
    await owner.context.close()
  }
})

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

// ---- Auto under display scaling and browser zoom (wave B follow-up 3, wave D6) ------------------------------------

/**
 * Alice on the board in a window that runs at `ratio` (Chromium's device scale factor: what Windows' 125% and
 * 150% display scaling, or the browser's zoom, make `window.devicePixelRatio`).
 */
async function openScaled(
  browser: Browser,
  board: string,
  users: Users,
  ratio: number,
  // the page's navigator.platform: the scaled-notch rule is Windows and Linux's (wave E3), so whatever host runs this
  platform: 'Win32' | 'MacIntel' = 'Win32',
) {
  const who = await users.get('alice')
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: ratio,
  })
  // injected by the browser's own protocol before the page's scripts: the page's CSP does not apply
  await context.addInitScript((p) => {
    Object.defineProperty(navigator, 'platform', { get: () => p, configurable: true })
  }, platform)
  const page = await context.newPage()
  await signInContext(context, who.handle, who.name)
  await page.goto(`/b/${board}`)
  await waitForCanvasUx(page)
  return { context, page }
}

/** One wheel event over the canvas with exactly these deltas (what a browser at that ratio would report). */
const wheelOver = (page: Page, at: Pt, deltaY: number, deltaX = 0) =>
  page.evaluate(
    ({ at, deltaY, deltaX }) => {
      const target = document.elementFromPoint(at.x, at.y) ?? document.body
      target.dispatchEvent(
        new WheelEvent('wheel', {
          clientX: at.x,
          clientY: at.y,
          deltaX,
          deltaY,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
        }),
      )
    },
    { at, deltaY, deltaX },
  )

test('wave B follow-up 3: Input device Auto reads devicePixelRatio: a mouse notch (100 px over the ratio) zooms at 125%, 150% and 200%, and a trackpad-sized step still pans', async ({
  browser,
  board,
  users,
}) => {
  for (const ratio of [1, 1.25, 1.5, 2]) {
    const { context, page } = await openScaled(browser, board, users, ratio)
    try {
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(ratio)
      expect(await withCanvas(page, (c) => c.settings.get().wheel, null)).toBe('auto')
      const at = await emptyCanvasPoint(page)
      const reset = async () => {
        await setViewport(page, { x: 0, y: 0, zoom: 1 })
        await page.mouse.move(at.x, at.y)
        // a wheel builds on the previous one while the engine may not have drawn it yet (120 ms): let that pass
        await page.waitForTimeout(200)
      }

      await test.step(`ratio ${ratio}: the notch Chromium reports there (${(100 / ratio).toFixed(2)} px) zooms 10%`, async () => {
        await reset()
        await wheelOver(page, at, Math.fround(100 / ratio))
        await expect.poll(() => zoomOf(page)).toBeCloseTo(0.9, 2)
      })

      await test.step(`ratio ${ratio}: a trackpad-sized step (33.3 px, a sideways part) is not a zoom`, async () => {
        await reset()
        await wheelOver(page, at, 33.3333, 2)
        await page.waitForTimeout(300)
        expect(await zoomOf(page)).toBe(1)
      })

      await test.step(`ratio ${ratio}: 80 px is a notch at 125% (100 / 1.25) and 150% (120 / 1.5), a plain scroll step at 100% and 200%`, async () => {
        await reset()
        await wheelOver(page, at, 80)
        if (ratio === 1.25 || ratio === 1.5) await expect.poll(() => zoomOf(page)).toBeCloseTo(0.9, 2)
        else {
          await page.waitForTimeout(300)
          expect(await zoomOf(page)).toBe(1)
        }
      })
    } finally {
      await context.close()
    }
  }
})

test('wave E3 (D6-1): on macOS the scaled notch is not a mouse: 50 px at 200% pans, an unscaled 100 px notch still zooms', async ({
  browser,
  board,
  users,
}) => {
  const { context, page } = await openScaled(browser, board, users, 2, 'MacIntel')
  try {
    expect(await page.evaluate(() => navigator.platform)).toBe('MacIntel')
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2)
    const at = await emptyCanvasPoint(page)
    const reset = async () => {
      await setViewport(page, { x: 0, y: 0, zoom: 1 })
      await page.mouse.move(at.x, at.y)
      await page.waitForTimeout(200)
    }
    await reset()
    // 100 / 2: what Chromium on Windows reports for a notch at 200%, and what a Retina trackpad can make
    await wheelOver(page, at, 50)
    await wheelOver(page, at, 60)
    await page.waitForTimeout(300)
    expect(await zoomOf(page)).toBe(1)
    await reset()
    await wheelOver(page, at, 100)
    await expect.poll(() => zoomOf(page)).toBeCloseTo(0.9, 2)
  } finally {
    await context.close()
  }
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
  // P-021: the style panel opens on request; this person has it open
  await showStylePanel(a.page)
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
