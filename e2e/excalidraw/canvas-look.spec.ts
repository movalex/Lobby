// Wave C, workstream C1 (the canvas look) on the Excalidraw board page:
//  - CR-3A-7: with the note or text tool picked, the style panel sets the next note's or text's style;
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e exec playwright test excalidraw/canvas-look.spec.ts
import type { Page } from '@playwright/test'
import {
  createNote,
  expect,
  expectSaved,
  item,
  items,
  setTool,
  TEXT_EDITOR,
  test,
  tool,
} from '../tests/support/canvas.ts'
import { focusBoard, settled } from './board-kit.ts'
import { waitForCanvasUx } from './canvas-ux-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

type El = { id: string; type: string; x: number; y: number; width: number; height: number } & Record<
  string,
  unknown
>

/** A point on the canvas at (fx, fy) of its box. */
async function canvasPoint(page: Page, fx: number, fy: number) {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  return { x: box.x + box.width * fx, y: box.y + box.height * fy }
}

/** Makes an element by hand with the picked tool (a click, the editor, words, Escape); returns what it made. */
async function makeByHand(page: Page, at: { x: number; y: number }, words: string): Promise<El[]> {
  const before = new Set((await items(page)).map((e) => e.id))
  await page.mouse.click(at.x, at.y)
  const editor = page.locator(TEXT_EDITOR)
  await expect(editor).toBeFocused({ timeout: 15_000 })
  await expect(editor).toHaveJSProperty('readOnly', false, { timeout: 15_000 })
  await expectSaved(page)
  await page.keyboard.type(words, { delay: 15 })
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await expectSaved(page)
  return ((await items(page)) as unknown as El[]).filter((e) => !before.has(e.id))
}

test('CR-3A-7: the note tool’s panel sets the next note’s colour, size and font; the text tool’s the next text’s colour, size, font and alignment', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  await focusBoard(a.page)
  const palette = a.page.getByTestId('note-palette')

  await test.step('the note tool', async () => {
    await setTool(a.page, 'note')
    await expect(palette).toBeVisible()
    // Lobby's default note colour is the one pressed until another is picked
    await expect(palette.locator('[data-color="black"]')).toHaveAttribute('aria-pressed', 'true')
    await palette.locator('[data-color="light-blue"]').click()
    await a.page.getByTestId('style.size.l').click()
    await a.page.getByTestId('style.font.mono').click()
    await expect(palette.locator('[data-color="light-blue"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(a.page.getByTestId('style.size.l')).toHaveAttribute('aria-pressed', 'true')
    await expect(a.page.getByTestId('style.font.mono')).toHaveAttribute('aria-pressed', 'true')
    expect(await tool(a.page)).toBe('note')
    const made = await makeByHand(a.page, await canvasPoint(a.page, 0.75, 0.6), 'Sky')
    const note = made.find((e) => e.type === 'stickynote')
    const label = made.find((e) => e.type === 'text')
    expect(note?.backgroundColor).toBe('#a6d8f3')
    // the label: Large (tldraw's label size 26) in Mono (Comic Shanns, 8)
    expect(label?.fontFamily).toBe(8)
    expect(label?.baseFontSize ?? label?.fontSize).toBe(26)
  })

  await test.step('the text tool', async () => {
    await setTool(a.page, 'text')
    await a.page.getByTestId('style.color.blue').click()
    await a.page.getByTestId('style.size.xl').click()
    await a.page.getByTestId('style.font.draw').click()
    await a.page.getByTestId('style.align.center').click()
    await expect(a.page.getByTestId('style.size.xl')).toHaveAttribute('aria-pressed', 'true')
    const made = await makeByHand(a.page, await canvasPoint(a.page, 0.3, 0.6), 'Title')
    const text = made.find((e) => e.type === 'text')
    expect(text).toMatchObject({
      strokeColor: '#4465e9',
      fontSize: 44,
      fontFamily: 5,
      textAlign: 'center',
    })
  })

  await test.step('a note named with a colour of its own keeps it (a feature’s note)', async () => {
    const id = await settled(a.page, createNote(a.page, { x: -600, y: -600, text: 'own', color: '#f4a874' }))
    expect((await item(a.page, id))?.backgroundColor).toBe('#f4a874')
  })
})
