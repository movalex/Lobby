// Wave N (WS5, N5-3): a diagram from a photo is a real, editable diagram, on two tabs against the real sync: alice
// captures a whiteboard photo (Diagram; the capture answered by ai-kit.ts fakeCapture's canned 5-node flow) and
// applies it; bob sees it all and pushes nothing; no connector of alice's was ever pushed with its geometry after its
// creation (the room derives the bound ends: her push log, read through the board's push hook); dragging a node keeps
// its connectors bound, re-snapped by the room on both tabs; and Ctrl+Z takes the whole diagram back in one step.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n5-capture-diagram --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type ElementsById, resnapArrow } from '../../packages/canvas-schema/src/engine/index.ts'
import type { Op } from '../../packages/canvas-schema/src/protocol.ts'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  test as base,
  type CanvasElement,
  createNote,
  expect,
  expectConverged,
  expectSaved,
  item,
  itemCenterOnScreen,
  items,
  pushedOps,
  select,
  setViewport,
} from '../tests/support/canvas.ts'
import {
  AI_API_ENV_3H,
  aiButton,
  captureDialog,
  continueCaptureNotice,
  FAKE_OPENAI_PORT_3H,
  fakeCapture,
  openCaptureFromMenu,
  phonePhoto,
} from './ai-kit.ts'
import { focusBoard } from './board-kit.ts'

