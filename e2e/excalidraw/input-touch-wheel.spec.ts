// OWNER: B2 (wave B). Touch, wheel and tool defaults on the Excalidraw board page:
//   W5-52                  a freshly drawn rectangle has sharp corners, as templates and converted shapes do
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/input-touch-wheel.spec.ts --workers=1
import type { Page } from '@playwright/test'
import { expect, expectSaved, items, setTool, setViewport, test } from '../tests/support/canvas.ts'
import { waitForCanvasUx } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

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

