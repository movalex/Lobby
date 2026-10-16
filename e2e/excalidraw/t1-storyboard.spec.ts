// Wave T, WS2 (docs/WAVE-T-CONTRACTS.md §1, §4): storyboards on the Excalidraw board page, with the storyboard
// switches on (localStorage, a dev-auth build only: features/planning/flags.ts PLANNING_FLAG_KEYS) and the sync's
// planning switch on (DRAFTROOM_PLANNING=on: the room says 14 and takes the planning keys under WS1's rules).
//
//   1. An owner makes a storyboard from the context menu; an editor's second tab and a viewer see the same shot
//      numbers live; a reorder from the strip (button, drag, Alt+arrow), an insert from the "+" handle and a delete
//      renumber on every tab; Ctrl+Z undoes the delete; tabs that only receive push nothing; the server holds the
//      keys; a viewer has the strip with no write controls. Nothing leaves Lobby's origins.
//   2. Script to boards: an AV script, a screenplay and a shot list each detected and parsed into panels; the shot
//      list made into a storyboard whose fields hold the words, one undo step.
//   3. Break down with AI with the fake model: the notice, the panels back in the preview, the storyboard made with
//      provenance on its panels.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/t1-storyboard.spec.ts --project=chromium --workers=1
import type { Browser, Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import { signInContext } from '../tests/support/api.ts'
import {
  test as base,
  type CanvasElement,
  canvasCall,
  expect,
  expectSaved,
  items,
  pushedOps,
  setViewport,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { pressUndo, storedElement } from '../tests/support/excalidraw.ts'
import type { TestUser } from '../tests/support/users.ts'
import { AI_API_ENV_3H, continueIfAsked, FAKE_OPENAI_PORT_3H } from './ai-kit.ts'
import { emptyCanvasPoint } from './board-kit.ts'
import { foreignRequests } from './r3-chat-kit.ts'

/** features/planning/flags.ts PLANNING_FLAG_KEYS.storyboard and .storyboardAi */
const FLAGS = ['lobby.planStoryboard', 'lobby.planStoryboardAi']

const test = base.extend<object, { openai: FakeOpenAi }>({
  openai: [
    async ({ stack: _ }, use) => {
      const fake = await startFakeOpenAi(FAKE_OPENAI_PORT_3H)
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

test.use({
  viewport: { width: 1440, height: 900 },
  syncEnv: { DRAFTROOM_PLANNING: 'on' },
  apiEnv: AI_API_ENV_3H,
})
test.describe.configure({ mode: 'serial' })

interface Tab {
  readonly page: Page
  readonly id: string
  readonly close: () => Promise<void>
}

async function openTab(browser: Browser, board: string, user: TestUser): Promise<Tab> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript((keys) => {
    try {
      for (const k of keys) localStorage.setItem(k, '1')
    } catch {
      // a blocked store: the switches stay off and the spec fails on the missing UI
    }
  }, FLAGS)
  await signInContext(context, user.handle, user.name)
  const page = await context.newPage()
  await page.goto(`/b/${board}`)
  await waitForCanvas(page)
  return { page, id: user.id, close: () => context.close() }
}

const lobbyOf = (e: CanvasElement | null | undefined) =>
  ((e as { customData?: { lobby?: Record<string, unknown> } } | null | undefined)?.customData?.lobby ??
    {}) as Record<string, unknown>

/** The chips' shot numbers on a tab: panel id → shot. */
async function shots(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const out: Record<string, number> = {}
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="sb-chip"]'))
      out[el.dataset.panelId ?? ''] = Number(el.dataset.shot)
    return out
  })
}

/** The strip's panel ids in order. */
const stripOrder = (page: Page): Promise<string[]> =>
  page
    .getByTestId('sb-strip-card')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.panelId ?? ''))

/** Opens the context menu on empty canvas and picks `name`. */
async function contextMenuItem(page: Page, name: string | RegExp) {
  await canvasCall(page, 'select', [])
  const p = await emptyCanvasPoint(page)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await expect(page.getByTestId('context-menu-root')).toBeVisible()
  await page.getByRole('menuitem', { name }).click()
}

const panelsOf = async (page: Page, head: string) =>
  (await items(page)).filter((e) => e.type === 'frame' && lobbyOf(e)['sb:of'] === head)

