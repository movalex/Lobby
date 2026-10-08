// K2-1 (wave K, UXD-05): no blue ring around the whole canvas after Escape out of a note or a text when the
// person was using a pointer. The rule is features/a11y/ported/focus-ring.ts: only Tab, F6 and an explicit
// entry ("Skip to canvas", the F6 command) make the keyboard the last input; typing and Escape do not.
// The keyboard paths keep the ring (a11y-traversal.spec.ts W5-45).
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

test('K2-1: click a note, type, Escape: no ring element and no outline on the canvas wrapper', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const id = await note(a.page, 0, 0, '')
  await zoomToFit(a.page)

  await clickItem(a.page, id)
  // typing on a selected note opens its editor through the lease (type-to-edit)
  await a.page.keyboard.press('H')
  await waitForTextEditor(a.page, id)
  await typeText(a.page, 'ello there')
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

  await test.step('a double-click edit ends the same way', async () => {
    await dblclickItem(a.page, id)
    await waitForTextEditor(a.page, id)
    await typeText(a.page, '!')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => boardHasFocus(a.page)).toBe(true)
    await a.page.waitForTimeout(150)
    expect((await ringAndOutlines(a.page)).ring).toBe(0)
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

  await a.page.getByTestId('present-button').click()
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