const test = base.extend<object, { openai: FakeOpenAi }>({
  openai: [
    async ({ stack: _ }, use) => {
      const fake = await startFakeOpenAi(FAKE_OPENAI_PORT_3H)
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

test.use({ viewport: { width: 1440, height: 900 }, apiEnv: AI_API_ENV_3H })

type Arrow = CanvasElement & {
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
}
const SHAPES = ['rectangle', 'diamond', 'ellipse']
const aiMade = async (page: Page) =>
  (await items(page)).filter((e) => (e.customData as { lobby?: { ai?: unknown } } | undefined)?.lobby?.ai)

/** Whether the stored connector is exactly what the room's re-snap derives from its bound shapes. */
function serverDerived(arrow: Arrow, all: readonly CanvasElement[]): boolean {
  const map = new Map(all.map((e) => [e.id, e])) as unknown as ElementsById
  return !resnapArrow(arrow as never, map).changed
}

/** Ops this tab pushed for `id`: its creation, and its patches with the groups they wrote. */
async function opsFor(page: Page, id: string): Promise<{ k: string; groups: string[] }[]> {
  const out: { k: string; groups: string[] }[] = []
  for (const rec of await pushedOps(page))
    for (const op of rec.ops as readonly Op[]) {
      if (op.k === 'c' ? op.el.id !== id : op.id !== id) continue
      out.push({
        k: op.k,
        groups:
          op.k === 'p'
            ? [...Object.keys(op.g ?? {}), ...(op.b ? ['bound'] : []), ...(op.c ? ['custom'] : [])]
            : [],
      })
    }
  return out
}

test('N5-3: a photo’s diagram on two tabs: the peer pushes nothing, no endpoint push, bound after a move, one undo', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  for (const p of [a.page, b.page]) await setViewport(p, { x: -200, y: -200, zoom: 0.5 })
  const anchor = await createNote(a.page, { x: 0, y: 0, text: 'Before' })
  await expectSaved(a.page)
  await select(a.page, [anchor])
  await expect(aiButton(a.page)).toBeVisible({ timeout: 20_000 })
  await select(a.page, [])
  await expectConverged(a.page, [b.page])
  const bobPushes = (await pushedOps(b.page)).length
  const before = (await items(a.page)).map((e) => e.id).sort()

  const fake = await fakeCapture(a.page)
  await test.step('alice captures the whiteboard as a diagram and applies it', async () => {
    await focusBoard(a.page)
    await openCaptureFromMenu(a.page)
    await captureDialog(a.page).getByTestId('capture-mode-diagram').check()
    await captureDialog(a.page)
      .getByTestId('capture-choose-file')
      .setInputFiles({
        name: 'whiteboard.jpg',
        mimeType: 'image/jpeg',
        buffer: await phonePhoto(a.page, 1600, 1200),
      })
    await continueCaptureNotice(a.page)
    await expect(a.page.getByTestId('ai-preview-summary')).toHaveText('Adds 5 shapes and 5 connectors', {
      timeout: 20_000,
    })
    await a.page.getByTestId('ai-preview-apply').click()
    await expect
      .poll(async () => (await aiMade(a.page)).filter((e) => SHAPES.includes(e.type)).length)
      .toBe(5)
    await expectSaved(a.page)
    expect(fake.calls.map((c) => [c.kind, c.mode])).toEqual([['photo', 'diagram']])
  })

  let arrows: Arrow[] = []
  await test.step('bob sees every shape and connector, the ends the room’s; bob pushed nothing; alice no endpoint', async () => {
    await expect.poll(async () => (await aiMade(b.page)).filter((e) => e.type === 'arrow').length).toBe(5)
    await expectConverged(a.page, [b.page])
    arrows = (await items(b.page)).filter((e) => e.type === 'arrow') as Arrow[]
    const all = await items(b.page)
    for (const arrow of arrows) {
      expect(arrow.startBinding?.elementId && arrow.endBinding?.elementId, arrow.id).toBeTruthy()
      expect(serverDerived(arrow, all), arrow.id).toBe(true)
      // alice pushed the connector's geometry once, in its creation, and never a patch of it
      const ops = await opsFor(a.page, arrow.id)
      expect(
        ops.filter((o) => o.k === 'c'),
        arrow.id,
      ).toHaveLength(1)
      expect(
        ops.filter((o) => o.k === 'p' && o.groups.includes('path')),
        arrow.id,
      ).toEqual([])
    }
    expect((await pushedOps(b.page)).length).toBe(bobPushes)
  })

  await test.step('alice drags a node: its connectors stay bound and are re-snapped by the room on both tabs', async () => {
    const node = arrows[0]?.startBinding?.elementId as string
    const was = (await item(b.page, arrows[0]?.id as string)) as Arrow
    const c = await itemCenterOnScreen(a.page, node)
    await a.page.mouse.move(c.x, c.y)
    await a.page.mouse.down()
    await a.page.mouse.move(c.x - 30, c.y + 120, { steps: 8 })
    await a.page.mouse.up()
    await expectSaved(a.page)
    await expect
      .poll(async () => {
        const now = (await item(b.page, was.id)) as Arrow
        return now.version !== was.version && serverDerived(now, await items(b.page))
      })
      .toBe(true)
    await expectConverged(a.page, [b.page])
    for (const p of [a.page, b.page]) {
      const all = await items(p)
      for (const arrow of all.filter((e) => e.type === 'arrow') as Arrow[]) {
        expect(arrow.startBinding?.elementId && arrow.endBinding?.elementId, arrow.id).toBeTruthy()
        expect(serverDerived(arrow, all), arrow.id).toBe(true)
      }
    }
    for (const arrow of arrows)
      expect(
        (await opsFor(a.page, arrow.id)).filter((o) => o.k === 'p' && o.groups.includes('path')),
      ).toEqual([])
    expect((await pushedOps(b.page)).length).toBe(bobPushes)
  })

  await test.step('Ctrl+Z: the drag, then the whole diagram in one step, on both tabs', async () => {
    await focusBoard(a.page)
    await a.page.keyboard.press('ControlOrMeta+z') // the drag
    await a.page.keyboard.press('ControlOrMeta+z') // the capture
    await expect.poll(async () => (await items(a.page)).map((e) => e.id).sort()).toEqual(before)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
    expect((await items(b.page)).map((e) => e.id).sort()).toEqual(before)
    expect((await pushedOps(b.page)).length).toBe(bobPushes)
  })
})
