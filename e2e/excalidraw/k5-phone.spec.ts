// K5 (wave K): phone comfort on the Excalidraw board page, at 375 × 812 with touch (Playwright's mobile
// emulation reports `(pointer: coarse)`, as a phone does).
//
//  K5-2  Every field a phone types into is 16 px or more, so Safari on iPhone never zooms the page into it:
//        the comment composer, the Share dialog's invite field and selects, the dashboard search and the
//        board title rename. The sheets and the docked comment popover sit above the soft keyboard's
//        `--dr-kb-inset` (main.tsx). Not run here (no browser emulates a soft keyboard): a real iPhone's
//        and a real Android phone's keyboard (reported as not run with wave K).
//  K5-3  A phone with a touch screen rests on the Hand tool: a one-finger drag pans (on a note too) and moves
//        nothing; Select from "All tools" then selects and drags a note; Select picked stays; a one-time hint
//        (once per viewer, storage in try/catch). A desktop, and a narrow desktop window, keep Select.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/k5-phone.spec.ts --project=chromium --workers=1
import type { Locator, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import {
  expect,
  expectSaved,
  item,
  itemCenterOnScreen,
  items,
  selection,
  setTool,
  test,
  tool,
  viewport,
} from '../tests/support/canvas.ts'
import { openDashboard } from '../tests/support/dashboard-share.ts'
import { coveredControls, note, openPhoneSession, waitForA11y } from './a11y-kit.ts'

export const PHONE_375 = { width: 375, height: 812 }

const fontPx = (l: Locator) => l.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))

const coarse = (page: Page) => page.evaluate(() => matchMedia('(pointer: coarse)').matches)

test('K5-2: at 375 px on a touch screen every field is 16 px (no iOS zoom), and the docked comment sheet and panel sheets sit above the keyboard inset', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const a = await openPhoneSession(browser, board, users, 'alice', 'owner', PHONE_375)
  const page = a.page
  try {
    expect(await coarse(page)).toBe(true)

    await test.step('the board title rename field', async () => {
      await page.getByTestId('board-title').tap()
      const input = page.getByTestId('board-title-input')
      await expect(input).toBeVisible()
      expect(await fontPx(input)).toBeGreaterThanOrEqual(16)
      await page.keyboard.press('Escape')
      await expect(input).toHaveCount(0)
    })

    await test.step('the comment composer, docked at the bottom; lifted by the keyboard inset', async () => {
      await setTool(page, 'comment')
      const c = await page.locator('[data-lobby-board-canvas]').boundingBox()
      if (!c) throw new Error('no canvas')
      await page.touchscreen.tap(c.x + c.width / 2, c.y + c.height * 0.3)
      const popover = page.getByTestId('new-comment-popover')
      await expect(popover).toHaveAttribute('data-docked', 'true')
      const composer = popover.getByTestId('comment-composer')
      expect(await fontPx(composer)).toBeGreaterThanOrEqual(16)
      const before = await popover.boundingBox()
      if (!before) throw new Error('no popover box')
      // what main.tsx sets while Safari's keyboard covers the bottom 300 px of the layout viewport
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--dr-kb-inset', '300px')
        document.documentElement.setAttribute('data-dr-kb', '')
      })
      await expect
        .poll(async () => Math.round((await popover.boundingBox())?.y ?? 0))
        .toBeLessThan(Math.round(before.y))
      const lifted = await popover.boundingBox()
      if (!lifted) throw new Error('no popover box')
      // its bottom is 300 px higher (or more: it also got shorter), and its top stays on the canvas
      expect(lifted.y + lifted.height).toBeLessThanOrEqual(before.y + before.height - 300 + 1)
      expect(lifted.y).toBeGreaterThanOrEqual(c.y - 1)
      // the Post button is above the keyboard
      const post = popover.getByTestId('comment-submit')
      const p = await post.boundingBox()
      expect((p?.y ?? 9999) + (p?.height ?? 0)).toBeLessThanOrEqual(PHONE_375.height - 300)
      await page.screenshot({ path: testInfo.outputPath('k5-2-composer-above-keyboard.png') })
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--dr-kb-inset', '0px')
        document.documentElement.removeAttribute('data-dr-kb')
      })
      await expect
        .poll(async () => Math.round((await popover.boundingBox())?.y ?? 0))
        .toBe(Math.round(before.y))
      await page.keyboard.press('Escape')
      await expect(popover).toHaveCount(0)
      await setTool(page, 'select')
    })

    await test.step('a dock panel sheet (Comments) ends above the keyboard inset', async () => {
      await page.getByTestId('dock-rail-toggle').tap()
      await page.getByTestId('dock-tab-comments').tap()
      const panel = page.getByTestId('dock-panel-comments')
      await expect(panel).toBeVisible()
      const full = await panel.boundingBox()
      await page.evaluate(() => document.documentElement.style.setProperty('--dr-kb-inset', '300px'))
      await expect
        .poll(async () => Math.round(((await panel.boundingBox())?.height ?? 0) + 300))
        .toBe(Math.round(full?.height ?? 0))
      await page.evaluate(() => document.documentElement.style.setProperty('--dr-kb-inset', '0px'))
      await page.getByTestId('dock-panel-close').tap()
      await expect(panel).toHaveCount(0)
    })

    await test.step('the Share dialog: the invite field and every select', async () => {
      await page.getByTestId('share-button').tap()
      const dialog = page.getByTestId('share-dialog')
      await expect(dialog).toBeVisible()
      const input = dialog.getByTestId('share-invite-input')
      await expect(input).toBeVisible()
      expect(await fontPx(input)).toBeGreaterThanOrEqual(16)
      const sizes = await dialog
        .locator('select, input:not([type="checkbox"]), textarea')
        .evaluateAll((els) =>
          els.map((el) => ({
            id: el.getAttribute('data-testid') ?? el.tagName,
            px: Number.parseFloat(getComputedStyle(el).fontSize),
          })),
        )
      expect(sizes.length).toBeGreaterThan(2)
      expect(sizes.filter((s) => s.px < 16)).toEqual([])
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    })

    await test.step('the dashboard search', async () => {
      await openDashboard(page, users.devStudioId)
      const search = page.getByTestId('dashboard-search')
      await expect(search).toBeVisible()
      expect(await fontPx(search)).toBeGreaterThanOrEqual(16)
    })
  } finally {
    await a.context.close()
  }
})

