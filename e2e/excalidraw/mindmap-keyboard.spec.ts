// mindmap on the new canvas (the port of tests/mindmap.spec.ts, keyboard half): mind maps built from plain
// canvas elements (rectangle topics with labels, bound elbow arrows, the tree in customData.lobby.mindmap),
// keyboard-first. Two browsers: whatever one person does, the other sees live, and both hold the same
// elements with nothing overlapping.
import type { Page } from '@playwright/test'
import { expect, expectConverged, selection, setTool, test } from '../tests/support/canvas.ts'
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

  await test.step("undo takes back alice's last topic, for both", async () => {
    await focusCanvas(a.page)
    await a.page.keyboard.press(`${mod}+z`)
    await expect.poll(async () => structure(await mapView(b.page))).not.toContain('Launch plan > Budget')
    expect(structure(await mapView(b.page))).toContain('Launch plan > Timeline')
    await expectConverged(a.page, [b.page], 20_000)
    await expectTidy(a.page)
    await expectTidy(b.page)
  })
})
