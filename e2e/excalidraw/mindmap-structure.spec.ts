// mindmap on the new canvas (the port of tests/mindmap.spec.ts, structure half): collapse (the spike B
// decision: only `collapsed` is stored; every client hides the branch through `canvas.hide`, so the hit
// guard, Ctrl+A, box selection and exports skip it, and the layout keeps its area free), copies becoming
// maps of their own, Delete taking whole branches, starting from a sticky note in a frame, drag and drop,
// Tidy up and the outline. Steps that need another wave-3 owner's part (3a's context-menu shell, 3e's
// export and present) run only when that part is on the page and are skipped with a note before.
import type { Page } from '@playwright/test'
import {
  clickItem,
  createItem,
  createNote,
  editingId,
  expect,
  expectConverged,
  itemCenterOnScreen,
  sceneToScreen,
  selection,
  selectNone,
  TEXT_EDITOR,
  test,
  waitForItem,
} from '../tests/support/canvas.ts'
import { forgeSession } from '../tests/support/excalidraw.ts'
import { emptyCanvasPoint } from './board-kit.ts'
import {
  buildMap,
  byText,
  downloadBytes,
  expectTidy,
  exportSvg,
  focusCanvas,
  grantClipboard,
  hidden,
  hostSlot,
  mapBox,
  mapProblems,
  mapView,
  readClipboardText,
  selectOnly,
  structure,
  waitForTyping,
} from './mindmap-kit.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function ready(page: Page) {
  await expect(page.getByTestId('mindmap-overlay')).toBeAttached()
}

/** Drags from one scene point to another with the real pointer. */
async function dragScene(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 12,
) {
  const a = await sceneToScreen(page, from)
  const b = await sceneToScreen(page, to)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps })
  await page.mouse.up()
}

