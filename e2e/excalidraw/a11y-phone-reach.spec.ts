// OWNER: 3i. Every phone control can be tapped where it is drawn (the early wave-5 review,
// docs/research/excalidraw/REVIEW-W5-EARLY.md W5-06 and W5-07, 3i's part "phone flows" and "phone sheet").
// The reviewers (at 1809cf3) found Zoom to fit on top of the Select tool, the board menu under the dock's
// fold button, and the floating "Board actions" button (≡, 3i's phone sheet) and the tool dock on top of the
// comment sheet and the workshop cards. Each check here asks the browser what is on top
// (`document.elementFromPoint`) at a control's centre and inside its edges, at 390 × 844 (iPhone 13) and
// 412 × 915 (Pixel 7), with touch:
//  - W5-06: the toolbar, the quick actions, Zoom to fit, the board menu, the fold button and Board actions,
//    for an owner and for a viewer; a person who picked Hand gets Select back with one tap; the board menu
//    opens by tap and every entry of it can be tapped. (Wave 3b moved Zoom to fit and the board menu: 2C's
//    corner chrome and 3a's quick-actions strip; these keep them there.)
//  - W5-07: while a workshop card is up (the brainstorm prompt, the vote join card, the voting bar, the
//    results card) or a comment sheet is docked at the bottom, Board actions steps aside: no point of the card
//    or of the comment's text box is under it. (The comment sheet against the tool dock is 3c's part,
//    comments-stacking.spec.ts; the cards' own place is 3f's.)
//  - W5-31 and W5-50 (the top bar's fit rules, CR-3I-2 and CR-3I-3): at 390 px (and 320, 360, 402 and 412) every
//    top-bar control is wholly on screen (Share was 7 px past the edge at 390), and the "⋯" menu shows no
//    caption with nothing under it ("On this board" was empty while the people feature has its own chip).
import type { Page } from '@playwright/test'
import { expect, test } from '../tests/support/canvas.ts'
import {
  coveredAcross,
  coveredControls,
  frame,
  lobbyTool,
  note,
  openPhoneSession,
  PHONE,
  PIXEL_7,
} from './a11y-kit.ts'

/** The board page's phone chrome: tools, quick actions, navigation, board menu, Board actions, the fold button. */
const PHONE_CHROME = [
  '[data-lobby-slot="toolbar"]',
  '[data-lobby-slot="navigation"]',
  '[data-lobby-slot="mainMenu"]',
  '[data-lobby-slot="phoneSheet"]',
  '[data-testid="dock-rail-toggle"]',
]

const boardActions = (page: Page) => page.getByTestId('phone-sheet-open')

for (const size of [PHONE, PIXEL_7]) {
  test(`W5-06: at ${size.width} × ${size.height} every tool, Zoom to fit, the board menu and Board actions can be tapped; Select is one tap back from Hand`, async ({
    browser,
    board,
    users,
  }, testInfo) => {
    const a = await openPhoneSession(browser, board, users, 'alice', 'owner', size)
    try {
      const page = a.page
      await note(page, 0, 0, 'Reach me')
      await expect(page.getByTestId('tools.select')).toBeVisible()
      await expect(page.getByTestId('navigation.zoom-to-fit')).toBeVisible()
      await expect(page.getByTestId('main-menu.button')).toBeVisible()
      await expect(boardActions(page)).toBeVisible()
      // the canvas follows the window a moment after the first paint
      await expect
        .poll(() => coveredControls(page, PHONE_CHROME), { message: 'phone controls under other chrome' })
        .toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`phone-reach-${size.width}.png`) })

      await test.step('a participant who picked Hand taps Select and has it (W5-06: Zoom to fit sat on Select)', async () => {
        await page.getByTestId('tools.hand').tap()
        await expect.poll(() => lobbyTool(page)).toBe('hand')
        await page.getByTestId('tools.select').tap()
        await expect.poll(() => lobbyTool(page)).toBe('select')
      })

      await test.step('the board menu opens by tap, and Board, Edit, Export, Preferences and Send feedback can be tapped (no Keyboard shortcuts row: a phone has no keyboard)', async () => {
        await page.getByTestId('main-menu.button').tap()
        await expect(page.getByTestId('main-menu.button')).toHaveAttribute('aria-expanded', 'true')
        const menu = page.getByTestId('main-menu-root')
        await expect(menu).toBeVisible()
        const entries = await menu.getByRole('menuitem').allTextContents()
        for (const want of [/Board/, /Edit/, /Export/, /Preferences/, /Send feedback/])
          expect(
            entries.some((t) => want.test(t)),
            `${want} in ${JSON.stringify(entries)}`,
          ).toBe(true)
        // P-027: desktop-only rows stay off a phone's menu
        expect(entries.some((t) => /Keyboard shortcuts/.test(t))).toBe(false)
        expect(await coveredControls(page, ['[data-testid="main-menu-root"]'])).toEqual([])
        await page.keyboard.press('Escape')
      })
    } finally {
      await a.context.close()
    }
  })
}

