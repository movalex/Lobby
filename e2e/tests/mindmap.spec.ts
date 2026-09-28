// mindmap (docs/WAVE4-CONTRACTS.md "mindmap"): mind maps built from plain tldraw shapes (geo topics,
// bound elbow arrows, the tree in meta.drMindmap), keyboard-first. Two browsers throughout: whatever
// one person does, the other sees live, and both hold the same records with nothing overlapping.
import type { Page } from '@playwright/test'
import { expectConverged, read } from './support/board.ts'
import { clickShape, grantClipboard, readClipboardText, waitForCanvasUx } from './support/canvas-ux.ts'
import { expect, test } from './support/fixtures.ts'
import {
  buildMap,
  byText,
  editingText,
  expectTidy,
  type MindmapEditor,
  mapProblems,
  mapView,
  selectOnly,
  structure,
  toolbarButton,
  waitForTyping,
} from './support/mindmap.ts'
import { downloadBytes, presentUi } from './support/present-export.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function ready(page: Page) {
  await waitForCanvasUx(page)
  await expect(page.getByTestId('mindmap-overlay')).toBeAttached()
}

const hidden = (page: Page, id: string) =>
  read(page, (ed, shapeId) => (ed as unknown as MindmapEditor).isShapeHidden(shapeId), id)

