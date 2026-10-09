// L4-3 (wave L, W4): Mermaid paste as a native diagram, on the Excalidraw board page against the real api and sync
// server.
//
//  - a pasted Mermaid flowchart (40 nodes) becomes native shapes with bound elbow connectors, with AI off:
//    every element accepted by the server (no rejection; a fresh tab finds them all), no /ai call; dragging a
//    node leaves its connectors to the room (they are its re-snap on both tabs, and the dragging tab pushed no
//    patch of their geometry); one undo takes the whole diagram back. K7-2's outline paste still makes a mind map
//    (excalidraw/k7-outline-paste.spec.ts runs unchanged with this feature on the page).
//  - L4-2 (Diagram from words, and the viewer's missing entry) is ./l4-diagram-ai.spec.ts (it runs the api with the
//    AI fake's env).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l4-diagram --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type ElementsById, resnapArrow } from '../../packages/canvas-schema/src/engine/index.ts'
import type { Op } from '../../packages/canvas-schema/src/protocol.ts'
import {
  type CanvasElement,
  expect,
  expectConverged,
  expectSaved,
  item,
  itemCenterOnScreen,
  items,
  pushedOps,
  saveState,
  test,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { focusBoard } from './board-kit.ts'
import { grantClipboard, undoKey, writeClipboard } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

type Arrow = CanvasElement & {
  points: [number, number][]
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
  boundElements?: { id: string; type: string }[] | null
}

const KIND = ['[', '{', '((', '[/'] as const
const CLOSE = { '[': ']', '{': '}', '((': '))', '[/': '/]' } as const

/** A 40-node Mermaid flowchart: a chain of mixed kinds, branches, loops back and labelled links. */
function chart40(): { text: string; nodes: number; edges: number } {
  const lines = ['flowchart TD']
  for (let i = 1; i <= 40; i++) {
    const k = KIND[i % 4] as (typeof KIND)[number]
    lines.push(`  N${i}${k}Step ${i}${CLOSE[k]}`)
  }
  let edges = 0
  for (let i = 1; i < 40; i++) {
    lines.push(`  N${i} --> N${i + 1}`)
    edges++
  }
  for (let i = 1; i + 3 <= 40; i += 3) {
    lines.push(`  N${i} -->|skip| N${i + 3}`)
    edges++
  }
  for (const [a, b] of [
    [12, 4],
    [30, 18],
    [40, 1],
  ]) {
    lines.push(`  N${a} -. back .-> N${b}`)
    edges++
  }
  return { text: lines.join('\n'), nodes: 40, edges }
}

const prompt = (page: Page) => page.getByTestId('mermaid-paste-prompt')

async function pasteText(page: Page, text: string) {
  await writeClipboard(page, { 'text/plain': text })
  await focusBoard(page)
  await page.keyboard.press('ControlOrMeta+v')
}

const shapesOf = (all: readonly CanvasElement[]) =>
  all.filter((e) => e.type === 'rectangle' || e.type === 'diamond' || e.type === 'ellipse')
const arrowsOf = (all: readonly CanvasElement[]) => all.filter((e) => e.type === 'arrow') as Arrow[]

function serverDerived(arrow: Arrow, all: readonly CanvasElement[]): boolean {
  const map = new Map(all.map((e) => [e.id, e])) as unknown as ElementsById
  return !resnapArrow(arrow as never, map).changed
}

/** Patches of `id`'s geometry (`path`) this tab pushed. */
async function pathPushes(page: Page, id: string): Promise<number> {
  let n = 0
  for (const rec of await pushedOps(page))
    for (const op of rec.ops as readonly Op[]) if (op.k === 'p' && op.id === id && op.g?.path) n++
  return n
}

test('L4-3: a 40-node Mermaid flowchart pasted with AI off becomes native, bound, server-accepted shapes; dragging a node leaves its connectors to the room; one undo takes it back', async ({
  canvasSession,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await grantClipboard(a.context)
  const aiCalls: string[] = []
  for (const p of [a.page, b.page]) p.on('request', (r) => r.url().includes('/ai/') && aiCalls.push(r.url()))
  const chart = chart40()
  const bobPushes = (await pushedOps(b.page)).length

  await test.step('the paste asks, and Paste as diagram builds 40 shapes and their connectors, bound', async () => {
    await pasteText(a.page, chart.text)
    await expect(prompt(a.page)).toContainText(`${chart.nodes} shapes, ${chart.edges} connectors`)
    await expect(a.page.getByTestId('mermaid-paste-diagram')).toBeFocused()
    // bulk paste's prompt is not asked (the flowchart handler took the paste first)
    await expect(a.page.getByTestId('bulk-paste-prompt')).toHaveCount(0)
    await a.page.getByTestId('mermaid-paste-diagram').click()
    await expect(prompt(a.page)).toHaveCount(0)
    await expect.poll(async () => shapesOf(await items(a.page)).length).toBe(40)
    await expect.poll(async () => arrowsOf(await items(a.page)).length).toBe(chart.edges)
    const all = await items(a.page)
    for (const arrow of arrowsOf(all)) {
      expect(arrow.elbowed, arrow.id).toBe(true)
      expect(arrow.startBinding?.elementId, arrow.id).toBeTruthy()
      expect(arrow.endBinding?.elementId, arrow.id).toBeTruthy()
    }
    // the labelled links carry their words as labels bound to the connector
    const labelled = arrowsOf(all).filter((x) => (x.boundElements ?? []).some((r) => r.type === 'text'))
    expect(labelled).toHaveLength(13 + 3)
    expect(all.filter((e) => e.type === 'diamond')).toHaveLength(10)
    expect(all.filter((e) => e.type === 'ellipse')).toHaveLength(10)
    // no AI provenance on a pasted chart
    expect(all.filter((e) => e.customData?.lobby?.ai !== undefined)).toEqual([])
  })

  await test.step('the server accepted every element: no rejection, Saved, and a fresh tab finds them all', async () => {
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
    await expectConverged(a.page, [b.page])
    const c = await canvasSession('carol')
    await expect.poll(async () => (await items(c.page)).length).toBe((await items(a.page)).length)
    for (const arrow of arrowsOf(await items(c.page)))
      expect(serverDerived(arrow, await items(c.page))).toBe(true)
    await c.context.close()
    expect((await pushedOps(b.page)).length).toBe(bobPushes)
  })

  await test.step('dragging a node: its connectors are the room’s re-snap on both tabs, and no geometry of them was pushed', async () => {
    await zoomToFit(a.page)
    const all = await items(a.page)
    const node = shapesOf(all).find((s) =>
      (s as Arrow).boundElements?.some((r) => r.type === 'arrow'),
    ) as Arrow
    const mine = (node.boundElements ?? []).filter((r) => r.type === 'arrow').map((r) => r.id)
    expect(mine.length).toBeGreaterThan(0)
    const versions = new Map(
      await Promise.all(mine.map(async (id) => [id, (await item(b.page, id))?.version] as const)),
    )
    const pushedBefore = await Promise.all(mine.map((id) => pathPushes(a.page, id)))
    const c = await itemCenterOnScreen(a.page, node.id)
    await a.page.mouse.move(c.x, c.y)
    await a.page.mouse.down()
    await a.page.mouse.move(c.x + 30, c.y + 60, { steps: 8 })
    await a.page.mouse.up()
    await expectSaved(a.page)
    await expect
      .poll(async () => {
        const now = await items(b.page)
        return mine.every((id) => {
          const x = now.find((e) => e.id === id) as Arrow | undefined
          return !!x && x.version !== versions.get(id) && serverDerived(x, now)
        })
      })
      .toBe(true)
    await expectConverged(a.page, [b.page])
    for (const id of mine)
      expect(serverDerived((await item(a.page, id)) as Arrow, await items(a.page))).toBe(true)
    expect(await Promise.all(mine.map((id) => pathPushes(a.page, id)))).toEqual(pushedBefore)
    expect(pushedBefore.every((n) => n === 0)).toBe(true)
    expect((await pushedOps(b.page)).length).toBe(bobPushes)
  })

  await test.step('one undo per step: the drag, then the whole diagram', async () => {
    await undoKey(a.page)
    await undoKey(a.page)
    await expect.poll(async () => (await items(a.page)).length).toBe(0)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
  })

  expect(aiCalls.filter((u) => u.includes('/ai/run'))).toEqual([])
})

test('L4-3: text that is not a flowchart goes on to bulk paste as before (an outline still offers a mind map)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await pasteText(a.page, '# Launch plan\n- Audience\n  - Fans\n- Channels')
  await expect(a.page.getByTestId('bulk-paste-prompt')).toBeVisible()
  await expect(a.page.getByTestId('bulk-paste-mindmap')).toBeVisible()
  await expect(prompt(a.page)).toHaveCount(0)
  await a.page.getByTestId('bulk-paste-cancel').click()
  // Paste as text keeps a flowchart's words
  await pasteText(a.page, 'flowchart LR\nA[Brief] --> B[Concept]')
  await a.page.getByTestId('mermaid-paste-text').click()
  await expect.poll(async () => (await items(a.page)).map((e) => e.type)).toEqual(['text'])
})

test('With AI off an editor has no "Diagram from words…" entry; a flowchart with a long label says it is shortened before anything is written', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await focusBoard(a.page)
  const box = await a.page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no canvas')
  await a.page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6, { button: 'right' })
  await expect(a.page.getByTestId('context-menu-root')).toBeVisible()
  await expect(a.page.getByRole('menuitem', { name: /Diagram from words/ })).toHaveCount(0)
  await a.page.keyboard.press('Escape')
  await expect(a.page.getByTestId('context-menu-root')).toHaveCount(0)

  await pasteText(a.page, `flowchart LR\nA[${'word '.repeat(20)}] --> B[Ship]\nA --> B`)
  await expect(prompt(a.page)).toContainText('2 shapes, 1 connector.')
  await expect(prompt(a.page)).toContainText('1 long label is shortened.')
  await expect(prompt(a.page)).toContainText('1 link is left out')
  expect(await items(a.page)).toEqual([])
  await a.page.getByTestId('mermaid-paste-cancel').click()
  await expect(prompt(a.page)).toHaveCount(0)
  expect(await items(a.page)).toEqual([])
})
