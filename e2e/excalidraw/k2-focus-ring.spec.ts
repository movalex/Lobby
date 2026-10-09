// K2-1 (wave K, UXD-05): no blue ring around the whole canvas after Escape out of a note or a text when the
// person was using a pointer. The rule is features/a11y/ported/focus-ring.ts: since wave K.1 native
// `:focus-visible` semantics, any key that moves the focus or acts on the board makes the keyboard the last
// input (WCAG 2.4.7: a keyboard user who clicked once and then works by keys gets the ring); Escape, a modifier
// alone, Ctrl/Meta/Alt chords and typing into the note do not. The keyboard paths keep the ring
// (a11y-traversal.spec.ts W5-45).
import fs from 'node:fs'
import type { Page } from '@playwright/test'
import {
  clickItem,
  dblclickItem,
  expect,
  test,
  typeText,
  waitForTextEditor,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { boardHasFocus, frame, note, waitForA11y } from './a11y-kit.ts'
import { emptyCanvasPoint, focusBoard } from './board-kit.ts'
import { startPresenting } from './present-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/** The ring element, and any outline or box shadow on the canvas wrapper and the element that has the focus. */
async function ringAndOutlines(page: Page) {
  return page.evaluate(() => {
    const look = (el: Element | null) => {
      if (!el) return null
      const cs = getComputedStyle(el)
      return {
        outline:
          cs.outlineStyle === 'none' || cs.outlineWidth === '0px'
            ? 'none'
            : `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
        shadow: cs.boxShadow,
      }
    }
    return {
      ring: document.querySelectorAll('[data-testid="canvas-focus-ring"]').length,
      wrapper: look(document.querySelector('[data-lobby-board-canvas]')),
      active: look(document.activeElement),
      activeIsCanvas:
        !!document.activeElement?.closest('.excalidraw') && document.activeElement?.tagName !== 'TEXTAREA',
    }
  })
}

test('K2-1: double-click a note, type, Escape: no ring element and no outline on the canvas wrapper', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const id = await note(a.page, 0, 0, '')
  await zoomToFit(a.page)

  await clickItem(a.page, id)
  // the pointer opens the editor (type-to-edit's path is the K.1 refix step below)
  await dblclickItem(a.page, id)
  await waitForTextEditor(a.page, id)
  await typeText(a.page, 'Hello there')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => boardHasFocus(a.page)).toBe(true)
  // give the ring a frame to appear if it were going to
  await a.page.waitForTimeout(150)
  const seen = await ringAndOutlines(a.page)
  await testInfo.attach('k2-1-after-escape.json', {
    body: JSON.stringify(seen, null, 2),
    contentType: 'application/json',
  })
  expect(seen.ring).toBe(0)
  expect(seen.activeIsCanvas).toBe(true)
  expect(seen.wrapper?.outline).toBe('none')
  expect(seen.wrapper?.shadow).toBe('none')
  expect(seen.active?.outline).toBe('none')
  await a.page.screenshot({ path: testInfo.outputPath('k2-1-no-ring.png') })

  await test.step('a second edit ends the same way, and Escape on the board alone brings no ring', async () => {
    await dblclickItem(a.page, id)
    await waitForTextEditor(a.page, id)
    await typeText(a.page, '!')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
    await a.page.keyboard.press('Escape')
    await a.page.keyboard.press('Shift')
    await a.page.waitForTimeout(150)
    expect((await ringAndOutlines(a.page)).ring).toBe(0)
  })

  await test.step('K.1 refix: type-to-edit (the typed letters open the editor), then Escape: no ring either', async () => {
    await clickItem(a.page, id)
    await a.page.keyboard.type('Hey') // the first key asks for the lease, the rest wait for it
    await waitForTextEditor(a.page, id)
    await a.page.keyboard.press('Escape')
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
    await a.page.waitForTimeout(150)
    expect((await ringAndOutlines(a.page)).ring).toBe(0)
  })

  await test.step('K.1 refix: cursor chat ("/", a message, Enter) by a pointer user brings no ring back', async () => {
    await focusBoard(a.page) // a click on empty canvas: nothing selected, the pointer rests on the board
    const p = await emptyCanvasPoint(a.page)
    await a.page.mouse.move(p.x - 40, p.y - 30, { steps: 4 })
    await a.page.keyboard.press('/')
    await expect(a.page.getByTestId('cursor-chat-input')).toBeFocused()
    await a.page.keyboard.type('hi all', { delay: 15 })
    await a.page.keyboard.press('Enter')
    await expect(a.page.getByTestId('cursor-chat-input')).toHaveCount(0)
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
    await a.page.waitForTimeout(150)
    expect((await ringAndOutlines(a.page)).ring).toBe(0)
  })

  await test.step('K.1 (WCAG 2.4.7): after that click, a key that acts on the board shows the ring at once', async () => {
    await clickItem(a.page, id)
    await expect(a.page.getByTestId('canvas-focus-ring')).toHaveCount(0)
    // an arrow nudges the selected note: the keyboard is working the board now
    await a.page.keyboard.press('ArrowRight')
    await expect(a.page.getByTestId('canvas-focus-ring')).toBeVisible()
    await a.page.mouse.move(380, 380)
    await a.page.mouse.move(400, 400)
    await expect(a.page.getByTestId('canvas-focus-ring')).toHaveCount(0)
    // a tool's letter does too
    await clickItem(a.page, id)
    await a.page.keyboard.press('Escape') // nothing selected; Escape alone: no ring
    await a.page.waitForTimeout(150)
    await expect(a.page.getByTestId('canvas-focus-ring')).toHaveCount(0)
    await a.page.keyboard.press('r')
    await expect(a.page.getByTestId('canvas-focus-ring')).toBeVisible()
    await a.page.keyboard.press('v')
    await a.page.mouse.move(420, 410)
    await a.page.mouse.move(440, 420)
    await expect(a.page.getByTestId('canvas-focus-ring')).toHaveCount(0)
  })

  await test.step('Tab from the dock still brings the ring; the next pointer move takes it away', async () => {
    await a.page.getByTestId('dock-add-note').focus()
    for (let i = 0; i < 6 && !(await boardHasFocus(a.page)); i++) await a.page.keyboard.press('Tab')
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
    await expect(a.page.getByTestId('canvas-focus-ring')).toBeVisible()
    await a.page.mouse.move(400, 400)
    await a.page.mouse.move(420, 410)
    await expect(a.page.getByTestId('canvas-focus-ring')).toHaveCount(0)
  })
})

test('K2-1: present mode draws no focus ring on any slide (the present-slide border case)', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await frame(a.page, 0, 0, 800, 450, 'Slide one')
  await frame(a.page, 1000, 0, 800, 450, 'Slide two')
  await zoomToFit(a.page)
  // the keyboard on the board first (Tab), the way the ring would show if anything kept it
  await a.page.getByTestId('dock-add-note').focus()
  for (let i = 0; i < 6 && !(await boardHasFocus(a.page)); i++) await a.page.keyboard.press('Tab')
  await expect(a.page.getByTestId('canvas-focus-ring')).toBeVisible()

  await startPresenting(a.page.getByTestId('present-button'))
  await expect(a.page.getByTestId('present-overlay')).toBeVisible()
  await a.page.keyboard.press('ArrowRight')
  await expect(a.page.getByTestId('present-counter')).toContainText('2')
  await a.page.waitForTimeout(400)
  const seen = await ringAndOutlines(a.page)
  // what draws a border on slide 2, if anything: recorded for the PR (UXD-05 asked for this case)
  const focused = await a.page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el) return null
    const cs = getComputedStyle(el)
    return {
      tag: el.tagName,
      testId: el.dataset.testid ?? null,
      className: el.className,
      focusVisible: el.matches(':focus-visible'),
      outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
      outlineOffset: cs.outlineOffset,
    }
  })
  // every large element that draws an outline, a border or a shadow over the slide
  const drawn = await a.page.evaluate(() => {
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width < 200 || r.height < 200) continue
      const cs = getComputedStyle(el)
      const parts: string[] = []
      if (cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px')
        parts.push(`outline ${cs.outlineWidth} ${cs.outlineColor} offset ${cs.outlineOffset}`)
      if (cs.boxShadow !== 'none') parts.push(`shadow ${cs.boxShadow}`)
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const w = cs.getPropertyValue(`border-${side}-width`)
        if (w !== '0px' && cs.getPropertyValue(`border-${side}-style`) !== 'none')
          parts.push(`border-${side} ${w} ${cs.getPropertyValue(`border-${side}-color`)}`)
      }
      if (parts.length)
        out.push(
          `${el.tagName}.${String(el.className).slice(0, 60)} [${el.dataset.testid ?? ''}] ${Math.round(r.width)}x${Math.round(r.height)}: ${parts.join('; ')}`,
        )
    }
    return out
  })
  const report = JSON.stringify({ seen, focused, drawn }, null, 2)
  await testInfo.attach('k2-1-present-slide-2.json', { body: report, contentType: 'application/json' })
  fs.writeFileSync(testInfo.outputPath('k2-1-present-slide-2.json'), report)
  await a.page.screenshot({ path: testInfo.outputPath('k2-1-present-slide-2.png') })
  // the a11y ring is not drawn in focus mode (presenting)
  expect(seen.ring).toBe(0)
  await a.page.keyboard.press('Escape')
  await expect(a.page.getByTestId('present-overlay')).toHaveCount(0)
})