test('W5-06: a viewer on a phone can tap every control it has, Hand included', async ({
  browser,
  board,
  users,
}) => {
  const v = await openPhoneSession(browser, board, users, 'carol', 'viewer')
  try {
    await expect(v.page.getByTestId('tools.select')).toBeVisible()
    await expect(v.page.getByTestId('tools.hand')).toBeVisible()
    await expect.poll(() => coveredControls(v.page, PHONE_CHROME)).toEqual([])
    await v.page.getByTestId('tools.hand').tap()
    await expect.poll(() => lobbyTool(v.page)).toBe('hand')
    await v.page.getByTestId('tools.select').tap()
    await expect.poll(() => lobbyTool(v.page)).toBe('select')
  } finally {
    await v.context.close()
  }
})

test('W5-07: Board actions steps aside while a workshop card is up: the brainstorm prompt, the vote join card, the voting bar and the results card can be tapped everywhere', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const alice = await users.api('alice')
  const ok = async (path: string, body: unknown, status = 200) => {
    const r = await alice.fetch('POST', path, body)
    expect(r.status(), await r.text()).toBe(status)
    return r
  }
  const b = await openPhoneSession(browser, board, users, 'bob', 'editor')
  try {
    const page = b.page
    const ideas = await frame(page, 0, 0, 900, 600, 'Ideas')
    await note(page, 1100, 0, 'Vote for me')
    await expect(boardActions(page)).toBeVisible()

    await test.step('the private-brainstorm prompt', async () => {
      await ok(
        `/api/boards/${board}/private-brainstorm`,
        {
          prompt: 'What slowed us down?',
          anonymous: false,
          target: { frameId: `shape:${ideas}`, pageId: 'page:page', x: 0, y: 0, w: 900, h: 600 },
        },
        201,
      )
      await expect(page.getByTestId('pn-start-prompt')).toBeVisible()
      await expect.poll(() => coveredAcross(page, 'pn-start-prompt')).toEqual([])
      await expect(boardActions(page)).toBeHidden()
      expect(await coveredControls(page, ['[data-testid="pn-start-prompt"]'])).toEqual([])
      await page.screenshot({ path: testInfo.outputPath('reach-pn-prompt.png') })
      const s = (await (await alice.fetch('GET', `/api/boards/${board}/private-brainstorm`)).json()) as {
        session: { id: string }
      }
      await ok(`/api/private-brainstorms/${s.session.id}/cancel`, {})
      await expect(page.getByTestId('pn-start-prompt')).toHaveCount(0)
    })

    let vote = ''
    await test.step('the vote join card and the voting bar (I’m done, Details)', async () => {
      const started = await ok(
        `/api/boards/${board}/votes`,
        { votesPerPerson: 3, onePerObject: false, scope: 'board' },
        201,
      )
      vote = ((await started.json()) as { session: { id: string } }).session.id
      await expect(page.getByTestId('vote-join-prompt')).toBeVisible()
      await expect.poll(() => coveredAcross(page, 'vote-join-prompt')).toEqual([])
      expect(await coveredControls(page, ['[data-testid="vote-join-prompt"]'])).toEqual([])
      await page.getByTestId('vote-join').tap()
      const bar = page.getByTestId('vote-bar')
      await expect(bar).toBeVisible()
      await expect.poll(() => coveredAcross(page, 'vote-bar')).toEqual([])
      expect(await coveredControls(page, ['[data-testid="vote-bar"]'])).toEqual([])
      await expect(boardActions(page)).toBeHidden()
      await page.screenshot({ path: testInfo.outputPath('reach-vote-bar.png') })
    })

    await test.step('the results card', async () => {
      await ok(`/api/votes/${vote}/reveal`, {})
      const card = page.getByTestId('vote-results-card')
      await expect(card).toBeVisible()
      await expect.poll(() => coveredAcross(page, 'vote-results-card')).toEqual([])
      expect(await coveredControls(page, ['[data-testid="vote-results-card"]'])).toEqual([])
      await page.screenshot({ path: testInfo.outputPath('reach-results.png') })
      // dismissing the card gives Board actions back
      await card.getByRole('button', { name: 'Dismiss the results' }).tap()
      await expect(card).toHaveCount(0)
      await expect(boardActions(page)).toBeVisible()
      expect(await coveredControls(page, PHONE_CHROME)).toEqual([])
    })
  } finally {
    await b.context.close()
  }
})