test('mind map: two people build one map by keyboard, each sees the other live, and it never overlaps', async ({
  session,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await ready(a.page)
  await ready(b.page)

  await test.step('alice: the Mind map button, then only the keyboard (typing replaces "Central topic")', async () => {
    await toolbarButton(a.page).click()
    await waitForTyping(a.page)
    expect(await editingText(a.page)).toBe('Central topic')
    await a.page.keyboard.type('Launch plan')
    await a.page.keyboard.press('Tab')
    await a.page.keyboard.type('Audience')
    await a.page.keyboard.press('Enter')
    await a.page.keyboard.type('Channels')
    await a.page.keyboard.press('Tab')
    await a.page.keyboard.type('Email')
    await a.page.keyboard.press('Escape')
    await expect
      .poll(async () => structure(await mapView(a.page)))
      .toEqual(['(root) Launch plan', 'Channels > Email', 'Launch plan > Audience', 'Launch plan > Channels'])
    await expectTidy(a.page)
    // Esc leaves the topic selected, not being edited.
    await expect.poll(() => read(a.page, (ed) => ed.getEditingShapeId())).toBeNull()
    const v = await mapView(a.page)
    expect(await read(a.page, (ed) => ed.getSelectedShapeIds())).toEqual([byText(v, 'Email').id])
    // Branches get their own colours; lines take their child's colour and are elbow arrows.
    expect(byText(v, 'Launch plan').color).toBe('orange')
    expect(byText(v, 'Audience').color).not.toBe(byText(v, 'Channels').color)
    expect(byText(v, 'Email').color).toBe(byText(v, 'Channels').color)
    expect(v.edges.every((e) => e.kind === 'elbow')).toBe(true)
  })

  await test.step('bob sees the same map, laid out the same way', async () => {
    await expect
      .poll(async () => structure(await mapView(b.page)))
      .toEqual(['(root) Launch plan', 'Channels > Email', 'Launch plan > Audience', 'Launch plan > Channels'])
    await expectConverged(a.page, [b.page])
    await expectTidy(b.page)
    const v = await mapView(b.page)
    expect(byText(v, 'Audience').box.y).toBeLessThan(byText(v, 'Channels').box.y)
    // Enter makes a sibling on the same side, right below.
    expect(byText(v, 'Audience').side).toBe(byText(v, 'Channels').side)
  })

  await test.step('bob adds under "Channels" by keyboard; alice sees it', async () => {
    const v = await mapView(b.page)
    await clickShape(b.page, byText(v, 'Channels').id)
    await b.page.keyboard.press('Tab')
    await b.page.keyboard.type('Social')
    await b.page.keyboard.press('Enter')
    await b.page.keyboard.type('Press')
    await b.page.keyboard.press('Escape')
    const want = [
      '(root) Launch plan',
      'Channels > Email',
      'Channels > Press',
      'Channels > Social',
      'Launch plan > Audience',
      'Launch plan > Channels',
    ]
    await expect.poll(async () => structure(await mapView(a.page))).toEqual(want)
    await expectConverged(b.page, [a.page])
    await expectTidy(a.page)
    // Enter put "Press" right below "Social" (after "Email", which was already there).
    const w = await mapView(a.page)
    expect(byText(w, 'Email').box.y).toBeLessThan(byText(w, 'Social').box.y)
    expect(byText(w, 'Social').box.y).toBeLessThan(byText(w, 'Press').box.y)
  })

  await test.step('both add a branch at the same moment: no overlap on either side once it settles', async () => {
    const root = byText(await mapView(a.page), 'Launch plan').id
    await selectOnly(a.page, root)
    await selectOnly(b.page, root)
    await Promise.all([a.page.keyboard.press('Tab'), b.page.keyboard.press('Tab')])
    await Promise.all([waitForTyping(a.page), waitForTyping(b.page)])
    await Promise.all([a.page.keyboard.type('Budget'), b.page.keyboard.type('Timeline')])
    await Promise.all([a.page.keyboard.press('Escape'), b.page.keyboard.press('Escape')])
    await expect
      .poll(async () => structure(await mapView(a.page)), { timeout: 20_000 })
      .toContain('Launch plan > Timeline')
    await expect.poll(async () => structure(await mapView(a.page))).toContain('Launch plan > Budget')
    await expectConverged(a.page, [b.page], 20_000)
    await expectTidy(a.page)
    await expectTidy(b.page)
  })

  await test.step("undo takes back alice's last topic (one step), for both", async () => {
    await a.page.keyboard.press(`${mod}+z`)
    await expect.poll(async () => structure(await mapView(b.page))).not.toContain('Launch plan > Budget')
    expect(structure(await mapView(b.page))).toContain('Launch plan > Timeline')
    await expectConverged(a.page, [b.page], 20_000)
    await expectTidy(a.page)
    await expectTidy(b.page)
  })
})

test('mind map: fast typing never loses a key; Shift+Tab moves up a level; an empty new topic left with Esc disappears', async ({
  session,
}) => {
  const a = await session('alice')
  await ready(a.page)
  // Alt+Shift+M with nothing selected: a new map, its central topic ready for typing.
  const vp = a.page.viewportSize() ?? { width: 1280, height: 720 }
  await a.page.mouse.click(vp.width / 2, vp.height / 2) // empty canvas: the board has the keyboard
  await a.page.keyboard.press('Alt+Shift+M')
  // No waiting anywhere below: keys typed before a new topic's editor exists are queued in order.
  await a.page.keyboard.type('Root')
  for (const k of [
    ['Tab', 'Idea'],
    ['Tab', 'Detail one'],
    ['Enter', 'Detail two'],
    ['Shift+Tab', ''],
    ['Enter', 'Next idea'],
  ] as const) {
    await a.page.keyboard.press(k[0])
    if (k[1]) await a.page.keyboard.type(k[1])
  }
  await a.page.keyboard.press('Tab') // an empty child of "Next idea"...
  await a.page.keyboard.press('Escape') // ...left empty: it goes away, "Next idea" is selected again
  await expect
    .poll(async () => structure(await mapView(a.page)))
    .toEqual(['(root) Root', 'Idea > Detail one', 'Root > Detail two', 'Root > Idea', 'Root > Next idea'])
  await expectTidy(a.page)
  const v = await mapView(a.page)
  await expect.poll(() => read(a.page, (ed) => ed.getSelectedShapeIds())).toEqual([byText(v, 'Next idea').id])
  // "Detail two" moved up a level: it is a branch now, sized and styled like one, after "Idea".
  expect(byText(v, 'Detail two').box.h).toBeGreaterThanOrEqual(byText(v, 'Detail one').box.h)
  expect(byText(v, 'Idea').box.y).toBeLessThan(byText(v, 'Detail two').box.y)

  await test.step('arrow keys move through the map; F2 edits; typing on a topic appends', async () => {
    await a.page.keyboard.press('ArrowUp')
    await expect
      .poll(() => read(a.page, (ed) => ed.getSelectedShapeIds()))
      .toEqual([byText(v, 'Detail two').id])
    await a.page.keyboard.press('ArrowUp')
    await expect.poll(() => read(a.page, (ed) => ed.getSelectedShapeIds())).toEqual([byText(v, 'Idea').id])
    await a.page.keyboard.press('ArrowRight')
    await expect
      .poll(() => read(a.page, (ed) => ed.getSelectedShapeIds()))
      .toEqual([byText(v, 'Detail one').id])
    await a.page.keyboard.type('!')
    await a.page.keyboard.press('Escape')
    await expect.poll(async () => structure(await mapView(a.page))).toContain('Idea > Detail one!')
    await a.page.keyboard.press('ArrowLeft')
    await expect.poll(() => read(a.page, (ed) => ed.getSelectedShapeIds())).toEqual([byText(v, 'Idea').id])
  })
})

test('mind map: collapse with a count badge, hidden for everyone and in exports; a viewer only looks, moves the selection and exports the outline', async ({
  session,
}) => {
  const a = await session('alice')
  const viewer = await session('bob', { role: 'viewer' })
  await ready(a.page)
  await ready(viewer.page)
  const ids = await buildMap(a.page, ['Product', [['Design', ['Research', 'Wireframes']], 'Build', 'Launch']])
  await expectTidy(a.page)
  // New branches of the central topic go to the lighter side.
  const sides = await mapView(a.page)
  expect([byText(sides, 'Design').side, byText(sides, 'Build').side]).toEqual(['right', 'left'])

  await test.step('alice collapses "Design" from the topic bar: its branch is hidden, a "+2" badge shows', async () => {
    await clickShape(a.page, ids.Design as string)
    const bar = a.page.getByTestId('mindmap-bar')
    await expect(bar).toHaveAttribute('data-topic-id', ids.Design as string)
    await bar.getByTestId('mindmap-toggle-collapsed').click()
    await expect.poll(() => hidden(a.page, ids.Research as string)).toBe(true)
    expect(await hidden(a.page, ids.Wireframes as string)).toBe(true)
    const badge = a.page.locator(`[data-testid="mindmap-collapsed-badge"][data-topic-id="${ids.Design}"]`)
    await expect(badge).toHaveText('+2')
    await expect(badge).toHaveAccessibleName('Expand branch: 2 hidden topics')
    await expectTidy(a.page)
  })

  await test.step('the viewer sees the same: hidden topics, the badge (not a button for them)', async () => {
    await expect.poll(() => hidden(viewer.page, ids.Research as string)).toBe(true)
    const badge = viewer.page.locator(
      `[data-testid="mindmap-collapsed-badge"][data-topic-id="${ids.Design}"]`,
    )
    await expect(badge).toHaveText('+2')
    await expect(badge).toBeDisabled()
  })

  await test.step('exports skip what is collapsed (tldraw renders only shown shapes)', async () => {
    const svg = await a.page.evaluate(async (all) => {
      const ed = window.editor as unknown as MindmapEditor
      return (await ed.getSvgString(all))?.svg ?? ''
    }, Object.values(ids))
    expect(svg).toContain('Product')
    expect(svg).toContain('Design')
    expect(svg).not.toContain('Research')
    expect(svg).not.toContain('Wireframes')
  })

  await test.step('the viewer: arrows move the selection, Tab and Enter change nothing, no editing buttons', async () => {
    await clickShape(viewer.page, ids.Product as string)
    await viewer.page.keyboard.press('ArrowRight')
    await expect.poll(() => read(viewer.page, (ed) => ed.getSelectedShapeIds())).not.toEqual([ids.Product])
    const before = structure(await mapView(viewer.page))
    await viewer.page.keyboard.press('Enter')
    // Tab stays tldraw's keyboard navigation for read-only people (it selects the next shape).
    await viewer.page.keyboard.press('Tab')
    await viewer.page.waitForTimeout(500)
    expect(structure(await mapView(viewer.page))).toEqual(before)
    await selectOnly(viewer.page, ids.Build as string)
    const bar = viewer.page.getByTestId('mindmap-bar')
    await expect(bar).toBeVisible()
    await expect(bar.getByTestId('mindmap-add-child')).toHaveCount(0)
    await expect(bar.getByTestId('mindmap-tidy')).toHaveCount(0)
    await expect(bar.getByTestId('mindmap-outline-button')).toBeVisible()
    await expect(viewer.page.getByTestId('tools.dr-mindmap')).toHaveCount(0)
    // The context menu offers the outline, not the editing entries.
    const at = await read(
      viewer.page,
      (ed, id) => {
        const bb = ed.getShapePageBounds(id)
        return bb ? ed.pageToScreen({ x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 }) : null
      },
      ids.Build as string,
    )
    if (!at) throw new Error('no topic')
    await viewer.page.mouse.click(at.x, at.y, { button: 'right' })
    await expect(viewer.page.getByRole('menuitem', { name: 'Mind map outline' })).toBeVisible()
    await expect(viewer.page.getByRole('menuitem', { name: /Add child topic/ })).toHaveCount(0)
    await expect(viewer.page.getByRole('menuitem', { name: /Start a mind map/ })).toHaveCount(0)
    await viewer.page.keyboard.press('Escape')
  })

  await test.step('a viewer who forges a write (flips the client-only read-only flag) changes nothing: the server refuses it', async () => {
    await viewer.page.evaluate((root) => {
      const ed = window.editor
      ed?.updateInstanceState({ isReadonly: false })
      const rt = (window as unknown as { __drMindmap?: { addChild(id: string): string | null } }).__drMindmap
      const made = rt?.addChild(root)
      const shape = made ? ed?.getShape(made) : undefined
      if (shape)
        ed?.updateShape({
          id: made,
          type: shape.type,
          props: {
            richText: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Forged' }] }],
            },
          },
        })
    }, ids.Product as string)
    await a.page.waitForTimeout(1500)
    expect(structure(await mapView(a.page)).join('|')).not.toContain('Forged')
    await expect.poll(async () => structure(await mapView(viewer.page)).join('|')).not.toContain('Forged')
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
  session,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await ready(a.page)
  await ready(b.page)
  await grantClipboard(a.context)
  const ids = await buildMap(a.page, ['Plan', [['Research', ['Interviews', 'Survey']], 'Ship']])
  await expectTidy(a.page)
  const original = structure(await mapView(a.page))

  await test.step('copy "Research" with its topics and lines (a box selection holds both), paste', async () => {
    const view = await mapView(a.page)
    const branch = [ids.Research, ids.Interviews, ids.Survey] as string[]
    const lines = view.edges
      .filter((e) => branch.includes(e.childId) && e.childId !== ids.Research)
      .map((e) => e.id)
    await a.page.evaluate(
      (sel) => {
        const ed = window.editor as unknown as { select(...ids: string[]): void; focus(): void }
        ed.select(...sel)
        ed.focus()
      },
      [...branch, ...lines],
    )
    await expect.poll(() => read(a.page, (ed) => ed.getSelectedShapeIds().length)).toBe(5)
    await a.page.evaluate(() => navigator.clipboard.writeText('clipboard sentinel'))
    await a.page.keyboard.press('ControlOrMeta+c')
    // tldraw writes the clipboard asynchronously.
    await expect
      .poll(() => a.page.evaluate(() => navigator.clipboard.readText()))
      .not.toBe('clipboard sentinel')
    await a.page.keyboard.press('ControlOrMeta+v')
    await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(8)
    const after = await mapView(a.page)
    const roots = after.topics.filter((t) => t.parentId === null)
    expect(roots.map((r) => r.text).sort()).toEqual(['Plan', 'Research'])
    const copyRoot = roots.find((r) => r.text === 'Research')
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
    const after = await mapView(a.page)
    const ships = after.topics.filter((t) => t.text === 'Ship')
    expect(ships.map((t) => (t.parentId === null ? 'root' : 'topic')).sort()).toEqual(['root', 'topic'])
    await expectTidy(a.page)
  })
})

test('mind map: Delete removes a whole branch (asking above 10 topics), selects the parent, and undoes in one step', async ({
  session,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await ready(a.page)
  await ready(b.page)
  const big = Array.from({ length: 11 }, (_, i) => `Step ${i + 1}`)
  const ids = await buildMap(a.page, ['Plan', [['Big', big], ['Small', ['Leaf']], 'Other']])
  await expectTidy(a.page)
  const count = async (page: Page) => (await mapView(page)).topics.length
  await expect.poll(() => count(b.page)).toBe(16)

  await test.step('a small branch goes at once, with its line; the parent is selected', async () => {
    await clickShape(a.page, ids.Small as string)
    await a.page.keyboard.press('Delete')
    await expect.poll(() => count(a.page)).toBe(14)
    await expect.poll(() => read(a.page, (ed) => ed.getSelectedShapeIds())).toEqual([ids.Plan])
    await expect.poll(() => count(b.page)).toBe(14)
    await expectTidy(b.page)
    expect((await mapView(a.page)).edges.some((e) => e.childId === ids.Leaf)).toBe(false)
  })

  await test.step('12 topics: a confirmation first; Cancel keeps them', async () => {
    await clickShape(a.page, ids.Big as string)
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
    await expect.poll(() => read(a.page, (ed) => ed.getSelectedShapeIds())).toEqual([ids.Big])
    await a.page.keyboard.press('Delete')
    await a.page.getByTestId('mindmap-delete-confirm').click()
    await expect.poll(() => count(b.page)).toBe(2)
    await expectTidy(b.page)
    await a.page.keyboard.press(`${mod}+z`)
    await expect.poll(() => count(b.page)).toBe(14)
    await expectTidy(a.page)
    await expectTidy(b.page)
  })
})

test('mind map: start from a sticky note (context menu), drag the centre (the map follows), drop a branch on the other side, Tidy up, outline export', async ({
  session,
}) => {
  const a = await session('alice')
  await ready(a.page)
  await grantClipboard(a.context)
  // A frame (a slide for Present) with a sticky note in it.
  await a.page.evaluate(() => {
    window.editor?.createShapes([
      { id: 'shape:mm-frame', type: 'frame', x: -700, y: -250, props: { w: 2200, h: 1100, name: 'Goals' } },
      {
        id: 'shape:mm-note',
        type: 'note',
        parentId: 'shape:mm-frame',
        x: 900,
        y: 450,
        props: {
          richText: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Q4 goals' }] }],
          },
        },
      },
    ])
    window.editor?.zoomToFit()
  })
  await clickShape(a.page, 'shape:mm-note')
  const c = await read(a.page, (ed) => {
    const bb = ed.getShapePageBounds('shape:mm-note')
    return bb ? ed.pageToScreen({ x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 }) : null
  })
  if (!c) throw new Error('no note')
  await a.page.mouse.click(c.x, c.y, { button: 'right' })
  await a.page.getByRole('menuitem', { name: 'Start a mind map' }).click()
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
  expect(byText(v, 'Q4 goals').type).toBe('note')
  // The new topics and their lines live in the note's frame.
  const parents = await read(a.page, (ed) => [
    ...new Set(
      ed
        .getCurrentPageShapes()
        .filter((s) => s.meta.drMindmap || s.meta.drMindmapEdge)
        .map((s) => s.parentId),
    ),
  ])
  expect(parents).toEqual(['shape:mm-frame'])

  await test.step('dragging the central topic takes the whole map along', async () => {
    const before = await mapView(a.page)
    const from = await read(a.page, (ed) => {
      const bb = ed.getShapePageBounds('shape:mm-note')
      return bb ? ed.pageToScreen({ x: bb.x + 30, y: bb.y + 30 }) : null
    })
    if (!from) throw new Error('no note')
    await a.page.mouse.move(from.x, from.y)
    await a.page.mouse.down()
    await a.page.mouse.move(from.x + 60, from.y + 90, { steps: 10 })
    await a.page.mouse.up()
    await expectTidy(a.page)
    const after = await mapView(a.page)
    const dx = byText(after, 'Q4 goals').box.x - byText(before, 'Q4 goals').box.x
    const dy = byText(after, 'Q4 goals').box.y - byText(before, 'Q4 goals').box.y
    expect(Math.hypot(dx, dy)).toBeGreaterThan(40)
    for (const t of before.topics) {
      const moved = after.topics.find((x) => x.id === t.id)
      expect(Math.abs((moved?.box.x ?? 0) - t.box.x - dx), t.text).toBeLessThanOrEqual(1)
      expect(Math.abs((moved?.box.y ?? 0) - t.box.y - dy), t.text).toBeLessThanOrEqual(1)
    }
  })

  await test.step('a branch dropped on the other side of the centre switches side; Tidy up rebalances', async () => {
    const now = await mapView(a.page)
    const rev = byText(now, 'Revenue')
    const root = byText(now, 'Q4 goals')
    const target = rev.side === 'right' ? root.box.x - 400 : root.box.x + root.box.w + 400
    const from = await read(
      a.page,
      (ed, id) => {
        const bb = ed.getShapePageBounds(id)
        return bb ? ed.pageToScreen({ x: bb.x + 20, y: bb.y + bb.h / 2 }) : null
      },
      rev.id,
    )
    const to = await read(a.page, (ed, p) => ed.pageToScreen(p), { x: target, y: root.box.y })
    if (!from) throw new Error('no topic')
    await a.page.mouse.move(from.x, from.y)
    await a.page.mouse.down()
    await a.page.mouse.move(to.x, to.y, { steps: 12 })
    await a.page.mouse.up()
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
    const from = await read(
      a.page,
      (ed, id) => {
        const bb = ed.getShapePageBounds(id)
        return bb ? ed.pageToScreen({ x: bb.x + 12, y: bb.y + bb.h / 2 }) : null
      },
      hiring.id,
    )
    // Hiring's centre lands on Product's centre.
    const to = await read(a.page, (ed, p) => ed.pageToScreen(p), {
      x: product.box.x + product.box.w / 2 - hiring.box.w / 2 + 12,
      y: product.box.y + product.box.h / 2,
    })
    if (!from) throw new Error('no topic')
    await a.page.mouse.move(from.x, from.y)
    await a.page.mouse.down()
    await a.page.mouse.move(to.x, to.y, { steps: 12 })
    await a.page.mouse.up()
    await expect.poll(async () => structure(await mapView(a.page))).toContain('Product > Hiring')
    await expectTidy(a.page)
    await a.page.keyboard.press(`${mod}+z`)
    await expect.poll(async () => structure(await mapView(a.page))).toContain('Q4 goals > Hiring')
    await expectTidy(a.page)
  })

  await test.step('the outline: copied as Markdown, downloaded as CSV', async () => {
    await selectOnly(a.page, 'shape:mm-note')
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

  await test.step('Present: the map is on the slide, the topic bar is not', async () => {
    await selectOnly(a.page, 'shape:mm-note')
    await expect(a.page.getByTestId('mindmap-bar')).toBeVisible()
    const ui = presentUi(a.page)
    await ui.button.click()
    await expect(ui.overlay).toBeVisible()
    await expect(ui.title).toHaveText('Goals')
    await expect(a.page.getByTestId('mindmap-bar')).toBeHidden()
    for (const t of (await mapView(a.page)).topics) {
      await expect(a.page.locator(`.tl-shape[data-shape-id="${t.id}"]`)).toBeVisible()
    }
    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
  })
  expect(mapProblems(await mapView(a.page))).toEqual([])
})
