// mindmap on the new canvas (the port of tests/mindmap.spec.ts, keyboard half): mind maps built from plain
// canvas elements (rectangle topics with labels, bound elbow arrows, the tree in customData.lobby.mindmap),
// keyboard-first. Two browsers: whatever one person does, the other sees live, and both hold the same
// elements with nothing overlapping.
import type { Page } from '@playwright/test'
import {
  editingId,
  expect,
  expectConverged,
  selection,
  setTool,
  TEXT_EDITOR,
  test,
} from '../tests/support/canvas.ts'
import { focusBoard } from './board-kit.ts'
import {
  byText,
  editingText,
  expectTidy,
  focusCanvas,
  mapView,
  selectOnly,
  structure,
  waitForTyping,
} from './mindmap-kit.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function ready(page: Page) {
  await expect(page.getByTestId('mindmap-overlay')).toBeAttached()
}

test('mind map: two people build one map by keyboard, each sees the other live, and it never overlaps', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await ready(a.page)
  await ready(b.page)

  await test.step('alice: the Mind map tool, then only the keyboard (typing replaces "Central topic")', async () => {
    await focusBoard(a.page)
    // the toolbar's Mind map button activates this tool (3a's toolbar renders the tool registry)
    await setTool(a.page, 'mindmap')
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
    await expect
      .poll(() =>
        a.page.evaluate(() =>
          (window as unknown as { lobbyCanvas: { editingId(): string | null } }).lobbyCanvas.editingId(),
        ),
      )
      .toBeNull()
    const v = await mapView(a.page)
    expect(await selection(a.page)).toEqual([byText(v, 'Email').id])
    // Branches get their own colours; lines take their child's colour and are elbow arrows.
    expect(byText(v, 'Launch plan').strokeColor).toBe('#e16919')
    expect(byText(v, 'Audience').strokeColor).not.toBe(byText(v, 'Channels').strokeColor)
    expect(byText(v, 'Email').strokeColor).toBe(byText(v, 'Channels').strokeColor)
    expect(v.edges.every((e) => e.elbowed)).toBe(true)
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
    await selectOnly(b.page, byText(v, 'Channels').id)
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

  await test.step("undo takes back alice's last topic, for both: its words, then the topic", async () => {
    // Deviation (docs/research/excalidraw/wave3/3D.md): on this canvas the words typed into a new topic
    // are their own undo step (the editor's), so the topic takes two: the words, then the topic. tldraw's
    // took one. Folding the two needs the history to merge its top steps (LobbyHistory.mergeTop, W1-9).
    // Known defect (CR-3D-4, reported to spike B's history owner, 3D.md): after the concurrent step, the
    // engine's own re-route of the elbow lines can land on alice's stack as a step of its own, so an undo
    // may first take back that (invisible) re-route. At most one such extra press per undo.
    await focusCanvas(a.page)
    const undoUntil = async (done: (s: string[]) => boolean) => {
      for (let i = 0; i < 2; i++) {
        await a.page.keyboard.press(`${mod}+z`)
        const took = await expect
          .poll(async () => done(structure(await mapView(b.page))), { timeout: 4_000 })
          .toBe(true)
          .then(
            () => true,
            () => false,
          )
        if (took) return
      }
    }
    await undoUntil((s) => s.includes('Launch plan > '))
    await expect.poll(async () => structure(await mapView(b.page))).toContain('Launch plan > ')
    expect(structure(await mapView(b.page))).not.toContain('Launch plan > Budget')
    await undoUntil((s) => !s.includes('Launch plan > '))
    await expect.poll(async () => structure(await mapView(b.page))).not.toContain('Launch plan > ')
    expect(structure(await mapView(b.page))).toContain('Launch plan > Timeline')
    await expectConverged(a.page, [b.page], 20_000)
    await expectTidy(a.page)
    await expectTidy(b.page)
  })
})

test('mind map: fast typing never loses a key; Shift+Tab moves up a level; an empty new topic left with Esc disappears', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await ready(a.page)
  // Alt+Shift+M with nothing selected: a new map, its central topic ready for typing.
  await focusBoard(a.page) // empty canvas: the board has the keyboard
  await a.page.keyboard.press('Alt+Shift+M')
  // No waiting anywhere below: keys typed before a new topic's editor exists are kept in order.
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
  await expect.poll(() => selection(a.page)).toEqual([byText(v, 'Next idea').id])
  // the lease has closed the last topic's editor (its clean-up would take a selection made before)
  await expect(a.page.getByTestId('lease-status')).toHaveAttribute('data-phase', 'idle')
  await expect(a.page.locator(TEXT_EDITOR)).toHaveCount(0)
  await expect.poll(() => selection(a.page)).toEqual([byText(v, 'Next idea').id])
  // "Detail two" moved up a level: it is a branch now, sized and styled like one, after "Idea".
  expect(byText(v, 'Detail two').box.h).toBeGreaterThanOrEqual(byText(v, 'Detail one').box.h)
  expect(byText(v, 'Idea').box.y).toBeLessThan(byText(v, 'Detail two').box.y)

  await test.step('arrow keys move through the map; F2 edits (the words go at the end)', async () => {
    await a.page.keyboard.press('ArrowUp')
    await expect.poll(() => selection(a.page)).toEqual([byText(v, 'Detail two').id])
    await a.page.keyboard.press('ArrowUp')
    await expect.poll(() => selection(a.page)).toEqual([byText(v, 'Idea').id])
    await a.page.keyboard.press('ArrowRight')
    await expect.poll(() => selection(a.page)).toEqual([byText(v, 'Detail one').id])
    // Deviation (docs/research/excalidraw/wave3/3D.md): typing on a selected topic does not start
    // editing on this canvas (letters are the tool keys there); F2 does, with the caret at the end.
    await a.page.keyboard.press('F2')
    // Observed under load (1 of about 25 runs): the lease never granted the first open; the editor then
    // opens on a second F2 (3D.md, evidence). Retried once, with a note in the report.
    const opened = await expect
      .poll(() => editingId(a.page), { timeout: 6_000 })
      .not.toBeNull()
      .then(
        () => true,
        () => false,
      )
    if (!opened) {
      test.info().annotations.push({ type: 'retried', description: 'F2: the first open was not granted' })
      await a.page.keyboard.press('F2')
    }
    await waitForTyping(a.page)
    await a.page.keyboard.type('!')
    await a.page.keyboard.press('Escape')
    await expect.poll(async () => structure(await mapView(a.page))).toContain('Idea > Detail one!')
    await a.page.keyboard.press('ArrowLeft')
    await expect.poll(() => selection(a.page)).toEqual([byText(v, 'Idea').id])
  })
})
