// W3 (wave L, L3-3): plain-language board commands in the palette, the local grammar (AI is not set up on this
// stack, so nothing can reach /ai at all):
//  - "make all red notes yellow" works with no AI call: the Do line, then the shared preview (W2's
//    showAiPreview: more than one note changes), Apply;
//  - Apply then ONE Ctrl+Z restores every colour;
//  - a second browser sees the change and pushes nothing;
//  - a viewer's palette refuses the write (and says why), and finds instead.
//
// The preview is W2's (features/ai/ported/public.ts). These specs press its Apply button by
// data-testid="ai-preview-apply"; with the foundation's stub (it resolves 'discard') nothing is applied.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l3-commands.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import {
  createNote,
  expect,
  expectSaved,
  item,
  pushedOps,
  selection,
  test,
  waitForItem,
} from '../tests/support/canvas.ts'
import { focusCanvas, inView } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/** Lobby's note fills (board-ops palette.ts NOTE_FILL, light): what a palette name stores on a note. */
const FILL = { red: '#ef8c82', yellow: '#f6c453', blue: '#a7b7f6' } as const

const palette = (page: Page) => page.getByTestId('command-palette')
const option = (page: Page, id: string) =>
  page.locator(`[data-testid="command-palette-option"][data-entry-id="${id}"]`)
const activeOption = (page: Page) =>
  page.locator('[data-testid="command-palette-option"][data-active="true"]')

async function openPalette(page: Page) {
  await focusCanvas(page)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByTestId('command-palette-input')).toBeFocused()
}

/** W2's shared preview: its Apply. */
async function applyPreview(page: Page) {
  const apply = page.getByTestId('ai-preview-apply')
  await expect(apply).toBeVisible({ timeout: 10_000 })
  await apply.click()
}

const fills = async (page: Page, ids: readonly string[]) =>
  Promise.all(
    ids.map(async (id) => ((await item(page, id)) as { backgroundColor?: string } | null)?.backgroundColor),
  )

/** Every POST to the AI route this page makes. */
function aiCalls(page: Page): string[] {
  const out: string[] = []
  page.on('request', (r) => {
    if (/\/api\/boards\/[^/]+\/ai(\/|$)/.test(new URL(r.url()).pathname) && r.method() === 'POST')
      out.push(r.url())
  })
  return out
}

test('"make all red notes yellow": the grammar’s Do line, the preview, Apply; no AI call; one Ctrl+Z restores every colour; a second browser sees it and pushes nothing', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const calls = aiCalls(a.page)
  const reds: string[] = []
  for (const [i, x] of [0, 300, 600].entries()) {
    reds.push(await createNote(a.page, { x, y: 0, text: `Red ${i}`, color: FILL.red }))
    await expectSaved(a.page)
  }
  const blue = await createNote(a.page, { x: 900, y: 0, text: 'Blue', color: FILL.blue })
  await expectSaved(a.page)
  const b = await canvasSession('bob')
  for (const id of [...reds, blue]) await waitForItem(b.page, id)
  const bobPushes = (await pushedOps(b.page)).length

  await openPalette(a.page)
  await a.page.keyboard.type('make all red notes yellow')
  await expect(activeOption(a.page)).toHaveAttribute('data-entry-id', 'do:grammar')
  await expect(activeOption(a.page)).toContainText('Make 3 red notes yellow')
  await a.page.keyboard.press('Enter')
  await expect(palette(a.page)).toHaveCount(0)
  // three notes change: the shared preview first, nothing written before Apply
  await expect(a.page.getByTestId('ai-preview-apply')).toBeVisible({ timeout: 10_000 })
  expect(await fills(a.page, reds)).toEqual([FILL.red, FILL.red, FILL.red])
  await applyPreview(a.page)
  await expect.poll(() => fills(a.page, reds)).toEqual([FILL.yellow, FILL.yellow, FILL.yellow])
  expect(await fills(a.page, [blue])).toEqual([FILL.blue])
  await expectSaved(a.page)

  // the other browser sees every colour, and pushes nothing while it watches
  await expect.poll(() => fills(b.page, reds)).toEqual([FILL.yellow, FILL.yellow, FILL.yellow])
  expect((await pushedOps(b.page)).length).toBe(bobPushes)

  // one undo step: one Ctrl+Z puts every colour back
  await focusCanvas(a.page)
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => fills(a.page, reds)).toEqual([FILL.red, FILL.red, FILL.red])
  await expectSaved(a.page)
  await expect.poll(() => fills(b.page, reds)).toEqual([FILL.red, FILL.red, FILL.red])
  expect((await pushedOps(b.page)).length).toBe(bobPushes)
  // grammar only: AI was never asked
  expect(calls).toEqual([])
})

test('a viewer’s palette refuses a change and says why; "find the red notes" selects and shows them, writing nothing', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const red = await createNote(a.page, { x: 4000, y: 3000, text: 'Far red', color: FILL.red })
  await expectSaved(a.page)
  const v = await canvasSession('carol', { role: 'viewer' })
  await waitForItem(v.page, red)
  await openPalette(v.page)
  await v.page.keyboard.type('make all red notes yellow')
  const line = option(v.page, 'do:grammar')
  await expect(line).toHaveAttribute('aria-disabled', 'true')
  await expect(line.getByTestId('command-palette-reason')).toHaveText(/not change it/)
  await v.page.keyboard.press('Enter')
  await expect(v.page.getByTestId('command-palette-status')).toContainText('not change it')
  await expect(palette(v.page)).toBeVisible()
  await v.page.getByTestId('command-palette-input').fill('find the red notes')
  await expect(activeOption(v.page)).toContainText('Find 1 red note')
  await v.page.keyboard.press('Enter')
  await expect(palette(v.page)).toHaveCount(0)
  await expect.poll(() => selection(v.page)).toEqual([red])
  await expect.poll(() => inView(v.page, [red])).toBe(true)
  expect((await pushedOps(v.page)).length).toBe(0)
  expect(await fills(a.page, [red])).toEqual([FILL.red])
})