test('mind map: collapse with a count badge, hidden for everyone (clicks, Ctrl+A, box selection, exports); a viewer only looks, moves the selection and exports the outline', async ({
  canvasSession,
  board,
}) => {
  const a = await canvasSession('alice')
  const viewer = await canvasSession('bob', { role: 'viewer' })
  await ready(a.page)
  await ready(viewer.page)
  const ids = await buildMap(a.page, ['Product', [['Design', ['Research', 'Wireframes']], 'Build', 'Launch']])
  await expectTidy(a.page)
  // New branches of the central topic go to the lighter side.
  const sides = await mapView(a.page)
  expect([byText(sides, 'Design').side, byText(sides, 'Build').side]).toEqual(['right', 'left'])

  await test.step('alice collapses "Design" from the topic bar: its branch is hidden, a "+2" badge shows', async () => {
    await clickItem(a.page, ids.Design as string)
    const bar = a.page.getByTestId('mindmap-bar')
    await expect(bar).toHaveAttribute('data-topic-id', ids.Design as string)
    const before = mapBox(await mapView(a.page))
    await bar.getByTestId('mindmap-toggle-collapsed').click()
    await expect.poll(() => hidden(a.page, ids.Research as string)).toBe(true)
    expect(await hidden(a.page, ids.Wireframes as string)).toBe(true)
    const badge = a.page.locator(`[data-testid="mindmap-collapsed-badge"][data-topic-id="${ids.Design}"]`)
    await expect(badge).toHaveText('+2')
    await expect(badge).toHaveAccessibleName('Expand branch: 2 hidden topics')
    await expectTidy(a.page)
    // B12's decision: the layout keeps a collapsed branch's area free, so nothing moved
    expect(mapBox(await mapView(a.page))).toEqual(before)
  })

  await test.step('hidden for the hit guard, Ctrl+A and box selection (spike B, B12)', async () => {
    const research = ids.Research as string
    // a click where a hidden topic is selects nothing hidden (nothing is shown there: the area is free)
    await clickItem(a.page, research)
    expect(await selection(a.page)).not.toContain(research)
    // Ctrl+A: everything else, none of the hidden topics or their lines
    await focusCanvas(a.page)
    await a.page.keyboard.press(`${mod}+a`)
    await expect.poll(async () => (await selection(a.page)).length).toBeGreaterThan(0)
    const all = await selection(a.page)
    const v = await mapView(a.page)
    const hiddenIds = [...v.topics.filter((t) => t.hidden), ...v.edges.filter((e) => e.hidden)].map(
      (x) => x.id,
    )
    expect(hiddenIds.length).toBe(4)
    for (const id of hiddenIds) expect(all).not.toContain(id)
    expect(all).toContain(ids.Design)
    // a box over the whole map: post-filtered the same way
    await a.page.keyboard.press('Escape')
    const box = mapBox(v)
    await dragScene(
      a.page,
      { x: box.x - 60, y: box.y - 60 },
      { x: box.x + box.w + 60, y: box.y + box.h + 60 },
    )
    await expect.poll(async () => (await selection(a.page)).length).toBeGreaterThan(0)
    const boxed = await selection(a.page)
    for (const id of hiddenIds) expect(boxed).not.toContain(id)
    expect(boxed).toContain(ids.Product)
  })

  await test.step('the viewer sees the same: hidden topics, the badge (not a button for them)', async () => {
    await expect.poll(() => hidden(viewer.page, ids.Research as string)).toBe(true)
    const badge = viewer.page.locator(
      `[data-testid="mindmap-collapsed-badge"][data-topic-id="${ids.Design}"]`,
    )
    await expect(badge).toHaveText('+2')
    await expect(badge).toBeDisabled()
  })

  await test.step('exports skip what is collapsed (3e: canvas.export.svg)', async () => {
    const svg = await exportSvg(a.page, Object.values(ids))
    if (svg === null) {
      test.info().annotations.push({ type: 'skipped step', description: "needs 3e's export part (wave 3)" })
      return
    }
    expect(svg).toContain('Product')
    expect(svg).toContain('Design')
    expect(svg).not.toContain('Research')
    expect(svg).not.toContain('Wireframes')
  })

  await test.step('the viewer: arrows move the selection, Tab and Enter change nothing, no editing buttons', async () => {
    await clickItem(viewer.page, ids.Product as string)
    await viewer.page.keyboard.press('ArrowRight')
    await expect.poll(() => selection(viewer.page)).not.toEqual([ids.Product])
    const before = structure(await mapView(viewer.page))
    await viewer.page.keyboard.press('Enter')
    await viewer.page.keyboard.press('Tab')
    await viewer.page.waitForTimeout(500)
    expect(structure(await mapView(viewer.page))).toEqual(before)
    await selectOnly(viewer.page, ids.Build as string)
    const bar = viewer.page.getByTestId('mindmap-bar')
    await expect(bar).toBeVisible()
    await expect(bar.getByTestId('mindmap-add-child')).toHaveCount(0)
    await expect(bar.getByTestId('mindmap-tidy')).toHaveCount(0)
    await expect(bar.getByTestId('mindmap-outline-button')).toBeVisible()
    if (await hostSlot(viewer.page, 'contextMenu')) {
      // The context menu (3a's shell) offers the outline, not the editing entries.
      const at = await itemCenterOnScreen(viewer.page, ids.Build as string)
      await viewer.page.mouse.click(at.x, at.y, { button: 'right' })
      await expect(viewer.page.getByRole('menuitem', { name: 'Mind map outline' })).toBeVisible()
      await expect(viewer.page.getByRole('menuitem', { name: /Add child topic/ })).toHaveCount(0)
      await expect(viewer.page.getByRole('menuitem', { name: /Start a mind map/ })).toHaveCount(0)
      await viewer.page.keyboard.press('Escape')
    } else
      test.info().annotations.push({ type: 'skipped step', description: "context menu: needs 3a's shell" })
  })

  await test.step('a viewer who forges a write (a raw socket with their own ticket) changes nothing: the server refuses it', async () => {
    const { socket, welcome } = await forgeSession(viewer.page, board)
    try {
      expect(welcome.readonly).toBe(true)
      const root = (await mapView(viewer.page)).topics.find((t) => t.id === ids.Product)
      await socket.send({
        type: 'push',
        seq: 1,
        base: welcome.clock,
        ops: [
          {
            k: 'c',
            el: {
              id: 'mm-forged',
              type: 'rectangle',
              x: 0,
              y: 0,
              width: 100,
              height: 60,
              customData: {
                lobby: {
                  mindmap: { rootId: ids.Product, parentId: ids.Product, side: 'left', collapsed: false },
                },
              },
            } as never,
          },
          {
            k: 'p',
            id: ids.Product as string,
            pv: 1,
            c: { mindmap: { rootId: ids.Product, parentId: null, side: 'right', collapsed: true } },
          },
        ],
      } as never)
      const ack = (await socket.next('ack')) as { r: { ok: boolean; code?: string }[] }
      expect(ack.r.every((r) => !r.ok)).toBe(true)
      expect(root).toBeTruthy()
    } finally {
      await socket.close()
    }
    await a.page.waitForTimeout(1000)
    expect((await mapView(a.page)).topics.some((t) => t.id === 'mm-forged')).toBe(false)
    expect((await mapView(a.page)).topics.find((t) => t.id === ids.Product)?.collapsed).toBe(false)
  })

  await test.step('alice expands from the badge: the branch is back, tidy', async () => {
    await a.page.locator(`[data-testid="mindmap-collapsed-badge"][data-topic-id="${ids.Design}"]`).click()
    await expect.poll(() => hidden(a.page, ids.Research as string)).toBe(false)
    await expect.poll(() => hidden(viewer.page, ids.Research as string)).toBe(false)
    await expect(a.page.getByTestId('mindmap-collapsed-badge')).toHaveCount(0)
    await expectTidy(a.page)
    await expectTidy(viewer.page)
  })
})