test('W5-07: Board actions is never on the docked comment sheet (new comment and reply)', async ({
  browser,
  board,
  users,
}) => {
  const b = await openPhoneSession(browser, board, users, 'bob', 'editor')
  try {
    const page = b.page
    await note(page, 0, 0, 'Comment on me')
    await expect(boardActions(page)).toBeVisible()
    // the comment tool (in the top bar's overflow menu on phones since K2-5), then a tap on the board below
    // that open menu: the new-comment sheet docks at the bottom
    await page.getByTestId('topbar-overflow').tap()
    await page.getByTestId('comment-tool').tap()
    const c = await page.locator('[data-lobby-board-canvas]').boundingBox()
    if (!c) throw new Error('no canvas')
    await page.touchscreen.tap(c.x + c.width / 2, c.y + c.height * 0.75)
    const popover = page.getByTestId('new-comment-popover')
    await expect(popover).toHaveAttribute('data-docked', 'true')
    await expect(boardActions(page)).toBeHidden()
    const under = async () =>
      (await coveredAcross(page, 'new-comment-popover')).filter((p) => p.includes('phone-sheet'))
    expect(await under()).toEqual([])
    const composer = popover.getByTestId('comment-composer')
    await composer.fill('A phone comment')
    await composer.press('Enter')
    await expect(popover).toHaveCount(0)
    await expect(page.getByTestId('thread-popover')).toHaveAttribute('data-docked', 'true')
    expect((await coveredAcross(page, 'thread-popover')).filter((p) => p.includes('phone-sheet'))).toEqual([])
    await expect(boardActions(page)).toBeHidden()
    // closing the thread gives Board actions back
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('thread-popover')).toHaveCount(0)
    await expect(boardActions(page)).toBeVisible()
  } finally {
    await b.context.close()
  }
})

// ---- the top bar on a phone (W5-31, W5-50): board/TopBarFrame.tsx (shared by both pages, once), the phone fit
// rules in styles.css and the Excalidraw page's pinned items (CR-3I-2, CR-3I-3) ------------------------------

for (const [size, role] of [
  [PHONE, 'owner'],
  [PHONE, 'viewer'],
  [PIXEL_7, 'owner'],
  [{ width: 402, height: 874 }, 'owner'], // iPhone 16 Pro
  [{ width: 360, height: 740 }, 'owner'],
  [{ width: 320, height: 640 }, 'owner'],
] as const) {
  test(`W5-31: at ${size.width} px the top bar fits the screen for ${role === 'owner' ? 'an owner' : 'a viewer'}: Share and every other control are wholly on it`, async ({
    browser,
    board,
    users,
  }) => {
    const a = await openPhoneSession(browser, board, users, role === 'owner' ? 'alice' : 'bob', role, size)
    try {
      const page = a.page
      await expect(page.getByTestId('share-button')).toBeVisible()
      const off = async () =>
        page.locator('header.dr-topbar').evaluate((bar) =>
          [...bar.querySelectorAll('button, a[href]')].flatMap((el) => {
            const r = el.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) return []
            if (r.left >= -0.5 && r.right <= innerWidth + 0.5) return []
            return [
              `${el.getAttribute('data-testid') ?? el.textContent?.trim()} ${Math.round(r.left)}..${Math.round(r.right)}`,
            ]
          }),
        )
      // the people chip and the bell arrive a moment after the first paint
      await expect(page.getByTestId('topbar').locator('.dr-people')).toBeVisible()
      await expect.poll(off, { message: 'top-bar controls past the screen edge' }).toEqual([])
      expect(await coveredControls(page, ['header.dr-topbar'])).toEqual([])
      // every control is still a tappable target (WCAG 2.5.8: 24 px)
      const small = await page.locator('header.dr-topbar').evaluate((bar) =>
        [...bar.querySelectorAll('button, a[href]')].flatMap((el) => {
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0 || (r.width >= 24 && r.height >= 24)) return []
          return [
            `${el.getAttribute('data-testid') ?? el.textContent?.trim()} ${Math.round(r.width)}x${Math.round(r.height)}`,
          ]
        }),
      )
      expect(small, 'top-bar controls under 24 px').toEqual([])
    } finally {
      await a.context.close()
    }
  })
}

test('W5-50: on a phone the "⋯" menu has no empty "On this board" row', async ({ browser, board, users }) => {
  const a = await openPhoneSession(browser, board, users, 'alice', 'owner')
  try {
    const page = a.page
    await page.getByTestId('topbar-overflow').tap()
    const panel = page.getByTestId('topbar-overflow-panel')
    await expect(panel).toHaveAttribute('data-open', 'true')
    const rows = await panel.locator('.dr-overflow__item').evaluateAll((els) =>
      els.map((el) => {
        const caption = el.querySelector('.dr-overflow__caption')?.textContent?.trim() ?? ''
        const rest = [...el.children].filter((c) => !c.classList.contains('dr-overflow__caption'))
        const shown = rest.some((c) => c.getBoundingClientRect().height > 0)
        return { caption, shown }
      }),
    )
    const empty = rows.filter((r) => r.caption && !r.shown).map((r) => r.caption)
    expect(empty, 'captions with nothing under them').toEqual([])
    // the people feature draws its own chip in the bar, so the menu has no people row at all (and it is
    // not vacuous: the account row is there, with its caption)
    await expect(panel.locator('[data-feature="people"]')).toHaveCount(0)
    expect(rows.filter((r) => r.caption === 'Your account' && r.shown)).toHaveLength(1)
  } finally {
    await a.context.close()
  }
})