test('K5-2: on a desktop (a fine pointer) the fields keep their size', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  const page = a.page
  expect(await coarse(page)).toBe(false)
  await page.getByTestId('share-button').click()
  const input = page.getByTestId('share-dialog').getByTestId('share-invite-input')
  await expect(input).toBeVisible()
  expect(await fontPx(input)).toBeLessThan(16)
})

// ---- K5-3: phones rest on the Hand tool -----------------------------------------------------------------------

type Pt = { x: number; y: number }

/** A one-finger touch drag through the browser's own touch input (CDP), in `steps` moves. */
async function touchDrag(page: Page, from: Pt, to: Pt, steps = 10): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] })
    for (let i = 1; i <= steps; i++) {
      const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...p, id: 1 }] })
      await page.waitForTimeout(16)
    }
    // the finger rests before it lifts: no fling (Chromium does not turn the next tap into a click while a
    // fling it started is still settling, as a phone does not)
    await page.waitForTimeout(200)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...to, id: 1 }] })
    await page.waitForTimeout(100)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await cdp.detach()
  }
}

/** Every live element's position (labels included), by id. */
const positions = async (page: Page) =>
  Object.fromEntries((await items(page)).map((e) => [e.id, `${Math.round(e.x)},${Math.round(e.y)}`]))

