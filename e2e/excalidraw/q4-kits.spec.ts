// Wave Q, WS4: the new Shapes kits (arrows, callouts, badges, sticky-note kits, devices, storyboard frames, deliverable
// frames), inserted from the panel on the real board page against the real api and sync server. For each category,
// every piece of it is inserted by a click: it lands as the native elements the templates package builds (their count
// and kinds), in one undo step each, the room keeps every one of them (a second tab sees the same elements: nothing is
// refused and rolled back), a deliverable frame is the exact pixel size of its format with its guides locked inside,
// and no request leaves Lobby's own origins.
//
// The panel is the Shapes panel (features/pieces) until the Elements panel (WS3) replaces it; the kits come from the
// same catalogue.
//
//   E2E_PORT_BASE=7780 pnpm exec playwright test excalidraw/q4-kits --project=chromium --workers=1   (from e2e/)
import type { Page, Request } from '@playwright/test'
import { installServerTextMetrics } from '../../packages/canvas-schema/src/engine/index.ts'
import {
  instantiatePiece,
  PIECE_CATEGORIES,
  PIECES,
  type PieceId,
  pieceKind,
} from '../../packages/templates/src/pieces/index.ts'
import {
  type CanvasElement,
  expect,
  expectConverged,
  expectSaved,
  items,
  setViewport,
  test,
} from '../tests/support/canvas.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'
import { withShapesPanel } from './l8-kit.ts'
import { undoKey } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })
test.describe.configure({ timeout: 240_000 })

installServerTextMetrics()

/** Wave Q's categories (the four older ones are l8-pieces.spec.ts's). */
const NEW_CATEGORIES = PIECE_CATEGORIES.map((c) => c.id).filter(
  (id) => !['flowchart', 'wireframe', 'org-chart', 'agency'].includes(id),
)

const kindOf = (e: CanvasElement) => (e.customData as { lobby?: { kind?: string } } | undefined)?.lobby?.kind
const pieceEls = async (page: Page, id: PieceId) =>
  (await items(page)).filter((e) => kindOf(e) === pieceKind(id))

/** Every request of the page that left Lobby's own origins (none may: the e2e network assertion). */
function foreignRequests(page: Page) {
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  const foreign: string[] = []
  page.on('request', (r: Request) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!own.has(url.origin)) foreign.push(r.url())
  })
  return foreign
}

for (const category of NEW_CATEGORIES) {
  const pieces = PIECES.filter((p) => p.category === category)

  test(`Q4: the ${category} kits are inserted from the panel, each in one undo step, and the second tab sees every element`, async ({
    canvasSession,
  }, testInfo) => {
    const a = await canvasSession('alice')
    const b = await canvasSession('bob')
    const foreign = foreignRequests(a.page)
    // wave Q: the Shapes panel is the switch-off fallback (l8-kit.ts withShapesPanel); the shipped Elements panel's
    // Shapes tab inserts every category in q-int-elements.spec.ts
    await withShapesPanel(a.page)
    await setViewport(a.page, { x: 0, y: 0, zoom: 0.5 })
    await a.page.getByTestId('dock-tab-pieces').click()
    await expect(a.page.getByTestId('pieces-panel')).toBeVisible()
    // the drawings are in (the builders load on first open)
    const decision = a.page.locator('[data-piece-preview="decision"] polygon')
    await expect(decision).toHaveCount(1, { timeout: 15_000 })
    await a.page.locator(`[data-testid="piece-category"][data-category="${category}"]`).click()
    const options = a.page.getByTestId('piece-option')

    await test.step('the category lists exactly its pieces, each with a name', async () => {
      await expect
        .poll(() => options.evaluateAll((els) => els.map((e) => e.getAttribute('data-piece-id'))))
        .toEqual(pieces.map((p) => p.id))
      for (const p of pieces) await expect(a.page.locator(`[data-piece-id="${p.id}"]`)).toContainText(p.name)
    })

    const expected = new Map<PieceId, number>()
    for (const p of pieces) {
      const built = instantiatePiece(p.id, { origin: { x: 0, y: 0 } })
      expected.set(p.id, built.elements.length)
    }

    await test.step('a click on each inserts its elements (count and kind as the catalogue builds them)', async () => {
      let total = (await items(a.page)).length
      for (const p of pieces) {
        await a.page.locator(`[data-testid="piece-option"][data-piece-id="${p.id}"]`).click()
        total += expected.get(p.id) ?? 0
        await expect.poll(async () => (await items(a.page)).length, { message: p.id }).toBe(total)
        expect((await pieceEls(a.page, p.id)).length, p.id).toBe(expected.get(p.id))
      }
      await expectSaved(a.page)
    })

    await test.step('the second tab holds every one of them, unchanged by the room', async () => {
      for (const p of pieces) {
        const seen = async () => (await pieceEls(b.page, p.id)).length
        await expect.poll(seen, { message: p.id }).toBe(expected.get(p.id))
      }
      await expectConverged(a.page, [b.page])
    })

    if (category === 'deliverables') {
      await test.step('each frame is the exact pixel size of its format, with its guides locked inside it', async () => {
        const all = await items(b.page)
        for (const p of pieces) {
          const mine = all.filter((e) => kindOf(e) === pieceKind(p.id))
          const frames = mine.filter((e) => e.type === 'frame')
          expect(frames.length, p.id).toBe(p.id === 'steam-set' ? 4 : 1)
          if (p.id !== 'steam-set') expect([frames[0]?.width, frames[0]?.height], p.id).toEqual([p.w, p.h])
          for (const f of frames) expect(f.locked, p.id).toBe(false)
          const guides = mine.filter((e) => e.type !== 'frame')
          expect(guides.length, p.id).toBeGreaterThan(0)
          for (const g of guides) {
            expect(g.locked, p.id).toBe(true)
            expect(frames.map((f) => f.id), p.id).toContain(g.frameId)
          }
        }
        // the named formats are all there
        const frameEls = all.filter((e) => e.type === 'frame') as unknown as { name: string }[]
        const names = frameEls.map((e) => e.name)
        expect(names).toEqual(
          expect.arrayContaining([
            'Full HD 1920 x 1080 (16:9)',
            '4K UHD 3840 x 2160 (16:9)',
            'Square post 1080 x 1080 (1:1)',
            'Portrait post 1080 x 1350 (4:5)',
            'Story / Reel 1080 x 1920 (9:16)',
            'Link image 1200 x 628 (1.91:1)',
            'YouTube banner 2560 x 1440',
            'Steam main capsule 1232 x 706',
            'Steam header capsule 920 x 430',
            'Steam small capsule 462 x 174',
            'Steam vertical capsule 748 x 896',
          ]),
        )
      })
    }

    await test.step('one Ctrl+Z takes the last piece away whole, and the second tab follows', async () => {
      const last = pieces.at(-1) as (typeof pieces)[number]
      await undoKey(a.page)
      await expect.poll(async () => (await pieceEls(a.page, last.id)).length).toBe(0)
      await expect.poll(async () => (await pieceEls(b.page, last.id)).length).toBe(0)
      const before = pieces.at(-2)
      if (before) expect((await pieceEls(a.page, before.id)).length).toBe(expected.get(before.id))
      await expectSaved(a.page)
    })

    const shots = process.env.Q4_SHOTS
    if (shots) await a.page.screenshot({ path: `${shots}/${category}-${testInfo.retry}.png` })
    expect(foreign).toEqual([])
  })
}