test('mind map: a copied branch pastes as a map of its own, the original untouched; a duplicated topic too', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await ready(a.page)
  await ready(b.page)
  await grantClipboard(a.context)
  const ids = await buildMap(a.page, ['Plan', [['Research', ['Interviews', 'Survey']], 'Ship']])
  await expectTidy(a.page)
  const original = structure(await mapView(a.page))

  await test.step('copy "Research" with its topics and lines, paste', async () => {
    const view = await mapView(a.page)
    const branch = [ids.Research, ids.Interviews, ids.Survey] as string[]
    const lines = view.edges
      .filter((e) => branch.includes(e.childId) && e.childId !== ids.Research)
      .map((e) => e.id)
    await a.page.evaluate(
      (sel) => {
        const f = (window as unknown as { lobbyCanvas: { select(ids: string[]): void } }).lobbyCanvas
        f.select(sel)
        document.querySelector<HTMLElement>('.excalidraw')?.focus()
      },
      [...branch, ...lines],
    )
    await expect.poll(async () => (await selection(a.page)).length).toBe(5)
    await a.page.evaluate(() => navigator.clipboard.writeText('clipboard sentinel'))
    await a.page.keyboard.press('ControlOrMeta+c')
    await expect
      .poll(() => a.page.evaluate(() => navigator.clipboard.readText()))
      .not.toBe('clipboard sentinel')
    // the engine pastes at the pointer: put it over empty canvas first
    const spot = await emptyCanvasPoint(a.page)
    await a.page.mouse.move(spot.x, spot.y)
    await a.page.keyboard.press('ControlOrMeta+v')
    await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(8)
    await expect
      .poll(async () =>
        (await mapView(a.page)).topics
          .filter((t) => t.parentId === null)
          .map((r) => r.text)
          .sort(),
      )
      .toEqual(['Plan', 'Research'])
    const after = await mapView(a.page)
    const copyRoot = after.topics.find((r) => r.parentId === null && r.text === 'Research')
    const copies = after.topics.filter((t) => t.rootId === copyRoot?.id)
    expect(copies.map((t) => t.text).sort()).toEqual(['Interviews', 'Research', 'Survey'])
    // The original map is exactly as it was.
    expect(
      structure({ topics: after.topics.filter((t) => t.rootId === ids.Plan), edges: after.edges }),
    ).toEqual(original)
    await expectTidy(a.page)
    await expectConverged(a.page, [b.page])
    await expectTidy(b.page)
  })

  await test.step('Ctrl+D on one topic: the copy is a one-topic map', async () => {
    await selectOnly(a.page, ids.Ship as string)
    await a.page.keyboard.press(`${mod}+d`)
    await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(9)
    await expect
      .poll(async () =>
        (await mapView(a.page)).topics
          .filter((t) => t.text === 'Ship')
          .map((t) => (t.parentId === null ? 'root' : 'topic'))
          .sort(),
      )
      .toEqual(['root', 'topic'])
    await expectTidy(a.page)
  })
})