test('K5-3: a phone starts on Hand: a one-finger drag pans and moves no note (on a note too); Select from "All tools" then drags a note; the hint shows once', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const a = await openPhoneSession(browser, board, users, 'alice', 'owner', PHONE_375)
  const page = a.page
  try {
    const id = await note(page, 0, 0, 'Drag me')

    await test.step('after the board loads it is on Hand, and the hint says how to select', async () => {
      await expect.poll(() => tool(page)).toBe('hand')
      const hint = page.getByTestId('phone-hand-hint')
      await expect(hint).toBeVisible()
      await expect(hint).toContainText('Drag to look around the board.')
      await expect(hint).toContainText('tap to select, drag to move')
      // it covers no control: it sits under the top-left corner, clear of the chrome
      expect(await coveredControls(page, ['[data-lobby-slot]', 'header.dr-topbar'])).toEqual([])
      await page.screenshot({ path: testInfo.outputPath('k5-3-hand-hint.png') })
      await expect(page.getByTestId('phone-sheet-open')).toHaveAccessibleName('All tools')
    })

    await test.step('a one-finger drag on empty canvas pans; no element moves', async () => {
      const before = await positions(page)
      const v0 = await viewport(page)
      const c = await page.locator('[data-lobby-board-canvas]').boundingBox()
      if (!c) throw new Error('no canvas')
      // empty canvas below and right of the note; the board moves down and right (the note with it)
      await touchDrag(
        page,
        { x: c.x + c.width * 0.6, y: c.y + c.height * 0.7 },
        { x: c.x + c.width * 0.75, y: c.y + c.height * 0.8 },
      )
      await expect.poll(async () => (await viewport(page)).x).not.toBe(v0.x)
      expect((await viewport(page)).zoom).toBe(v0.zoom)
      expect(await positions(page)).toEqual(before)
      // the hint went with the first touch
      await expect(page.getByTestId('phone-hand-hint')).toHaveCount(0)
    })

    await test.step('a one-finger drag that starts on a note pans too: the note stays where it is', async () => {
      const before = await positions(page)
      const v0 = await viewport(page)
      const at = await itemCenterOnScreen(page, id)
      await touchDrag(page, at, { x: at.x + 40, y: at.y + 60 })
      await expect.poll(async () => (await viewport(page)).y).not.toBe(v0.y)
      await page.waitForTimeout(300)
      expect(await positions(page)).toEqual(before)
    })

    await test.step('Select from "All tools", then a tap selects the note and a drag moves it', async () => {
      await page.getByTestId('phone-sheet-open').tap()
      await page.locator('[data-testid="phone-sheet-tool"][data-tool="select"]').tap()
      await expect.poll(() => tool(page)).toBe('select')
      const at = await itemCenterOnScreen(page, id)
      await page.touchscreen.tap(at.x, at.y)
      await expect.poll(() => selection(page)).toEqual([id])
      // past the double-tap window (300 ms): a touch right after a tap on the same spot is a double tap
      await page.waitForTimeout(450)
      const x0 = (await item(page, id))?.x ?? 0
      await touchDrag(page, at, { x: at.x + 80, y: at.y }, 12)
      await expect
        .poll(async () => Math.round((await item(page, id))?.x ?? 0))
        .toBeGreaterThan(Math.round(x0) + 40)
      await expectSaved(page)
    })

    await test.step('Select picked by the person stays when "All tools" is closed without a pick', async () => {
      await page.getByTestId('phone-sheet-open').tap()
      await expect(page.getByTestId('phone-sheet')).toBeVisible()
      await page.getByTestId('phone-sheet-close').tap()
      await expect(page.getByTestId('phone-sheet')).toHaveCount(0)
      expect(await tool(page)).toBe('select')
    })

    await test.step('after a note tool (the board back on Select), closing "All tools" rests on Hand again', async () => {
      await page.getByTestId('phone-sheet-open').tap()
      await page.locator('[data-testid="phone-sheet-tool"][data-tool="note"]').tap()
      await expect.poll(() => tool(page)).toBe('note')
      await page.getByTestId('phone-sheet-open').tap()
      await page.getByTestId('phone-sheet-close').tap()
      // a note tool still armed is the person's pick: kept
      expect(await tool(page)).toBe('note')
      await setTool(page, 'select') // where the engine returns once a note is placed
      await page.getByTestId('phone-sheet-open').tap()
      await page.getByTestId('phone-sheet-close').tap()
      await expect.poll(() => tool(page)).toBe('hand')
    })

    await test.step('a reload: Hand again, and no hint (once per viewer)', async () => {
      await page.reload()
      await waitForA11y(page)
      await expect.poll(() => tool(page)).toBe('hand')
      await page.waitForTimeout(500)
      await expect(page.getByTestId('phone-hand-hint')).toHaveCount(0)
    })
  } finally {
    await a.context.close()
  }
})

