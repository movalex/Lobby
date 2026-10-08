// K3-5 (wave K): livelier moments that stay ephemeral. While one person presented, the others saw no sign of
// it; reactions were a single emoji; vote dots were small dark circles. Now a Present (by someone who may
// present to everyone, with others on the board) gives everyone a "<name> is presenting · Follow" toast, and
// Follow follows; dismissing it writes nothing. A reaction bursts into staggered copies (one still copy with
// reduced motion); my vote dots wear my presence colour; a reveal drops confetti (an overlay; none with
// reduced motion). The rules are unit-tested (live-moments.test.ts, live/ported/controller.test.ts).
import type { Page } from '@playwright/test'
import { react } from '../tests/support/workshops-2.ts'
import { pushCount } from './board-kit.ts'
import {
  clickElement,
  dot,
  expect,
  expectItemsEverywhere,
  post,
  seed,
  showAll,
  test,
} from './workshops-kit.ts'

const toast = (page: Page) => page.getByTestId('live-invite')

test('K3-5: alice presents: bob and carol get "Alice is presenting · Follow" at once; Follow follows; Not now writes nothing', async ({
  join,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  await seed(a.page, {
    frames: [
      { id: 'k3l-one', x: 0, y: 0, w: 800, h: 450, name: 'Welcome' },
      { id: 'k3l-two', x: 1000, y: 0, w: 800, h: 450, name: 'Plan' },
    ],
  })
  await expectItemsEverywhere([b, c], ['k3l-one', 'k3l-two'])
  const first = a.name.split(' ')[0] as string

  const startedAt = Date.now()
  await a.page.getByTestId('present-button').click()
  await expect(a.page.getByTestId('present-overlay')).toBeVisible()

  await test.step('the toast, for bob and carol, within the event stream’s latency; alice presents to everyone', async () => {
    for (const s of [b, c]) {
      await expect(toast(s.page)).toContainText(`${a.name} is presenting`, { timeout: 5_000 })
      await expect(toast(s.page).getByTestId('live-join')).toHaveText('Follow')
    }
    const after = Date.now() - startedAt
    testInfo.annotations.push({ type: 'toast latency', description: `${after} ms` })
    expect(after).toBeLessThan(5_000)
    await expect(a.page.getByTestId('live-presenting')).toBeVisible()
    // non-blocking: bob's board still takes clicks around it (the canvas, the toolbar)
    await expect(b.page.getByTestId('present-overlay')).toHaveCount(0)
    await expect(b.page.getByTestId('tools.select')).toBeEnabled()
    await b.page.screenshot({ path: testInfo.outputPath('k3-presenting-toast.png') })
  })

  await test.step('carol: Not now puts it away, and writes nothing to the board', async () => {
    const before = await pushCount(c.page)
    await toast(c.page).getByTestId('live-not-now').click()
    await expect(toast(c.page)).toHaveCount(0)
    await c.page.waitForTimeout(1_000)
    expect(await pushCount(c.page)).toBe(before)
  })

  await test.step('bob: Follow follows alice’s slides', async () => {
    const before = await pushCount(b.page)
    await toast(b.page).getByTestId('live-join').click()
    await expect(b.page.getByTestId('present-overlay')).toBeVisible()
    await expect(b.page.getByTestId('live-following')).toContainText(`Following ${first}`)
    await a.page.keyboard.press('ArrowRight')
    await expect(b.page.getByTestId('present-counter')).toHaveText('2 / 2')
    expect(await pushCount(b.page)).toBe(before) // following is not a board write either
  })

  await a.page.keyboard.press('Escape')
  await expect(b.page.getByTestId('present-overlay')).toHaveCount(0)
})

test('K3-5: a reaction bursts into staggered copies (one still copy with reduced motion)', async ({
  join,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  await c.page.emulateMedia({ reducedMotion: 'reduce' })
  await react(a.page, '🎉')
  const burst = (p: Page) =>
    p.locator(`[data-testid="reaction-burst"][data-user-id="${a.id}"][data-emoji="🎉"]`)
  for (const p of [a.page, b.page]) {
    await expect(burst(p)).toHaveCount(1)
    await expect(burst(p).locator('.dr-wk-burst__emoji')).toHaveCount(5)
  }
  await expect(burst(c.page)).toHaveCount(1)
  await expect(burst(c.page).locator('.dr-wk-burst__emoji')).toHaveCount(1)
  // staggered: the copies start one after the other
  const delays = await burst(b.page)
    .locator('.dr-wk-burst__emoji[data-copy="spark"]')
    .evaluateAll((els) => els.map((e) => getComputedStyle(e).animationDelay))
  expect(delays).toEqual(['0.11s', '0.22s', '0.33s', '0.44s'])
})

test('K3-5: my vote dots wear my presence colour, readable; a reveal drops confetti (an overlay, none with reduced motion)', async ({
  join,
  board,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  await c.page.emulateMedia({ reducedMotion: 'reduce' })
  await seed(a.page, { notes: [{ id: 'k3l-n', x: 0, y: 0, text: 'Weekly demo' }] })
  await expectItemsEverywhere([b, c], ['k3l-n'])
  await showAll(b.page)
  const r = await post(a, `/api/boards/${board}/votes`, {
    votesPerPerson: 2,
    onePerObject: false,
    scope: 'board',
  })
  expect(r.status(), await r.text()).toBe(201)
  const sid = ((await r.json()) as { session: { id: string } }).session.id

  await test.step('bob votes: his dot is his colour, its figure readable on it', async () => {
    await b.page.getByTestId('vote-join-prompt').getByTestId('vote-join').click()
    await clickElement(b.page, 'k3l-n')
    const d = dot(b.page, 'k3l-n')
    await expect(d).toHaveAttribute('data-count', '1')
    const me = (await (await b.api.fetch('GET', '/api/auth/me')).json()) as { user: { color: string } }
    const look = await d.evaluate((el) => {
      const s = getComputedStyle(el)
      return { bg: s.backgroundColor, ink: s.color }
    })
    const hex = (rgb: string) =>
      `#${(rgb.match(/\d+/g) ?? [])
        .slice(0, 3)
        .map((n) => Number(n).toString(16).padStart(2, '0'))
        .join('')}`
    expect(hex(look.bg)).toBe(me.user.color.toLowerCase())
    const lum = (h: string) => {
      const ch = (i: number) => {
        const v = Number.parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2)
    }
    const [x, y] = [lum(hex(look.bg)), lum(hex(look.ink))]
    const ratio = (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
    testInfo.annotations.push({
      type: 'dot',
      description: `${hex(look.ink)} on ${hex(look.bg)} ${ratio.toFixed(2)}:1`,
    })
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  await test.step('alice reveals: confetti for bob (an overlay, no pointer, no write), none for carol', async () => {
    const before = await pushCount(b.page)
    expect((await post(a, `/api/votes/${sid}/reveal`)).status()).toBe(200)
    const confetti = b.page.getByTestId('vote-confetti')
    await expect(confetti).toBeVisible()
    await expect(confetti).toHaveCSS('pointer-events', 'none')
    await b.page.screenshot({ path: testInfo.outputPath('k3-reveal-confetti.png') })
    await expect(c.page.getByTestId('vote-results-card')).toBeVisible()
    await expect(c.page.getByTestId('vote-confetti')).toHaveCount(0)
    await expect(confetti).toHaveCount(0, { timeout: 5_000 }) // it falls and is gone
    expect(await pushCount(b.page)).toBe(before)
  })
})