test('mind map: Delete removes a whole branch (asking above 10 topics), selects the parent, and undoes in one step', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await ready(a.page)
  await ready(b.page)
  const big = Array.from({ length: 11 }, (_, i) => `Step ${i + 1}`)
  const ids = await buildMap(a.page, ['Plan', [['Big', big], ['Small', ['Leaf']], 'Other']])
  await expectTidy(a.page)
  const count = async (page: Page) => (await mapView(page)).topics.length
  await expect.poll(() => count(b.page)).toBe(16)

  await test.step('a small branch goes at once, with its line; the parent is selected', async () => {
    await clickItem(a.page, ids.Small as string)
    await a.page.keyboard.press('Delete')
    await expect.poll(() => count(a.page)).toBe(14)
    await expect.poll(() => selection(a.page)).toEqual([ids.Plan])
    await expect.poll(() => count(b.page)).toBe(14)
    await expectTidy(b.page)
    expect((await mapView(a.page)).edges.some((e) => e.childId === ids.Leaf)).toBe(false)
  })

  await test.step('12 topics: a confirmation first; Cancel keeps them', async () => {
    await clickItem(a.page, ids.Big as string)
    await a.page.keyboard.press('Delete')
    const dialog = a.page.getByTestId('mindmap-delete-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Delete 12 topics?')
    await dialog.getByTestId('mindmap-delete-cancel').click()
    await expect(dialog).toHaveCount(0)
    expect(await count(a.page)).toBe(14)
  })

  await test.step('confirmed: gone for both; one undo brings all 12 back, laid out', async () => {
    // "Big" is still selected after Cancel, and the board has the keyboard back.
    await expect.poll(() => selection(a.page)).toEqual([ids.Big])
    await a.page.keyboard.press('Delete')
    await a.page.getByTestId('mindmap-delete-confirm').click()
    await expect.poll(() => count(b.page)).toBe(2)
    await expectTidy(b.page)
    await focusCanvas(a.page)
    await a.page.keyboard.press(`${mod}+z`)
    await expect.poll(() => count(b.page)).toBe(14)
    await expectTidy(a.page)
    await expectTidy(b.page)
  })
})