test('K5-3: with storage that throws (blocked site data) the hint still shows once and the board works', async ({
  browser,
  board,
  users,
}) => {
  const who = await users.get('alice')
  const context = await browser.newContext({ viewport: PHONE_375, hasTouch: true, isMobile: true })
  try {
    await context.addInitScript(() => {
      const deny = () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      }
      const blocked = { getItem: deny, setItem: deny, removeItem: deny, clear: deny, key: deny, length: 0 }
      Object.defineProperty(window, 'localStorage', { configurable: true, get: () => blocked })
    })
    const page = await context.newPage()
    await signInContext(context, who.handle, who.name)
    await page.goto(`/b/${board}`)
    await waitForA11y(page)
    await expect.poll(() => tool(page)).toBe('hand')
    await expect(page.getByTestId('phone-hand-hint')).toBeVisible()
    await page.getByTestId('phone-hand-hint-ok').tap()
    await expect(page.getByTestId('phone-hand-hint')).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('K5-3: a viewer on a phone rests on Hand too, and gets no hint about moving notes', async ({
  browser,
  board,
  users,
}) => {
  const v = await openPhoneSession(browser, board, users, 'carol', 'viewer', PHONE_375)
  try {
    await expect.poll(() => tool(v.page)).toBe('hand')
    await v.page.waitForTimeout(500)
    await expect(v.page.getByTestId('phone-hand-hint')).toHaveCount(0)
  } finally {
    await v.context.close()
  }
})

test('K5-3: a desktop keeps Select and shows no hint; a narrow desktop window too', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  await page.waitForTimeout(500)
  expect(await tool(page)).toBe('select')
  await expect(page.getByTestId('phone-hand-hint')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('phone-sheet-open')).toBeVisible()
  await page.waitForTimeout(500)
  expect(await tool(page)).toBe('select')
  await expect(page.getByTestId('phone-hand-hint')).toHaveCount(0)
})

// ---- K5-4: 40 px touch targets in the board chrome, words in the "⋯" menu ------------------------------------

/**
 * Every visible control under `selectors` that a 40 x 40 px square centred on it would not wholly hit: nine
 * points of the square (its corners 1 px in, the middles of its sides, its centre), asked of the browser
 * (elementFromPoint). Returns one line per miss: "<control> (dx, dy) under <what>".
 */
const missedTargets = (page: Page, selectors: readonly string[]) =>
  page.evaluate((sels) => {
    const out: string[] = []
    const name = (el: Element) =>
      el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.tagName
    for (const sel of sels) {
      for (const c of document.querySelectorAll(sel)) {
        const r = c.getBoundingClientRect()
        if (r.width === 0 || r.height === 0 || getComputedStyle(c).visibility === 'hidden') continue
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        for (const dx of [-19, 0, 19])
          for (const dy of [-19, 0, 19]) {
            const top = document.elementFromPoint(cx + dx, cy + dy)
            if (top && (top === c || c.contains(top))) continue
            const tagged = top?.closest('[data-testid]')
            out.push(
              `${name(c)} (${dx}, ${dy}) under ${tagged?.getAttribute('data-testid') ?? top?.tagName ?? 'nothing'}`,
            )
          }
      }
    }
    return out
  }, selectors)

/** Drawn sizes (the controls' own boxes), by test id. */
const drawnSizes = (page: Page, selector: string) =>
  page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0)
        .map(({ el, r }) => ({
          id: el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.className,
          w: Math.round(r.width),
          h: Math.round(r.height),
        })),
    selector,
  )

const TOPBAR_CONTROLS = 'header.dr-topbar :is(button, a[href])'
const QUICK_ACTIONS = '.cux-quick--toolbar > .cux-quick__bar > .cux-quick__btn'

/** Generated text of an element's ::before or ::after ('' for none). */
const pseudoText = (content: string) =>
  content && content !== 'none' && content !== 'normal' ? (JSON.parse(content) as string) : ''