test('a storyboard: live numbering on a second tab and a viewer, reorder (button, drag, keys), insert, delete, undo', async ({
  browser,
  board,
  users,
  stack,
}) => {
  test.setTimeout(180_000)
  const alice = await openTab(browser, board, await users.get('alice'))
  const bob = await openTab(browser, board, await users.grant(board, 'bob', 'editor'))
  const vic = await openTab(browser, board, await users.grant(board, 'vic', 'viewer'))
  const foreign = [alice, bob, vic].map((t) => foreignRequests(t.page))
  try {
    for (const t of [alice, bob, vic]) await setViewport(t.page, { x: -200, y: -300, zoom: 0.5 })
    // New storyboard… from the context menu: 4 panels, 16:9
    await contextMenuItem(alice.page, 'New storyboard…')
    const dialog = alice.page.getByTestId('sb-new-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('sb-new-title').fill('Coffee spot')
    await dialog.getByTestId('sb-new-count').fill('4')
    await dialog.getByTestId('sb-new-create').click()
    await expect(dialog).toHaveCount(0)
    await expectSaved(alice.page)
    const strip = alice.page.getByTestId('sb-strip')
    await expect(strip).toBeVisible()
    await expect(strip.getByTestId('sb-strip-title')).toHaveText('Coffee spot')
    await expect(alice.page.getByTestId('sb-strip-card')).toHaveCount(4)
    const head = (await strip.getAttribute('data-storyboard-id')) as string
    const order0 = await stripOrder(alice.page)

    // every tab: the same numbers (derived from sb:pos), live
    const expected = (order: string[]) => Object.fromEntries(order.map((id, i) => [id, i + 1]))
    for (const t of [alice, bob, vic]) await expect.poll(() => shots(t.page)).toEqual(expected(order0))
    await expect(alice.page.getByTestId('sb-head-meta')).toContainText('4 panels · 0:08 · 16:9')
    // the server holds the keys
    const stored = await storedElement(stack, board, order0[0] as string)
    expect(lobbyOf(stored)).toMatchObject({ 'sb:of': head, 'sb:dur': 2000 })
    expect(typeof lobbyOf(stored)['sb:pos']).toBe('string')

    // the receivers push nothing from here on
    const bobPushes = (await pushedOps(bob.page)).length
    const vicPushes = (await pushedOps(vic.page)).length

    // reorder with the strip's button: shot 1 moves right
    await alice.page.getByTestId('sb-strip-card').first().click()
    await alice.page.getByTestId('sb-move-right').click()
    const order1 = [order0[1], order0[0], order0[2], order0[3]] as string[]
    await expect.poll(() => stripOrder(alice.page)).toEqual(order1)
    await expectSaved(alice.page)
    for (const t of [alice, bob, vic]) await expect.poll(() => shots(t.page)).toEqual(expected(order1))

    // drag the last card to the front
    const cards = alice.page.getByTestId('sb-strip-card')
    const last = await cards.nth(3).boundingBox()
    const first = await cards.nth(0).boundingBox()
    if (!last || !first) throw new Error('no cards')
    await alice.page.mouse.move(last.x + last.width / 2, last.y + 30)
    await alice.page.mouse.down()
    await alice.page.mouse.move(last.x - 40, last.y + 30, { steps: 4 })
    await alice.page.mouse.move(first.x + 10, first.y + 30, { steps: 8 })
    await alice.page.mouse.up()
    const order2 = [order1[3], order1[0], order1[1], order1[2]] as string[]
    await expect.poll(() => stripOrder(alice.page)).toEqual(order2)
    await expectSaved(alice.page)
    for (const t of [bob, vic]) await expect.poll(() => shots(t.page)).toEqual(expected(order2))

    // the keyboard: Alt+Right on the focused first card moves it one place
    await cards.nth(0).focus()
    await alice.page.keyboard.press('Alt+ArrowRight')
    const order3 = [order2[1], order2[0], order2[2], order2[3]] as string[]
    await expect.poll(() => stripOrder(alice.page)).toEqual(order3)
    await expectSaved(alice.page)
    for (const t of [bob, vic]) await expect.poll(() => shots(t.page)).toEqual(expected(order3))

    // insert after the selected panel from its "+" handle on the canvas
    await canvasCall(alice.page, 'select', [order3[1] as string])
    await alice.page.getByTestId('sb-insert-after').click()
    await expect(alice.page.getByTestId('sb-strip-card')).toHaveCount(5)
    await expectSaved(alice.page)
    const order4 = await stripOrder(alice.page)
    expect(order4.filter((id) => !order3.includes(id))).toHaveLength(1)
    expect(order4.indexOf(order4.find((id) => !order3.includes(id)) as string)).toBe(2)
    for (const t of [bob, vic]) await expect.poll(() => shots(t.page)).toEqual(expected(order4))

    // delete the selected (new) panel from the strip; numbers close up everywhere
    await alice.page.getByTestId('sb-delete').click()
    await expect(alice.page.getByTestId('sb-strip-card')).toHaveCount(4)
    await expectSaved(alice.page)
    for (const t of [bob, vic]) await expect.poll(() => shots(t.page)).toEqual(expected(order3))
    expect(await panelsOf(bob.page, head)).toHaveLength(4)

    // Ctrl+Z brings it back (one step: the frame with all it held), on every tab
    await pressUndo(alice.page)
    await expect.poll(async () => (await panelsOf(alice.page, head)).length).toBe(5)
    await expectSaved(alice.page)
    for (const t of [bob, vic]) await expect.poll(() => shots(t.page)).toEqual(expected(order4))

    // the tabs that only received pushed nothing
    expect((await pushedOps(bob.page)).length).toBe(bobPushes)
    expect((await pushedOps(vic.page)).length).toBe(vicPushes)

    // the viewer: the strip with no write controls, no "+" handles, no create entries
    await canvasCall(vic.page, 'select', [order4[0] as string])
    await expect(vic.page.getByTestId('sb-strip')).toBeVisible()
    await expect(vic.page.getByTestId('sb-add')).toHaveCount(0)
    await expect(vic.page.getByTestId('sb-actions')).toHaveCount(0)
    await expect(vic.page.getByTestId('sb-insert-after')).toHaveCount(0)
    await expect(vic.page.getByTestId('sb-duration').first()).toHaveAttribute('readonly', '')

    // bob (an editor) sets a duration by typing frames: 36f at 24 fps = 1.5 s; alice sees it
    await canvasCall(bob.page, 'select', [order4[0] as string])
    const dur = bob.page.getByTestId('sb-duration').first()
    await dur.click()
    await dur.fill('36f')
    await dur.press('Enter')
    await expectSaved(bob.page)
    await expect
      .poll(async () => lobbyOf(await canvasCall(alice.page, 'get', order4[0] as string))['sb:dur'])
      .toBe(1500)
    await alice.page.screenshot({ path: test.info().outputPath('storyboard-owner.png') })
    for (const f of foreign) expect(f).toEqual([])
  } finally {
    for (const t of [alice, bob, vic]) await t.close()
  }
})

const AV = [
  'VIDEO\tAUDIO',
  'WIDE - A city wakes up at dawn. (3s)\tMUSIC: soft piano',
  'CU - Hands pour coffee into a mug.\tVO: Every day starts with a choice.',
  'Logo on white. 0:02\tVO: Lobby. Plan it together.',
].join('\n')
const SCREENPLAY = [
  'INT. KITCHEN - DAY',
  '',
  'Ana pours coffee.',
  '',
  'ANA',
  'Morning.',
  '',
  'BEN (O.S.)',
  "You're up early.",
  '',
  'EXT. STREET - NIGHT',
  '',
  'A bus passes in the rain.',
].join('\n')
const SHOTS = [
  '1. WIDE - Kitchen at dawn, steam rising. (3s)',
  '2. CU - hands on the mug. VO: Every day starts here.',
  '3. OTS on Ana looking out. SFX: birds',
  '4. Logo on white, 2s',
].join('\n')

test('Script to boards: an AV script, a screenplay and a shot list; the shot list becomes a storyboard in one step', async ({
  browser,
  board,
  users,
}) => {
  test.setTimeout(150_000)
  const alice = await openTab(browser, board, await users.get('alice'))
  const foreign = foreignRequests(alice.page)
  try {
    await setViewport(alice.page, { x: -200, y: -300, zoom: 0.5 })
    await contextMenuItem(alice.page, 'Script to boards…')
    const dialog = alice.page.getByTestId('sb-script-dialog')
    await expect(dialog).toBeVisible()
    const text = dialog.getByTestId('sb-script-text')
    const format = dialog.getByTestId('sb-script-format')
    const beats = dialog.getByTestId('sb-script-beat')

    await text.fill(AV)
    await expect(format.locator('option').first()).toHaveText('Detect (AV script (video and audio columns))')
    await expect(beats).toHaveCount(3)
    await expect(beats.nth(0).getByTestId('sb-beat-camera')).toHaveValue('WIDE')
    await expect(beats.nth(1).getByTestId('sb-beat-dialogue')).toHaveValue(
      'VO: Every day starts with a choice.',
    )

    await text.fill(SCREENPLAY)
    await expect(format.locator('option').first()).toHaveText('Detect (Screenplay or Fountain)')
    await expect(beats).toHaveCount(3)
    await expect(beats.nth(0).getByTestId('sb-beat-dialogue')).toHaveValue('ANA: Morning.')
    await expect(beats.nth(1).getByTestId('sb-beat-dialogue')).toHaveValue("BEN: You're up early.")

    await text.fill(SHOTS)
    await expect(format.locator('option').first()).toHaveText('Detect (Shot list)')
    await expect(beats).toHaveCount(4)
    await expect(beats.nth(0).getByTestId('sb-beat-duration')).toHaveValue('3 s')
    await expect(dialog.getByTestId('sb-script-summary')).toContainText('4 panels')
    // an edit in the preview is what is made
    await beats.nth(3).getByTestId('sb-beat-camera').fill('INSERT')
    await dialog.getByTestId('sb-script-title').fill('Morning shots')
    const before = (await items(alice.page)).length
    await dialog.getByTestId('sb-script-create').click()
    await expect(dialog).toHaveCount(0)
    await expectSaved(alice.page)
    await expect(alice.page.getByTestId('sb-strip-card')).toHaveCount(4)
    await expect(alice.page.getByTestId('sb-strip-title')).toHaveText('Morning shots')
    const head = (await alice.page.getByTestId('sb-strip').getAttribute('data-storyboard-id')) as string
    const all = await items(alice.page)
    const panels = all.filter((e) => e.type === 'frame' && lobbyOf(e)['sb:of'] === head)
    expect(panels).toHaveLength(4)
    expect(panels.map((p) => lobbyOf(p)['sb:dur']).sort()).toEqual([1600, 2000, 2000, 3000])
    // the fields hold the words (their labels), by kind
    const words = (kind: string) =>
      all
        .filter((e) => lobbyOf(e).kind === kind)
        .map((box) => {
          const lbl = (
            (box as { boundElements?: { id: string; type: string }[] | null }).boundElements ?? []
          ).find((b) => b.type === 'text')
          return lbl
            ? String((all.find((e) => e.id === lbl.id) as { originalText?: string })?.originalText ?? '')
            : ''
        })
    expect(words('sb-camera').sort()).toEqual(['CU', 'INSERT', 'OTS', 'WIDE'])
    expect(words('sb-dialogue')).toContain('VO: Every day starts here.')
    expect(words('sb-action').join('\n')).toContain('SFX: birds')
    // one undo takes the whole storyboard away
    await pressUndo(alice.page)
    await expect.poll(async () => (await items(alice.page)).length).toBe(before)
    expect(foreign).toEqual([])
  } finally {
    await alice.close()
  }
})

test('Break down with AI (the fake model): the notice, the panels in the preview, made with provenance', async ({
  browser,
  board,
  users,
  openai,
}) => {
  test.setTimeout(150_000)
  openai.reset()
  const alice = await openTab(browser, board, await users.get('alice'))
  try {
    await setViewport(alice.page, { x: -200, y: -300, zoom: 0.5 })
    await contextMenuItem(alice.page, 'Script to boards…')
    const dialog = alice.page.getByTestId('sb-script-dialog')
    await dialog.getByTestId('sb-script-text').fill('A city at dawn.\nCoffee pours.\nThe logo.')
    await dialog.getByTestId('sb-ai').click()
    // the dialog steps aside for the notice and the busy pill
    await continueIfAsked(alice.page)
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByTestId('sb-ai-made')).toBeVisible()
    const beats = dialog.getByTestId('sb-script-beat')
    await expect(beats).toHaveCount(3)
    await expect(beats.nth(0).getByTestId('sb-beat-camera')).toHaveValue('WIDE')
    await expect(beats.nth(0).getByTestId('sb-beat-dialogue')).toHaveValue('VO: It starts here.')
    await expect(beats.nth(0).getByTestId('sb-beat-duration')).toHaveValue('3 s')
    expect(openai.requests.map((r) => r.body.response_format?.json_schema?.name)).toEqual([
      'lobby_storyboard',
    ])
    await dialog.getByTestId('sb-script-create').click()
    await expect(dialog).toHaveCount(0)
    await expectSaved(alice.page)
    const head = (await alice.page.getByTestId('sb-strip').getAttribute('data-storyboard-id')) as string
    const panels = (await items(alice.page)).filter((e) => e.type === 'frame' && lobbyOf(e)['sb:of'] === head)
    expect(panels).toHaveLength(3)
    for (const p of panels) expect((lobbyOf(p).ai as { by?: string } | undefined)?.by).toBe(alice.id)
  } finally {
    await alice.close()
  }
})