test('mind map: start from a sticky note in a frame (Alt+Shift+M), drag the centre (the map follows), drop a branch on the other side, Tidy up, outline export', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await ready(a.page)
  await grantClipboard(a.context)
  // A frame (a slide for Present) with a sticky note in it.
  const frame = await createItem(a.page, 'frame', {
    id: 'mmframe',
    x: -700,
    y: -250,
    width: 2200,
    height: 1100,
    name: 'Goals',
  })
  const note = await createNote(a.page, { x: 900, y: 450, text: 'Q4 goals' })
  await waitForItem(a.page, note)
  await a.page.evaluate(
    ({ note, frame }) => {
      const b = (
        window as unknown as {
          __lobbyBoard: {
            canvas: {
              transact(l: string, fn: (tx: { setFrame(ids: string[], f: string): void }) => void): void
            }
          }
        }
      ).__lobbyBoard
      b.canvas.transact('into the frame', (tx) => tx.setFrame([note], frame))
      ;(window as unknown as { lobbyCanvas: { zoomToFit(): void } }).lobbyCanvas.zoomToFit()
    },
    { note, frame },
  )
  await expect
    .poll(
      async () =>
        await a.page.evaluate(
          (id) =>
            (
              window as unknown as { lobbyCanvas: { get(id: string): { frameId: string | null } } }
            ).lobbyCanvas.get(id).frameId,
          note,
        ),
    )
    .toBe(frame)
  // "Start a mind map" (Alt+Shift+M; the context menu's entry runs the same command)
  await clickItem(a.page, note)
  await a.page.keyboard.press('Alt+Shift+M')
  await waitForTyping(a.page)
  await a.page.keyboard.type('Revenue')
  await a.page.keyboard.press('Enter')
  await a.page.keyboard.type('Hiring')
  await a.page.keyboard.press('Enter')
  await a.page.keyboard.type('Product')
  await a.page.keyboard.press('Escape')
  await expect
    .poll(async () => structure(await mapView(a.page)))
    .toEqual(['(root) Q4 goals', 'Q4 goals > Hiring', 'Q4 goals > Product', 'Q4 goals > Revenue'])
  await expectTidy(a.page)
  const v = await mapView(a.page)
  expect(byText(v, 'Q4 goals').type).toBe('stickynote')
  // The new topics and their lines live in the note's frame.
  expect([...new Set(v.topics.map((t) => t.frameId))]).toEqual([frame])

  await test.step('dragging the central topic takes the whole map along (when it is dropped)', async () => {
    // the last topic's editor has closed (a press while it closes only ends the typing)
    await expect(a.page.getByTestId('lease-status')).toHaveAttribute('data-phase', 'idle')
    await expect(a.page.locator(TEXT_EDITOR)).toHaveCount(0)
    await expect.poll(() => editingId(a.page)).toBeNull()
    const before = await mapView(a.page)
    const root = byText(before, 'Q4 goals')
    const drag = () =>
      dragScene(
        a.page,
        { x: root.box.x + 30, y: root.box.y + 30 },
        { x: root.box.x + 30 + 60, y: root.box.y + 30 + 90 },
        10,
      )
    await drag()
    // Observed under load (2 of about 25 runs): the engine took no part of the first drag after the typing
    // (nothing selected, nothing moved; 3D.md, evidence). Retried once, with a note in the report.
    if (!(await selection(a.page)).includes(root.id)) {
      test
        .info()
        .annotations.push({ type: 'retried', description: 'root drag: the first press was not taken' })
      await drag()
    }
    await expectTidy(a.page)
    await expect
      .poll(async () => {
        const after = await mapView(a.page)
        const dx = byText(after, 'Q4 goals').box.x - root.box.x
        const dy = byText(after, 'Q4 goals').box.y - root.box.y
        if (Math.hypot(dx, dy) <= 40) return 'root did not move'
        for (const t of before.topics) {
          const moved = after.topics.find((x) => x.id === t.id)
          if (
            Math.abs((moved?.box.x ?? 0) - t.box.x - dx) > 1 ||
            Math.abs((moved?.box.y ?? 0) - t.box.y - dy) > 1
          )
            return `${t.text} did not follow`
        }
        return 'ok'
      })
      .toBe('ok')
  })

  await test.step('a branch dropped on the other side of the centre switches side; Tidy up rebalances', async () => {
    const now = await mapView(a.page)
    const rev = byText(now, 'Revenue')
    const root = byText(now, 'Q4 goals')
    const target = rev.side === 'right' ? root.box.x - 400 : root.box.x + root.box.w + 400
    // nothing selected first: 3a's style panel (on the page since the wave-3 integration) sits over the
    // right of the view while something is selected, where this branch is
    await selectNone(a.page)
    await dragScene(a.page, { x: rev.box.x + 20, y: rev.box.y + rev.box.h / 2 }, { x: target, y: root.box.y })
    await expect.poll(async () => byText(await mapView(a.page), 'Revenue').side).not.toBe(rev.side)
    await expectTidy(a.page)
    await selectOnly(a.page, rev.id)
    await a.page.getByTestId('mindmap-bar').getByTestId('mindmap-tidy').click()
    await expectTidy(a.page)
    const sides = (await mapView(a.page)).topics.filter((t) => t.parentId).map((t) => t.side)
    expect(
      Math.abs(sides.filter((s) => s === 'left').length - sides.filter((s) => s === 'right').length),
    ).toBeLessThanOrEqual(1)
  })

  await test.step('a topic dropped onto another becomes its child (one undo step with the drag)', async () => {
    const now = await mapView(a.page)
    const hiring = byText(now, 'Hiring')
    const product = byText(now, 'Product')
    // Hiring's centre lands on Product's centre.
    await dragScene(
      a.page,
      { x: hiring.box.x + 12, y: hiring.box.y + hiring.box.h / 2 },
      { x: product.box.x + product.box.w / 2 - hiring.box.w / 2 + 12, y: product.box.y + product.box.h / 2 },
    )
    await expect.poll(async () => structure(await mapView(a.page))).toContain('Product > Hiring')
    await expectTidy(a.page)
    await focusCanvas(a.page)
    // ONE press undoes the drop with the line the engine re-routed during the drag. This step used to allow
    // a second press for CR-3D-4's extra step (the replaced line on the stack); it passed with one in wave B
    // (follow-up 8), so a second press now fails the step instead of being forgiven.
    await a.page.keyboard.press(`${mod}+z`)
    await expect.poll(async () => structure(await mapView(a.page))).toContain('Q4 goals > Hiring')
    expect(structure(await mapView(a.page))).not.toContain('Product > Hiring')
    await expectTidy(a.page)
  })

  await test.step('the outline: copied as Markdown, downloaded as CSV', async () => {
    await selectOnly(a.page, note)
    const bar = a.page.getByTestId('mindmap-bar')
    await bar.getByTestId('mindmap-outline-button').click()
    await a.page.getByTestId('mindmap-copy-outline').click()
    await expect.poll(() => readClipboardText(a.page)).toContain('# Q4 goals')
    const md = await readClipboardText(a.page)
    expect(md).toContain('- Revenue')
    expect(md).toContain('- Hiring')
    await bar.getByTestId('mindmap-outline-button').click()
    const [download] = await Promise.all([
      a.page.waitForEvent('download'),
      a.page.getByTestId('mindmap-download-csv').click(),
    ])
    expect(download.suggestedFilename()).toMatch(/Q4 goals\.csv$/)
    const csv = (await downloadBytes(download)).toString('utf8').replace(/^﻿/, '')
    expect(csv.split('\r\n')[0]).toBe('level,topic,parent,path')
    expect(csv).toContain('1,Revenue,Q4 goals,Q4 goals > Revenue')
  })

  await test.step('focus mode (Present): the topic bar hides with the board chrome', async () => {
    await selectOnly(a.page, note)
    await expect(a.page.getByTestId('mindmap-bar')).toBeVisible()
    await a.page.evaluate(() =>
      (
        window as unknown as { __lobbyBoard: { canvas: { settings: { set(p: object): void } } } }
      ).__lobbyBoard.canvas.settings.set({ focusMode: true }),
    )
    await expect(a.page.getByTestId('mindmap-bar')).toBeHidden()
    await a.page.evaluate(() =>
      (
        window as unknown as { __lobbyBoard: { canvas: { settings: { set(p: object): void } } } }
      ).__lobbyBoard.canvas.settings.set({ focusMode: false }),
    )
    await expect(a.page.getByTestId('mindmap-bar')).toBeVisible()
  })
  expect(mapProblems(await mapView(a.page))).toEqual([])
})