for (const size of [PHONE_375, { width: 360, height: 740 }, { width: 412, height: 915 }]) {
  test(`K5-4: at ${size.width} px with touch every visible top-bar control and quick action takes a finger in a 40 px square, and none is drawn bigger`, async ({
    browser,
    board,
    users,
  }, testInfo) => {
    const a = await openPhoneSession(browser, board, users, 'alice', 'owner', size)
    const page = a.page
    try {
      await note(page, 0, 0, 'Targets')
      // the people chip arrives a moment after the first paint; the quick actions with the toolbar. Since K2-5
      // the bell and the comment tool are in the "⋯" menu on a phone (wave K integration)
      await expect(page.getByTestId('topbar').locator('.dr-people')).toBeVisible()
      await expect(page.getByTestId('topbar-overflow')).toBeVisible()
      await expect(page.getByTestId('notifications-bell')).toBeHidden()
      await expect(page.getByTestId('quick-actions.undo')).toBeVisible()
      // the one-time hint goes with a tap on "Got it"
      await page.getByTestId('phone-hand-hint-ok').tap()
      const controls = await drawnSizes(page, TOPBAR_CONTROLS)
      expect(controls.map((c) => c.id)).toEqual(
        expect.arrayContaining(['board-title', 'people-open', 'topbar-overflow', 'share-button']),
      )

      await test.step('40 x 40 px around each control hits that control (and only it)', async () => {
        await expect.poll(() => missedTargets(page, [TOPBAR_CONTROLS, QUICK_ACTIONS])).toEqual([])
      })

      await test.step('drawn as before: 28 px icons, the 32 x 30 Share, 36 px quick actions', async () => {
        const top = await drawnSizes(page, `${TOPBAR_CONTROLS}:not([data-testid="board-title"])`)
        for (const c of top) {
          if (c.id === 'share-button') {
            expect(c.w, c.id).toBeLessThanOrEqual(34)
            expect(c.h, c.id).toBe(30)
          } else if (c.id === 'people-open') expect(c.h, c.id).toBe(28)
          else expect([c.id, c.w, c.h]).toEqual([c.id, 28, 28])
        }
        const quick = await drawnSizes(page, QUICK_ACTIONS)
        expect(quick.length).toBeGreaterThanOrEqual(5)
        for (const q of quick) expect([q.id, q.w, q.h]).toEqual([q.id, 36, 36])
        // the title is a 40 px tall button (transparent until hovered)
        const title = (await drawnSizes(page, '[data-testid="board-title"]'))[0]
        expect(title?.h).toBeGreaterThanOrEqual(40)
        expect(title?.w).toBeGreaterThanOrEqual(40)
      })

      await test.step('everything stays on the screen, nothing scrolls sideways', async () => {
        const off = await page.locator('header.dr-topbar').evaluate((bar) =>
          [...bar.querySelectorAll('button, a[href]')].flatMap((el) => {
            const r = el.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) return []
            return r.left >= -0.5 && r.right <= innerWidth + 0.5 ? [] : [el.getAttribute('data-testid')]
          }),
        )
        expect(off).toEqual([])
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false)
      })
      await page
        .locator('header.dr-topbar')
        .screenshot({ path: testInfo.outputPath(`k5-4-topbar-${size.width}.png`) })
      await page
        .locator('.cux-quick--toolbar')
        .screenshot({ path: testInfo.outputPath(`k5-4-quick-actions-${size.width}.png`) })
    } finally {
      await a.context.close()
    }
  })
}

test('K5-4: a desktop (a fine pointer) keeps its spacing: no hit areas are added', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('topbar')).toHaveAttribute('data-width', 'phone')
  // a control still on the phone bar (since K2-5 the comment tool is in the "⋯" menu, where ::after is its name)
  for (const id of ['topbar-overflow', 'people-open', 'share-button']) {
    const after = await page.getByTestId(id).evaluate((el) => getComputedStyle(el, '::after').content)
    expect(after, id).toBe('none')
  }
})

test('K5-4: in the "⋯" menu every item shows its name in words: icon-only ones their accessible name', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const a = await openPhoneSession(browser, board, users, 'alice', 'owner', PHONE_375)
  const page = a.page
  try {
    await page.getByTestId('topbar-overflow').tap()
    const panel = page.getByTestId('topbar-overflow-panel')
    await expect(panel).toHaveAttribute('data-open', 'true')
    await expect(panel.getByTestId('comment-tool')).toBeVisible()
    const rows = await panel.locator('button').evaluateAll((els) =>
      els
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => ({
          id: el.getAttribute('data-testid'),
          label: el.getAttribute('aria-label'),
          own: (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
          before: getComputedStyle(el, '::before').content,
          after: getComputedStyle(el, '::after').content,
        })),
    )
    const shown = (r: (typeof rows)[number]) =>
      [pseudoText(r.before), r.own, pseudoText(r.after)].filter(Boolean).join(' ').trim()
    expect(rows.length).toBeGreaterThanOrEqual(4)
    for (const r of rows) {
      expect(shown(r), `${r.id} shows words`).not.toBe('')
      if (!r.label) continue
      if (r.own === '') expect(shown(r), `${r.id}: an icon-only item shows its accessible name`).toBe(r.label)
      // an item with its own words: they begin its accessible name (WCAG 2.5.3, label in name)
      else expect(r.label.startsWith(r.own), `${r.id}: "${r.own}" in "${r.label}"`).toBe(true)
    }
    // the icon-only ones in it since K2-5 and K3-3 (wave K integration): the comment tool and the bell (Export
    // left the bar for the Board menu, the reactions smiley went into Facilitate)
    const by = (id: string) => rows.find((r) => r.id === id)
    expect(shown(by('comment-tool') as (typeof rows)[number])).toBe('Comment tool')
    expect(shown(by('notifications-bell') as (typeof rows)[number])).toBe('Notifications')
    await panel.screenshot({ path: testInfo.outputPath('k5-4-overflow-labels.png') })
  } finally {
    await a.context.close()
  }
})
