// Wave 5 (owner 2D): the templates as people meet them on the Excalidraw board page, inserted by the page
// itself (`?template=`, 3b's insert: the browser builds the scene with its own measurements and the server
// stores it). docs/research/excalidraw/REVIEW-W5-EARLY.md:
//   - W5-59: inside a frame the keyboard reads the heading first, then the instruction line under it
//     (Ctrl/Cmd+Shift+↓ goes into the frame on its first item in reading order, Alt+→ steps on);
//   - D3 (W5-16, W5-17): headings and title cards in the display face (Lilita One once the server accepts
//     it), the tour's type samples named after the faces they are set in, its Tips frame with this page's
//     keys, as a second person receives them;
//   - W5-05: moving a template frame takes its locked heading along and stays Saved (2A's lock rule).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- templates-frames
import type { Page } from '@playwright/test'
import type { PlanFrame, PlanNode } from '../../packages/templates/src/builder.ts'
import { planTemplate, TEMPLATE_INFOS, type TemplateId } from '../../packages/templates/src/plan.ts'
import { DISPLAY_FACE_AVAILABLE, FONT_FAMILY } from '../../packages/templates/src/scene/index.ts'
import {
  type CanvasElement,
  expect,
  expectSaved,
  items,
  openCanvasSession,
  sceneToScreen,
  select,
  selectNone,
  test,
  viewport,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { focusCanvas, selected } from './a11y-kit.ts'
import { countOf, waitForNavigation } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

type El = CanvasElement & Record<string, unknown>

/** Opens the board with `?template=<id>` (an empty board gets the template once) and waits for its frames. */
async function openWithTemplate(page: Page, board: string, id: TemplateId): Promise<El[]> {
  await page.goto(`/b/${board}?template=${id}`)
  await waitForNavigation(page)
  const frames = TEMPLATE_INFOS.find((t) => t.id === id)?.sections.length ?? 0
  await expect.poll(() => countOf(page, 'frame'), { timeout: 30_000 }).toBe(frames)
  await expectSaved(page)
  return (await items(page)) as El[]
}

/** Each frame's heading and, when it has one, the grey instruction line right after it (plan order). */
function headingsOf(id: TemplateId): Map<string, string[]> {
  const nodes: readonly PlanNode[] = planTemplate(id, { x: 0, y: 0 }).nodes
  const out = new Map<string, string[]>()
  for (const f of nodes.filter((n): n is PlanFrame => n.kind === 'frame')) {
    const [heading, second] = nodes.filter((n) => n.parent === f)
    const words: string[] = []
    if (heading?.kind === 'text') words.push(heading.scene.text)
    if (second?.kind === 'text' && second.locked && second.color === 'grey') words.push(second.scene.text)
    out.set(f.name, words)
  }
  return out
}

const frameNamed = (els: readonly El[], name: string) =>
  els.find((e) => e.type === 'frame' && e.name === name) as El
const textIn = (els: readonly El[], frameId: string, words: string) =>
  els.find((e) => e.type === 'text' && e.frameId === frameId && e.originalText === words) as El | undefined

test('W5-59: in every frame of the tour and the retrospective the keyboard reads the heading first, then its instruction line', async ({
  canvasSession,
  board,
  users,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const boards: Record<string, string> = {
    'lobby-tour': board,
    retrospective: await users.createBoard('W5-59 retrospective'),
  }
  for (const [id, b] of Object.entries(boards) as [TemplateId, string][]) {
    await test.step(id, async () => {
      const els = await openWithTemplate(a.page, b, id)
      for (const [name, words] of headingsOf(id)) {
        const f = frameNamed(els, name)
        const ids = words.map((w) => textIn(els, f.id, w)?.id)
        expect(ids.every(Boolean), `${name}: ${words.join(' / ')}`).toBe(true)
        await select(a.page, [f.id])
        await focusCanvas(a.page)
        await a.page.keyboard.press('ControlOrMeta+Shift+ArrowDown')
        await expect.poll(() => selected(a.page), { message: `${name}: into the frame` }).toEqual([ids[0]])
        if (ids[1]) {
          await a.page.keyboard.press('Alt+ArrowRight')
          await expect.poll(() => selected(a.page), { message: `${name}: then` }).toEqual([ids[1]])
        }
      }
      await selectNone(a.page)
    })
  }
})

test('D3: the tour as a second person receives it: headings and title cards in the display face, type samples named after their faces, this page’s keys', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(120_000)
  const a = await canvasSession('alice')
  const inserted = await openWithTemplate(a.page, board, 'lobby-tour')
  const bob = await canvasSession('bob')
  await expect.poll(async () => (await items(bob.page)).length, { timeout: 30_000 }).toBe(inserted.length)
  const els = (await items(bob.page)) as El[]
  const display = FONT_FAMILY.display
  const words = (e: El) =>
    e.type === 'text'
      ? String(e.originalText)
      : String(els.find((l) => l.type === 'text' && l.containerId === e.id)?.originalText ?? '')

  // every frame's heading: the display face, 44 px, locked
  for (const f of els.filter((e) => e.type === 'frame')) {
    const heading = els.find((e) => e.frameId === f.id && e.type === 'text') as El
    expect([heading.fontFamily, heading.fontSize, heading.locked], String(f.name)).toEqual([
      display,
      44,
      true,
    ])
  }
  // title cards: the themes, the retro headers and the keys
  const titleCards = [
    'Gameplay',
    'Went well',
    'F6\nKeyboard to the board',
    'Ctrl + Shift + Up\nOut of a frame',
  ]
  for (const t of titleCards) {
    const card = els.find((e) => e.type === 'rectangle' && words(e) === t) as El | undefined
    const label = els.find((l) => l.type === 'text' && l.containerId === card?.id)
    expect(label?.fontFamily, t).toBe(display)
  }
  // no comic or hand-drawn face anywhere; the samples say which face they are set in
  const families = new Set(els.filter((e) => e.type === 'text').map((e) => e.fontFamily))
  expect([...families].sort()).toEqual([...new Set([6, display])].sort())
  const roles = els.filter((e) => e.type === 'text' && /^(Display|Body|HUD) · /.test(words(e))).map(words)
  expect(roles).toEqual(
    DISPLAY_FACE_AVAILABLE
      ? ['Display · Lilita One', 'Body · Nunito', 'HUD · Lilita One']
      : ['Display · sans', 'Body · sans', 'HUD · sans'],
  )
  const tips = els.filter((e) => e.frameId === frameNamed(els, '6 · Tips and shortcuts').id).map(words)
  expect(tips.join(' ')).toMatch(
    /Press \? for every other shortcut, or open Keyboard shortcuts from the menu/,
  )
  expect(tips.join(' ')).not.toMatch(/main menu/)
})

/** Drags the frame by its name (Excalidraw's frame-name element) by `delta` screen pixels. */
async function dragFrameByName(page: Page, frameId: string, delta: { x: number; y: number }): Promise<void> {
  const name = page.locator(`[id$="-frame-name-${frameId}"]`)
  await expect(name).toBeVisible()
  const box = await name.boundingBox()
  if (!box) throw new Error(`no name box for ${frameId}`)
  const from = { x: box.x + Math.min(20, box.width / 2), y: box.y + box.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + delta.x, from.y + delta.y, { steps: 10 })
  await page.mouse.up()
}

test('W5-05: moving each frame of every template takes its locked heading and instructions along and stays Saved, for a second person too', async ({
  browser,
  canvasSession,
  board,
  users,
}) => {
  test.fail(
    true,
    "W5-05 (2A's lock rule, apps/sync/src/room/merge.ts): the room refuses the locked heading's move that " +
      'follows its frame ("Change not saved — that object is locked"), so the heading stays behind',
  )
  test.setTimeout(300_000)
  const a = await canvasSession('alice')
  for (const t of TEMPLATE_INFOS) {
    await test.step(t.id, async () => {
      const b = t.id === 'lobby-tour' ? board : await users.createBoard(`W5-05 ${t.id}`)
      const before = await openWithTemplate(a.page, b, t.id)
      const bob = await openCanvasSession(browser, b, await users.grant(b, 'bob', 'editor'))
      await expect.poll(async () => (await items(bob.page)).length, { timeout: 30_000 }).toBe(before.length)
      for (const f of before.filter((e) => e.type === 'frame')) {
        const locked = before.filter((e) => e.frameId === f.id && e.locked)
        expect(locked.length, String(f.name)).toBeGreaterThan(0)
        await zoomToFit(a.page)
        await selectNone(a.page)
        const z = (await viewport(a.page)).zoom
        const start = await sceneToScreen(a.page, { x: f.x, y: f.y })
        expect(start.y).toBeGreaterThan(0)
        await dragFrameByName(a.page, f.id, { x: 0, y: 60 })
        await expectSaved(a.page)
        const moved = (await items(bob.page)) as El[]
        const fNow = moved.find((e) => e.id === f.id) as El
        const dy = fNow.y - f.y
        expect(dy, String(f.name)).toBeGreaterThan(30 / z)
        // everything in the frame went with it, the locked heading and instructions included
        for (const k of before.filter((e) => e.frameId === f.id)) {
          const now = moved.find((e) => e.id === k.id) as El
          expect(now.y - k.y, `${f.name}: "${String(k.originalText ?? k.type)}"`).toBeCloseTo(dy, 0)
        }
      }
      await bob.context.close()
    })
  }
})
