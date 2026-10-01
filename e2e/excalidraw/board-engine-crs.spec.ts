// The board page's engine change requests of wave 3/3b, landed by 2C at wave 5:
//  - CR-3A-8: read-only roles may use the laser (it writes nothing);
//  - CR-3A-9: the e2e facade's `tool` / `setTool` go through the LobbyCanvas (the highlighter, a viewer's Hand);
//  - CR-3A-10: a resize of the canvas tells `viewportChanged` readers (`viewport.screenRect()` is reactive).
import type { Page } from '@playwright/test'
import type { LobbyCanvas } from '../../apps/web/src/canvas/api/lobby-canvas.ts'
import { expect, setTool, test, tool } from '../tests/support/canvas.ts'

async function withCanvas<T, A>(page: Page, fn: (canvas: LobbyCanvas, arg: A) => T, arg: A): Promise<T> {
  return (await page.evaluate(
    ({ src, arg }) => {
      const b = (window as unknown as { __lobbyBoard?: { canvas: unknown } }).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard')
      const f = new Function(`return (${src})`)() as (c: unknown, a: unknown) => unknown
      return f(b.canvas, arg)
    },
    { src: fn.toString(), arg },
  )) as T
}

test('CR-3A-8: a viewer picks the laser (and nothing that writes)', async ({ canvasSession }) => {
  const v = await canvasSession('carol', { role: 'viewer' })
  expect(await withCanvas(v.page, (c) => c.setTool('laser'), null)).toBe(true)
  await expect.poll(() => withCanvas(v.page, (c) => c.tool(), null)).toBe('laser')
  expect(await withCanvas(v.page, (c) => c.setTool('rectangle'), null)).toBe(false)
  await expect.poll(() => withCanvas(v.page, (c) => c.tool(), null)).toBe('laser')
})

test('CR-3A-9: the facade reports the tool the canvas reports (the highlighter, a viewer’s Hand)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  expect(await setTool(a.page, 'highlight')).toBe(true)
  await expect.poll(() => tool(a.page)).toBe('highlight')
  expect(await withCanvas(a.page, (c) => c.tool(), null)).toBe('highlight')
  await setTool(a.page, 'select')
  await expect.poll(() => tool(a.page)).toBe('select')
  const v = await canvasSession('carol', { role: 'viewer' })
  expect(await setTool(v.page, 'hand')).toBe(true)
  await expect.poll(() => tool(v.page)).toBe('hand')
})

test('CR-3A-10: resizing the window tells viewportChanged readers, with the new canvas size', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await a.page.evaluate(() => {
    const w = window as unknown as {
      __lobbyBoard: { canvas: LobbyCanvas }
      __vpLog?: number[]
    }
    w.__vpLog = []
    w.__lobbyBoard.canvas.on('viewportChanged', () => {
      w.__vpLog?.push(w.__lobbyBoard.canvas.viewport.screenRect().width)
    })
  })
  const before = await withCanvas(a.page, (c) => c.viewport.screenRect().width, null)
  const size = a.page.viewportSize() ?? { width: 1280, height: 720 }
  await a.page.setViewportSize({ width: size.width - 200, height: size.height })
  await expect
    .poll(() => a.page.evaluate(() => (window as unknown as { __vpLog?: number[] }).__vpLog?.at(-1) ?? null))
    .toBe(before - 200)
})
