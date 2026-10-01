// W5-05 (wave 5, owner 2A, the room's lock rule): moving a template frame moves its locked heading and
// description with it, the board stays Saved, and the other person sees the whole frame where it went.
// Every template arrives with locked headings (RETRO-16). Before, the room refused the locked members'
// moves (LOCKED: "Change not saved — that object is locked") and kept the split. One test per template,
// through `?template=` on an empty board, dragging every frame with the real pointer.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- sync-room-frames
import type { Page } from '@playwright/test'
import {
  type CanvasElement,
  expect,
  expectConverged,
  expectSaved,
  items,
  sceneToScreen,
  select,
  selectNone,
  test,
} from '../tests/support/canvas.ts'
import { storedElement } from '../tests/support/excalidraw.ts'
import { openPath, waitForNavigation } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const TEMPLATES = [
  'retrospective',
  'brainstorm',
  'storyboard',
  'mood-board',
  'pitch-outline',
  'production-plan',
  'lobby-tour',
] as const

/** An empty spot of frame `f` (no member covers it), in scene coordinates, or null. */
function emptySpot(f: CanvasElement, members: CanvasElement[]): { x: number; y: number } | null {
  const pad = 12
  for (let gy = 0.08; gy < 0.95; gy += 0.06)
    for (let gx = 0.05; gx < 0.95; gx += 0.05) {
      const x = f.x + f.width * gx
      const y = f.y + f.height * gy
      const covered = members.some(
        (m) => x >= m.x - pad && x <= m.x + m.width + pad && y >= m.y - pad && y <= m.y + m.height + pad,
      )
      if (!covered) return { x, y }
    }
  return null
}

/** Drags frame `id` by (dx, dy) screen pixels: selected first, then grabbed at an empty spot inside it. */
async function dragFrame(page: Page, id: string, dx: number, dy: number): Promise<boolean> {
  const all = await items(page)
  const f = all.find((e) => e.id === id) as CanvasElement
  const members = all.filter((e) => (e as { frameId?: string | null }).frameId === id)
  const spot = emptySpot(f, members)
  if (!spot) return false
  await select(page, [id])
  const p = await sceneToScreen(page, spot)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + dx, p.y + dy, { steps: 10 })
  await page.mouse.up()
  await selectNone(page)
  return true
}

for (const template of TEMPLATES)
  test(`${template}: each frame moves with its locked members; Saved; the other person sees the whole frame moved`, async ({
    browser,
    users,
    stack,
  }) => {
    test.setTimeout(240_000)
    const board = await users.createBoard(`Frames of ${template}`)
    await users.grant(board, 'bob', 'editor')
    const a = await openPath(browser, await users.get('alice'), `/b/${board}?template=${template}`)
    const b = await openPath(browser, await users.get('bob'), `/b/${board}`)
    try {
      await expect.poll(async () => (await items(a.page)).some((e) => e.type === 'frame')).toBe(true)
      await expectSaved(a.page)
      await waitForNavigation(b.page)
      await expectConverged(a.page, [b.page])
      const frames = (await items(a.page)).filter((e) => e.type === 'frame')
      let moved = 0
      let lockedMoved = 0
      for (const f of frames) {
        const before = await items(a.page)
        const members = before.filter((e) => (e as { frameId?: string | null }).frameId === f.id)
        const fb = before.find((e) => e.id === f.id) as CanvasElement
        if (!(await dragFrame(a.page, f.id, 60, 40))) continue
        await expectSaved(a.page)
        const after = await items(a.page)
        const fa = after.find((e) => e.id === f.id) as CanvasElement
        const d = { x: fa.x - fb.x, y: fa.y - fb.y }
        if (Math.abs(d.x) < 1 && Math.abs(d.y) < 1) continue // the drag did not take the frame
        moved++
        // every member, locked or not, moved by the frame's delta (here and on the server)
        for (const m of members) {
          const ma = after.find((e) => e.id === m.id) as CanvasElement
          expect(Math.abs(ma.x - m.x - d.x), `${m.id} (${m.locked ? 'locked' : 'free'}) x`).toBeLessThan(1)
          expect(Math.abs(ma.y - m.y - d.y), `${m.id} y`).toBeLessThan(1)
          const stored = await storedElement(stack, board, m.id)
          expect(Math.abs((stored?.x as number) - ma.x), `${m.id} stored x`).toBeLessThan(1)
          if (m.locked) lockedMoved++
        }
        await expect(a.page.getByText('Change not saved')).toHaveCount(0)
      }
      expect(moved).toBeGreaterThan(0)
      expect(lockedMoved, 'the template has locked members that moved with their frames').toBeGreaterThan(0)
      await expectConverged(a.page, [b.page])
    } finally {
      await a.context.close()
      await b.context.close()
    }
  })
