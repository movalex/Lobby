// The board page's engine change requests of wave 3/3b, landed by 2C at wave 5:
//  - CR-3A-8: read-only roles may use the laser (it writes nothing);
//  - CR-3A-9: the e2e facade's `tool` / `setTool` go through the LobbyCanvas (the highlighter, a viewer's Hand);
//  - CR-3A-10: a resize of the canvas tells `viewportChanged` readers (`viewport.screenRect()` is reactive).
// And wave 4b's (the security sweep and the cut-over gap list):
//  - XSS-F1: an SVG export of a board with a link card (an element with a `link`) succeeds, with no link in it;
//  - GAP-1: the facade's `children(frameId)` is installed on the page.
import type { Page } from '@playwright/test'
import type { LobbyCanvas } from '../../apps/web/src/canvas/api/lobby-canvas.ts'
import {
  children,
  createItem,
  deleteItem,
  expect,
  expectSaved,
  item,
  setTool,
  test,
  tool,
  waitForItem,
} from '../tests/support/canvas.ts'
import { exportSvg } from './mindmap-kit.ts'

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

test('XSS-F1: an SVG export of a board with a link card succeeds and carries no link (the scene keeps it)', async ({
  canvasSession,
}) => {
  // Excalidraw's exportToSvg wraps a linked element in <a href>, a reference outside the file, so one link
  // card refused the SVG export of the board or frame for everyone ("not self-contained"). The export's own
  // copies now have no link (canvas/export/select.ts withoutLinks).
  const a = await canvasSession('alice')
  const url = 'https://example.com/brief?x=1'
  const card = await createItem(a.page, 'rectangle', {
    x: 100,
    y: 100,
    width: 320,
    height: 96,
    roughness: 0,
    roundness: { type: 3, value: 12 },
    link: url,
    customData: { lobby: { kind: 'link-card' } },
  })
  const box = await createItem(a.page, 'rectangle', { x: 500, y: 100, width: 100, height: 100 })
  await expectSaved(a.page)
  expect(((await item(a.page, card)) as { link?: string } | null)?.link).toBe(url)
  for (const ids of [[card, box], [card]]) {
    const svg = await exportSvg(a.page, ids)
    expect(svg, 'the export part is landed').not.toBeNull()
    expect(svg).toContain('<svg')
    expect(svg).not.toContain('<a ')
    expect(svg).not.toContain('example.com')
  }
  expect(((await item(a.page, card)) as { link?: string } | null)?.link).toBe(url)
})

test('GAP-1: the facade’s children(frameId) lists a frame’s live children in paint order', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const frame = await createItem(a.page, 'frame', { x: 0, y: 0, width: 600, height: 400 })
  const c1 = await createItem(a.page, 'rectangle', { x: 20, y: 20, width: 80, height: 80, frameId: frame })
  const c2 = await createItem(a.page, 'rectangle', { x: 200, y: 20, width: 80, height: 80, frameId: frame })
  const loose = await createItem(a.page, 'rectangle', { x: 900, y: 20, width: 80, height: 80 })
  await expectSaved(a.page)
  await waitForItem(a.page, c2, (e) => e.frameId === frame)
  expect(await children(a.page, frame)).toEqual([c1, c2])
  expect(await children(a.page, loose)).toEqual([])
  await deleteItem(a.page, c1)
  await expectSaved(a.page)
  expect(await children(a.page, frame)).toEqual([c2])
})
