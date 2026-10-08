// Wave K (K4-4): "Nothing has been shared with you yet" and "You're not in a workspace yet" on a phone. A phone
// visitor signed in four times and out twice in four minutes without reaching a board, so both screens say
// which address is signed in, what to do, and can be used with a thumb: no sideways scroll at 375 x 812, every
// action reachable (the card scrolls when it is taller than the window), "Copy my address" puts the address on
// the clipboard (and, when the browser refuses, says to select it and press Ctrl+C), and nothing is sent to
// anybody. Who is a creator is the server's, unchanged: domain-access.spec.ts still pins the fail-closed rule.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw k4-screens
import type { Page } from '@playwright/test'
import { expect, test } from '../tests/support/canvas.ts'
import { freshHandle, signedInContext } from '../tests/support/dashboard-share.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { capture } from '../tests/support/screenshots.ts'
import { noHorizontalScroll } from './guests-kit.ts'

const PHONE = { width: 375, height: 812 }
const OUTSIDER = 'client@client.example.test'

/** Every action of the screen is on screen once scrolled to, and big enough for a thumb. */
async function expectActionsReachable(page: Page) {
  for (const id of ['no-workspace-switch', 'no-workspace-copy']) {
    const button = page.getByTestId(id)
    await button.scrollIntoViewIfNeeded()
    await expect(button, id).toBeInViewport({ ratio: 1 })
    const box = await button.boundingBox()
    expect(box?.height ?? 0, `${id} height`).toBeGreaterThanOrEqual(40)
    expect(box?.width ?? 0, `${id} width`).toBeGreaterThanOrEqual(200)
  }
}

test('Nothing shared yet, on a phone: the address, the work domains, no sideways scroll, every action reachable, and Copy my address', async ({
  browser,
}, testInfo) => {
  const p = await signedInContext(browser, freshHandle('k4s'), {
    name: 'Casey Client',
    email: OUTSIDER,
    viewport: PHONE,
  })
  try {
    await p.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
    await p.page.goto('/')
    const screen = p.page.getByTestId('no-workspace')
    await expect(screen).toHaveAttribute('data-reason', 'outside')
    await expect(screen.getByRole('heading')).toHaveText('Nothing has been shared with you yet')

    await test.step('which address is signed in, prominently, and which addresses are work addresses', async () => {
      await expect(screen.getByTestId('no-workspace-account')).toHaveText(`You're signed in as ${OUTSIDER}.`)
      const email = screen.getByTestId('no-workspace-email')
      await expect(email).toHaveText(OUTSIDER)
      expect(await email.evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16)
      await expect(screen).toContainText(
        /Work addresses end in @\S+ or @\S+ or @\S+|Work addresses end in @\S+, @\S+ or @\S+/,
      )
      await expect(screen).toContainText('open the invite link they send you')
      await capture('k4-nothing-shared-phone.png', p.page, testInfo)
    })

    await test.step('no sideways scroll; both actions reachable and thumb-sized', async () => {
      expect(await noHorizontalScroll(p.page)).toBe(true)
      await expectActionsReachable(p.page)
      expect(await noHorizontalScroll(p.page)).toBe(true)
    })

    await test.step('Copy my address: the address is on the clipboard, and nothing is sent anywhere', async () => {
      const requests: string[] = []
      p.page.on('request', (r) => requests.push(`${r.method()} ${r.url()}`))
      await p.page.getByTestId('no-workspace-copy').click()
      await expect(p.page.getByTestId('no-workspace-copied')).toBeVisible()
      expect(await p.page.evaluate(() => navigator.clipboard.readText())).toBe(OUTSIDER)
      await p.page.waitForTimeout(300)
      expect(requests).toEqual([])
      await expect(p.page.locator('a[href^="mailto:"]')).toHaveCount(0)
    })
  } finally {
    await p.context.close()
  }
})

test('when the browser will not copy: the address is selected and the screen says to press Ctrl+C', async ({
  browser,
}) => {
  const p = await signedInContext(browser, freshHandle('k4c'), {
    name: 'Casey Client',
    email: OUTSIDER,
    viewport: PHONE,
  })
  try {
    // a clipboard that refuses (no permission, an insecure context, no focus)
    await p.context.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
      })
    })
    await p.page.goto('/')
    await p.page.getByTestId('no-workspace-copy').scrollIntoViewIfNeeded()
    await p.page.getByTestId('no-workspace-copy').click()
    const hint = p.page.getByTestId('no-workspace-copy-fallback')
    await expect(hint).toHaveText('Select the address and press Ctrl+C')
    await expect(p.page.getByTestId('no-workspace-copied')).toHaveCount(0)
    expect(await p.page.evaluate(() => getSelection()?.toString() ?? '')).toBe(OUTSIDER)
  } finally {
    await p.context.close()
  }
})

test('Switch account signs out and goes to the sign-in page', async ({ browser }) => {
  const p = await signedInContext(browser, freshHandle('k4w'), {
    name: 'Casey Client',
    email: OUTSIDER,
    viewport: PHONE,
  })
  try {
    await p.page.goto('/')
    await p.page.getByTestId('no-workspace-switch').click()
    await expect(p.page).toHaveURL(/\/signin/)
  } finally {
    await p.context.close()
  }
})

test('You’re not in a workspace yet, on a phone: the same address, way out and layout', async ({
  browser,
}, testInfo) => {
  const p = await signedInContext(browser, freshHandle('k4n'), {
    name: 'Sam Creator',
    email: 'lobby-test-k4n@darkburn.com',
    viewport: PHONE,
  })
  try {
    await p.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
    // a creator whose workspaces are gone (the screen exists for an account that belongs to none)
    for (const url of ['**/api/auth/me', '**/api/me'])
      await p.page.route(url, async (route) => {
        const res = await route.fetch()
        if (res.status() !== 200) return route.fulfill({ response: res })
        const body = (await res.json()) as Record<string, unknown>
        return route.fulfill({ response: res, json: { ...body, workspaces: [] } })
      })
    await p.page.goto('/')
    const screen = p.page.getByTestId('no-workspace')
    await expect(screen).toHaveAttribute('data-reason', 'none')
    await expect(screen.getByRole('heading')).toHaveText("You're not in a workspace yet")
    await expect(screen.getByTestId('no-workspace-account')).toHaveText(
      "You're signed in as lobby-test-k4n@darkburn.com.",
    )
    expect(await noHorizontalScroll(p.page)).toBe(true)
    await expectActionsReachable(p.page)
    await capture('k4-not-in-workspace-phone.png', p.page, testInfo)
    await p.page.getByTestId('no-workspace-copy').click()
    await expect(p.page.getByTestId('no-workspace-copied')).toBeVisible()
    expect(await p.page.evaluate(() => navigator.clipboard.readText())).toBe('lobby-test-k4n@darkburn.com')
  } finally {
    await p.context.close()
  }
})
