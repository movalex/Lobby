// OWNER: 3f (workshops; wave N, WS3). Emoji reactions on sticky notes on the Excalidraw board page (N3-1 to N3-3):
// `customData.lobby['react:<code>:<uid>'] = true`, a row under each note, a picker, who reacted, and the keyboard.
// The sync here runs with DRAFTROOM_REACTIONS=on (the kill switch is fail-closed; n3-reactions-off.spec.ts runs it
// off). alice = board owner, bob = editor, carol = viewer.
//
//   cd e2e && E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n3-reactions.spec.ts --project=chromium --workers=1
//
// What each test pins:
//  - two tabs: the row appears on both within one round trip; a viewer sees it with no controls and pushes nothing
//    (the CDP socket frames), and a forged react write from her is refused; the server holds the person's own key;
//  - a reaction is no undo step (Ctrl+Z undoes the edit before it), a locked note takes it, an owner clears a note's
//    reactions and the other tabs converge, an editor is not offered the clear, nor an owner on a locked note;
//  - who reacted (hover and focus), "Someone" for a person it does not know, aria labels and axe in both themes;
//  - the keyboard (Enter on the add button, arrows, Enter, Escape) and a name-only guest who can edit;
//  - a phone: a tap on the add button opens the picker as a sheet and a tap reacts.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expectSaved, item, itemCenterOnScreen, items, select, updateItem } from '../tests/support/canvas.ts'
import { forgeSession, storedElement } from '../tests/support/excalidraw.ts'
import {
  expect,
  expectItemsEverywhere,
  focusCanvas,
  hoverNote,
  pickerOption,
  post,
  reactionChip,
  reactionPicker,
  reactionRow,
  reactionsIn,
  reactionsOfElement,
  reactWithMouse,
  seed,
  showAll,
  test,
  type WorkshopCanvasSession,
  waitForWorkshopBoard,
} from './workshops-kit.ts'

test.use({ syncEnv: { DRAFTROOM_REACTIONS: 'on' } })

const N1 = 'n3-warmup'
const N2 = 'n3-shorter'

async function twoNotes(page: Page) {
  await seed(page, {
    frames: [{ id: 'n3-frame', x: 0, y: 0, w: 560, h: 340, name: 'Ideas' }],
    notes: [
      { id: N1, x: 40, y: 60, text: 'Warm-up game', frameId: 'n3-frame' },
      { id: N2, x: 300, y: 60, text: 'Shorter retro', frameId: 'n3-frame' },
    ],
  })
}

/** The server's copy of a note's reactions: code → uids. */
const stored = async (
  stack: Parameters<typeof storedElement>[0],
  board: string,
  id: string,
): Promise<Record<string, string[]>> => reactionsOfElement(await storedElement(stack, board, id))

test('two tabs: the row appears on both within one round trip; a viewer sees it with no controls and pushes nothing', async ({
  join,
  board,
  stack,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  const everyone = [a, b, c]
  await twoNotes(a.page)
  await expectItemsEverywhere(everyone, [N1, N2])
  for (const s of everyone) await showAll(s.page)
  const carolPushes = c.net.sentPushes().length

  // bob hovers the note: its row offers the add button; the picker opens from it
  await hoverNote(b.page, N1)
  await expect(reactionRow(b.page, N1).getByTestId('note-reaction-add')).toBeVisible()
  await reactWithMouse(b.page, N1, 'up')
  // what was done is said through the board's own polite announcer (no live region of its own)
  await expect(b.page.getByTestId('canvas-announcer-tool')).toContainText('Added your 👍 Thumbs up reaction')

  // within one round trip it is on every tab
  const startedAt = Date.now()
  for (const s of everyone) await expect(reactionChip(s.page, N1, 'up')).toHaveAttribute('data-count', '1')
  expect(Date.now() - startedAt).toBeLessThan(5_000)
  await expect.poll(async () => stored(stack, board, N1)).toEqual({ up: [b.id] })

  // bob's own: pressed, and the label says so; the others see it as someone else's
  const bobsChip = reactionChip(b.page, N1, 'up')
  await expect(bobsChip).toHaveAttribute('aria-pressed', 'true')
  await expect(bobsChip).toHaveAttribute('aria-label', '1 person reacted 👍, including you')
  const alices = reactionChip(a.page, N1, 'up')
  await expect(alices).toHaveAttribute('aria-pressed', 'false')
  await expect(alices).toHaveAttribute('aria-label', '1 person reacted 👍')

  // alice adds hers from the same row (the picker); the count and the label follow on every tab
  await reactWithMouse(a.page, N1, 'up')
  for (const s of everyone) await expect(reactionChip(s.page, N1, 'up')).toHaveAttribute('data-count', '2')
  await expect(alices).toHaveAttribute('aria-label', '2 people reacted 👍, including you')
  await reactWithMouse(a.page, N1, 'heart')
  for (const s of everyone) await expect(reactionChip(s.page, N1, 'heart')).toHaveAttribute('data-count', '1')
  await expect.poll(async () => stored(stack, board, N1)).toEqual({ up: [a.id, b.id].sort(), heart: [a.id] })

  // the order is the contract's: 👍 then ❤️, on every tab
  for (const s of everyone)
    expect(
      await reactionRow(s.page, N1)
        .locator('[data-testid="note-reaction"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-code'))),
    ).toEqual(['up', 'heart'])

  // carol (viewer): the stored row, no controls, nothing pushed; a click on an emoji does nothing
  const hers = reactionRow(c.page, N1)
  await expect(hers).toHaveAttribute('data-readonly', 'true')
  await expect(hers.getByTestId('note-reaction-add')).toHaveCount(0)
  await expect(reactionChip(c.page, N1, 'up')).toHaveAttribute('aria-disabled', 'true')
  await expect(reactionChip(c.page, N1, 'up')).not.toHaveAttribute('aria-pressed', /.*/)
  // (aria-disabled: Playwright would wait for it to be enabled, a person just clicks)
  await reactionChip(c.page, N1, 'up').click({ force: true })
  await hoverNote(c.page, N2)
  await expect(reactionRow(c.page, N2)).toHaveCount(0) // a viewer’s hover adds no row
  expect(await reactionsIn(c.page, N1)).toEqual({ up: [a.id, b.id].sort(), heart: [a.id] })
  expect(c.net.sentPushes().length).toBe(carolPushes)
  // (the recorder works: bob’s tab did push the reaction, as a patch of his own key)
  expect(
    b.net.sentPushes().some((p) => p.ops.some((op) => Object.keys(op.c ?? {}).includes(`react:up:${b.id}`))),
  ).toBe(true)

  // a forged react write from her own ticket is refused
  const { socket, welcome } = await forgeSession(c.page, board)
  try {
    expect(welcome.readonly).toBe(true)
    const el = await storedElement(stack, board, N2)
    await socket.send({
      type: 'push',
      seq: 1,
      base: welcome.clock,
      ops: [{ k: 'p', id: N2, pv: (el?.version ?? 1) as number, c: { [`react:up:${c.id}`]: true } }],
    })
    const ack = await socket.next('ack')
    expect(ack.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['READ_ONLY'])
  } finally {
    await socket.close()
  }
  expect(await stored(stack, board, N2)).toEqual({})

  // stored with the board: carol reloads and still sees them
  await c.page.reload()
  await expect(reactionChip(c.page, N1, 'up')).toHaveAttribute('data-count', '2')
})

test('who reacted: names on hover and focus, Someone for a person this tab never saw, labels and keys', async ({
  join,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await twoNotes(a.page)
  await expectItemsEverywhere([a, b], [N1])
  for (const s of [a, b]) await showAll(s.page)
  await reactWithMouse(b.page, N1, 'party')
  await reactWithMouse(a.page, N1, 'party')
  const chip = reactionChip(a.page, N1, 'party')
  await expect(chip).toHaveAttribute('data-count', '2')

  // hover: you first, then the others by name; never a uid
  await chip.hover()
  const names = a.page.getByTestId('note-reaction-names')
  await expect(names).toBeVisible()
  await expect(names).toContainText('Celebrate')
  await expect(names).toContainText(`You and ${b.name}`)
  // the label and the names are told apart (a colon: read aloud they are not one run of words)
  await expect(names).toContainText(`Celebrate: You and ${b.name}`)
  expect(await names.textContent()).not.toContain('usr_')
  // the chip points at the list for assistive technology
  await expect(chip).toHaveAttribute('aria-describedby', /.+/)
  await a.page.mouse.move(2, 2)
  await expect(names).toHaveCount(0)

  // focus shows it too
  await chip.focus()
  await expect(names).toContainText(b.name)
  await a.page.keyboard.press('Escape')
  await expect(names).toHaveCount(0)

  // a person this tab never saw on the roster reads Someone: a fresh tab of alice's after bob left
  await b.context.close()
  await a.page.reload()
  await expect(reactionChip(a.page, N1, 'party')).toBeVisible()
  await reactionChip(a.page, N1, 'party').hover()
  await expect(a.page.getByTestId('note-reaction-names')).toContainText('You and Someone')
})

test('a reaction is no undo step: Ctrl+Z undoes the edit before it, the reaction stays', async ({
  join,
  stack,
  board,
}) => {
  const b = await join('bob', 'editor')
  await twoNotes(b.page)
  await showAll(b.page)
  await updateItem(b.page, N2, { backgroundColor: '#a7b7f6' })
  await expectSaved(b.page)
  await reactWithMouse(b.page, N1, 'up')
  await expect(reactionChip(b.page, N1, 'up')).toHaveAttribute('aria-pressed', 'true')
  await expectSaved(b.page)
  await focusCanvas(b.page)
  await b.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await item(b.page, N2))?.backgroundColor).not.toBe('#a7b7f6')
  expect(await reactionsIn(b.page, N1)).toEqual({ up: [b.id] })
  await expect.poll(async () => stored(stack, board, N1)).toEqual({ up: [b.id] })
  // and taking it back is no undo step either
  await reactionChip(b.page, N1, 'up').click()
  await expect(reactionRow(b.page, N1).getByTestId('note-reaction')).toHaveCount(0)
  await expect.poll(async () => stored(stack, board, N1)).toEqual({})
})

test('a locked template note takes a reaction (the writer’s own key passes the lock)', async ({
  join,
  stack,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await twoNotes(a.page)
  await expectItemsEverywhere([b], [N1])
  await updateItem(a.page, N1, { locked: true })
  await expectSaved(a.page)
  await expect.poll(async () => (await item(b.page, N1))?.locked).toBe(true)
  await showAll(b.page)
  await reactWithMouse(b.page, N1, 'think')
  await expect(reactionChip(b.page, N1, 'think')).toHaveAttribute('data-count', '1')
  await expect(reactionChip(a.page, N1, 'think')).toHaveAttribute('data-count', '1')
  await expect.poll(async () => stored(stack, board, N1)).toEqual({ think: [b.id] })
  // every other change of the note stays locked
  expect((await item(a.page, N1))?.locked).toBe(true)
})

test('an owner clears a note’s reactions from the context menu and the other tab converges; an editor is not offered it', async ({
  join,
  stack,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  await twoNotes(a.page)
  await expectItemsEverywhere([b, c], [N1, N2])
  for (const s of [a, b, c]) await showAll(s.page)
  await reactWithMouse(b.page, N1, 'clap')
  await reactWithMouse(a.page, N1, 'clap')
  await reactWithMouse(b.page, N1, 'laugh')
  for (const s of [a, b, c]) await expect(reactionChip(s.page, N1, 'clap')).toHaveAttribute('data-count', '2')

  const menuAt = async (s: WorkshopCanvasSession) => {
    await select(s.page, [N1])
    const { x, y } = await itemCenterOnScreen(s.page, N1)
    await s.page.mouse.click(x, y, { button: 'right' })
    await expect(s.page.getByTestId('context-menu')).toBeVisible()
  }

  // bob (editor): React… yes, Clear reactions no
  await menuAt(b)
  await expect(b.page.getByTestId('context-menu.reactions-react')).toBeVisible()
  await expect(b.page.getByTestId('context-menu.reactions-clear')).toHaveCount(0)
  await b.page.keyboard.press('Escape')

  // alice (owner): clears it all
  await menuAt(a)
  await a.page.getByTestId('context-menu.reactions-clear').click()
  // (a selected note keeps a row with its add button; the emoji are gone)
  for (const s of [a, b, c]) await expect(reactionRow(s.page, N1).getByTestId('note-reaction')).toHaveCount(0)
  await expect.poll(async () => stored(stack, board, N1)).toEqual({})
  // the tabs end on the server’s copy
  expect(await reactionsIn(b.page, N1)).toEqual({})
  expect(await reactionsIn(c.page, N1)).toEqual({})
})

test('an owner is not offered Clear reactions on a locked note (the room keeps another person’s key under a lock); unlocking brings it back', async ({
  join,
  stack,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await twoNotes(a.page)
  await expectItemsEverywhere([b], [N1, N2])
  for (const s of [a, b]) await showAll(s.page)
  await reactWithMouse(b.page, N1, 'clap')
  await expect(reactionChip(a.page, N1, 'clap')).toHaveAttribute('data-count', '1')
  await updateItem(a.page, N1, { locked: true })
  await expectSaved(a.page)
  await expect.poll(async () => (await item(b.page, N1))?.locked).toBe(true)

  const menuAt = async () => {
    await select(a.page, [N1])
    const { x, y } = await itemCenterOnScreen(a.page, N1)
    await a.page.mouse.click(x, y, { button: 'right' })
    await expect(a.page.getByTestId('context-menu')).toBeVisible()
  }

  // locked: React… yes, Clear reactions no (the context menu and the picker)
  await menuAt()
  await expect(a.page.getByTestId('context-menu.reactions-react')).toBeVisible()
  await expect(a.page.getByTestId('context-menu.reactions-clear')).toHaveCount(0)
  await a.page.keyboard.press('Escape')
  await select(a.page, [N1])
  await a.page.getByTestId('selection-reactions').click()
  await expect(reactionPicker(a.page)).toBeVisible()
  await expect(a.page.getByTestId('note-reactions-clear')).toHaveCount(0)
  await a.page.keyboard.press('Escape')
  await expect(reactionPicker(a.page)).toHaveCount(0)

  // nothing was sent that the room would refuse: the page stays Saved, bob’s reaction is stored and shown
  await expectSaved(a.page)
  await expect.poll(async () => stored(stack, board, N1)).toEqual({ clap: [b.id] })
  await expect(reactionChip(a.page, N1, 'clap')).toHaveAttribute('data-count', '1')

  // unlocked: the clear is offered again and reaches the other tab
  await updateItem(a.page, N1, { locked: false })
  await expectSaved(a.page)
  await menuAt()
  await a.page.getByTestId('context-menu.reactions-clear').click()
  for (const s of [a, b]) await expect(reactionRow(s.page, N1).getByTestId('note-reaction')).toHaveCount(0)
  await expect.poll(async () => stored(stack, board, N1)).toEqual({})
  await expectSaved(a.page)
})

test('the selection bar’s React button, the context menu’s React… and the keyboard reach the same picker', async ({
  join,
  stack,
  board,
}) => {
  const a = await join('alice')
  await twoNotes(a.page)
  await showAll(a.page)

  // the selection bar
  await select(a.page, [N1])
  const barButton = a.page.getByTestId('selection-reactions')
  await expect(barButton).toBeVisible()
  await barButton.click()
  await expect(reactionPicker(a.page)).toBeVisible()
  await expect(reactionPicker(a.page)).toHaveAttribute('data-via', 'click')
  await pickerOption(a.page, 'heart').click()
  await expect(reactionChip(a.page, N1, 'heart')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => stored(stack, board, N1)).toEqual({ heart: [a.id] })

  // two notes at once: one pick, one push, a reaction on each
  await select(a.page, [N1, N2])
  await a.page.getByTestId('selection-reactions').click()
  await expect(reactionPicker(a.page)).toBeVisible()
  await pickerOption(a.page, 'up').click()
  await expect.poll(async () => stored(stack, board, N2)).toEqual({ up: [a.id] })
  await expect.poll(async () => stored(stack, board, N1)).toEqual({ heart: [a.id], up: [a.id] })

  // the keyboard: Enter on the add button, arrows between the emoji, Enter picks, the keyboard stays
  await select(a.page, [])
  await hoverNote(a.page, N2)
  const add = reactionRow(a.page, N2).getByTestId('note-reaction-add')
  await add.focus()
  await a.page.keyboard.press('Enter')
  await expect(reactionPicker(a.page)).toBeVisible()
  await expect(pickerOption(a.page, 'up')).toBeFocused()
  await a.page.keyboard.press('ArrowRight')
  await expect(pickerOption(a.page, 'heart')).toBeFocused()
  await a.page.keyboard.press('Enter')
  await expect(reactionPicker(a.page)).toHaveCount(0)
  await expect(reactionChip(a.page, N2, 'heart')).toHaveAttribute('data-count', '1')
  await expect(add).toBeFocused()
  // Escape closes it and gives the keyboard back
  await a.page.keyboard.press('Enter')
  await expect(reactionPicker(a.page)).toBeVisible()
  await a.page.keyboard.press('Escape')
  await expect(reactionPicker(a.page)).toHaveCount(0)
  await expect(add).toBeFocused()
  // Tab out of a picker opened on purpose closes it: the keyboard has moved on (it does not stay open behind it)
  await a.page.keyboard.press('Enter')
  await expect(reactionPicker(a.page)).toBeVisible()
  for (let i = 0; i < 12 && (await reactionPicker(a.page).count()) > 0; i++)
    await a.page.keyboard.press('Tab')
  await expect(reactionPicker(a.page)).toHaveCount(0)
  await expect(add).toHaveAttribute('aria-expanded', 'false')
  expect(await add.getAttribute('aria-haspopup')).toBeNull()
  await expect.poll(async () => stored(stack, board, N2)).toEqual({ heart: [a.id], up: [a.id] })
})

test('axe: the row and the picker pass in the light and the dark theme', async ({ join }) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await twoNotes(a.page)
  await expectItemsEverywhere([b], [N1])
  await showAll(a.page)
  await showAll(b.page)
  await reactWithMouse(b.page, N1, 'up')
  await reactWithMouse(a.page, N1, 'heart')
  await expect(reactionChip(a.page, N1, 'up')).toBeVisible()
  const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
  for (const colorScheme of ['light', 'dark'] as const) {
    await a.page.emulateMedia({ colorScheme })
    // the row, read-only for a tab that cannot react (carol’s view is the same markup minus the add button)
    const row = await new AxeBuilder({ page: a.page })
      .include('[data-testid="note-reactions-layer"]')
      .withTags(TAGS)
      .analyze()
    expect(
      row.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      `row ${colorScheme}`,
    ).toEqual([])
    // with the picker open and a names list showing
    await reactionRow(a.page, N1).getByTestId('note-reaction-add').click()
    await expect(reactionPicker(a.page)).toBeVisible()
    await reactionChip(a.page, N1, 'up').hover()
    await expect(a.page.getByTestId('note-reaction-names')).toBeVisible()
    const open = await new AxeBuilder({ page: a.page })
      .include('[data-testid="note-reactions-layer"]')
      .withTags(TAGS)
      .analyze()
    expect(
      open.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      `picker ${colorScheme}`,
    ).toEqual([])
    await a.page.keyboard.press('Escape')
    await expect(reactionPicker(a.page)).toHaveCount(0)
  }
})

test('a phone: a tap on the add button opens the picker as a sheet, a tap on an emoji reacts', async ({
  join,
  stack,
  board,
}, testInfo) => {
  const a = await join('alice')
  await twoNotes(a.page)
  const p = await join('bob', 'editor', {
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  })
  await expectItemsEverywhere([p], [N1, N2])
  await showAll(p.page)
  // the phone rests on Hand: a note is selected on purpose (the facade), which gives its row the add button
  await select(p.page, [N1])
  const add = reactionRow(p.page, N1).getByTestId('note-reaction-add')
  await expect(add).toBeVisible()
  await add.tap()
  const sheet = reactionPicker(p.page)
  await expect(sheet).toBeVisible()
  await expect(sheet).toHaveClass(/dr-wk-nr-picker--sheet/)
  // touch size
  const box = await pickerOption(p.page, 'clap').boundingBox()
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  // inside the screen, above the bottom toolbar
  const sheetBox = await sheet.boundingBox()
  expect(sheetBox?.x ?? -1).toBeGreaterThanOrEqual(0)
  expect((sheetBox?.x ?? 0) + (sheetBox?.width ?? 999)).toBeLessThanOrEqual(390)
  await pickerOption(p.page, 'clap').tap()
  await expect(sheet).toHaveCount(0)
  await expect(reactionChip(p.page, N1, 'clap')).toHaveAttribute('data-count', '1')
  await expect(reactionChip(a.page, N1, 'clap')).toHaveAttribute('data-count', '1')
  await expect.poll(async () => stored(stack, board, N1)).toEqual({ clap: [p.id] })
  await p.page.screenshot({ path: testInfo.outputPath('phone-reactions.png') })
  // the sheet closes with its Close button too
  await add.tap()
  await expect(sheet).toBeVisible()
  await p.page.getByTestId('reaction-picker-close').tap()
  await expect(sheet).toHaveCount(0)
})

test('a tab that only receives pushes nothing: an idle editor sees a reaction come, go and be cleared (CDP socket frames)', async ({
  join,
  stack,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await twoNotes(a.page)
  await expectItemsEverywhere([b], [N1, N2])
  for (const s of [a, b]) await showAll(s.page)
  await expectSaved(b.page)
  const pushed = b.net.sentPushes().length
  await b.page.waitForTimeout(2_000) // what arrives with the board is not a reaction (no burst)

  await reactWithMouse(a.page, N1, 'up')
  await expect(reactionChip(b.page, N1, 'up')).toHaveAttribute('data-count', '1')
  // the reaction bursts once on the tab that only watches (five copies; the reduced-motion test below has one)
  await expect(b.page.getByTestId('note-reaction-burst')).toBeVisible()
  await expect(b.page.locator('[data-testid="note-reaction-burst"] [data-copies]')).toHaveAttribute(
    'data-copies',
    '5',
  )
  await reactionChip(a.page, N1, 'up').click()
  await expect(reactionRow(b.page, N1)).toHaveCount(0)
  await reactWithMouse(a.page, N2, 'heart')
  await expect(reactionChip(b.page, N2, 'heart')).toHaveAttribute('data-count', '1')
  await select(a.page, [N2])
  const at = await itemCenterOnScreen(a.page, N2)
  await a.page.mouse.click(at.x, at.y, { button: 'right' })
  await a.page.getByTestId('context-menu.reactions-clear').click()
  await expect(reactionChip(b.page, N2, 'heart')).toHaveCount(0)
  await expect.poll(async () => stored(stack, board, N2)).toEqual({})

  // bob’s tab received all of it, drew it (bursts included) and wrote nothing back
  await expectSaved(b.page)
  expect(b.net.sentPushes().length).toBe(pushed)
})

test('a copy of a reacted note takes no reactions (the key spec strips them); the original keeps them', async ({
  join,
  stack,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await twoNotes(a.page)
  await expectItemsEverywhere([b], [N1])
  for (const s of [a, b]) await showAll(s.page)
  await reactWithMouse(b.page, N1, 'up')
  await reactWithMouse(a.page, N1, 'heart')
  await expect.poll(async () => stored(stack, board, N1)).toEqual({ up: [b.id], heart: [a.id] })

  const known = (await items(a.page)).map((e) => e.id)
  await select(a.page, [N1])
  await focusCanvas(a.page)
  await a.page.keyboard.press('ControlOrMeta+d')
  await expect
    .poll(
      async () =>
        (await items(a.page)).filter((e) => e.type === 'stickynote' && !known.includes(e.id)).length,
    )
    .toBe(1)
  const copy = (await items(a.page)).find((e) => e.type === 'stickynote' && !known.includes(e.id))
    ?.id as string
  // it is on the server and on bob’s tab (a copy that kept someone else’s key would have been refused), without them
  await expect.poll(async () => (await storedElement(stack, board, copy))?.type).toBe('stickynote')
  await expect.poll(async () => !!(await item(b.page, copy))).toBe(true)
  expect(await stored(stack, board, copy)).toEqual({})
  expect(await reactionsIn(a.page, copy)).toEqual({})
  expect(await reactionsIn(b.page, copy)).toEqual({})
  // the original keeps them
  expect(await stored(stack, board, N1)).toEqual({ up: [b.id], heart: [a.id] })
})

test('two people react to the same note at the same moment: both land, on every tab and on the server', async ({
  join,
  stack,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await twoNotes(a.page)
  await expectItemsEverywhere([b], [N1])
  for (const s of [a, b]) await showAll(s.page)
  await Promise.all([reactWithMouse(a.page, N1, 'up'), reactWithMouse(b.page, N1, 'up')])
  for (const s of [a, b]) await expect(reactionChip(s.page, N1, 'up')).toHaveAttribute('data-count', '2')
  await expect.poll(async () => stored(stack, board, N1)).toEqual({ up: [a.id, b.id].sort() })
  // and both take theirs back at the same moment
  await Promise.all([reactionChip(a.page, N1, 'up').click(), reactionChip(b.page, N1, 'up').click()])
  for (const s of [a, b]) await expect(reactionRow(s.page, N1).getByTestId('note-reaction')).toHaveCount(0)
  await expect.poll(async () => stored(stack, board, N1)).toEqual({})
})

test('a name-only guest who can edit reacts like anyone (a key of their own uid), and is named in the list', async ({
  join,
  browser,
  stack,
  board,
}) => {
  const a = await join('alice')
  await twoNotes(a.page)
  await showAll(a.page)
  const r = await post(a, `/api/boards/${board}/review-links`, { role: 'editor', allowGuests: true })
  expect(r.status(), await r.text()).toBe(201)
  const { url } = (await r.json()) as { url: string }
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(url)
    await page.getByTestId('invite-guest-name').fill('Gina Guest')
    await page.getByTestId('invite-guest-join').click()
    await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
    await waitForWorkshopBoard(page)
    const guestId = (await page.getByTestId('user-menu').getAttribute('data-user-id')) ?? ''
    expect(guestId).not.toBe('')
    await expectItemsEverywhere([{ page, user: 'gina' }], [N1])
    await showAll(page)
    await reactWithMouse(page, N1, 'clap')
    await expect(reactionChip(a.page, N1, 'clap')).toHaveAttribute('data-count', '1')
    await expect.poll(async () => stored(stack, board, N1)).toEqual({ clap: [guestId] })
    await reactionChip(a.page, N1, 'clap').hover()
    await expect(a.page.getByTestId('note-reaction-names')).toContainText('Gina Guest')
  } finally {
    await context.close()
  }
})

test('the picker follows the pointer on hover, stays once clicked, and closes on an outside press', async ({
  join,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await twoNotes(a.page)
  await expectItemsEverywhere([b], [N1])
  for (const s of [a, b]) await showAll(s.page)
  await reactWithMouse(b.page, N1, 'up')
  await expect(reactionChip(a.page, N1, 'up')).toBeVisible()

  // hover: the picker opens on its own (and goes when the pointer leaves)
  await reactionChip(a.page, N1, 'up').hover()
  await expect(reactionPicker(a.page)).toHaveAttribute('data-via', 'hover')
  await a.page.mouse.move(2, 300)
  await expect(reactionPicker(a.page)).toHaveCount(0)

  // a click on the add button while the hover one is open keeps it (one picker replaced by another)
  await reactionChip(a.page, N1, 'up').hover()
  await expect(reactionPicker(a.page)).toHaveAttribute('data-via', 'hover')
  await reactionRow(a.page, N1).getByTestId('note-reaction-add').click()
  await expect(reactionPicker(a.page)).toHaveAttribute('data-via', 'click')
  await a.page.mouse.move(2, 300)
  await a.page.waitForTimeout(600)
  await expect(reactionPicker(a.page)).toBeVisible()
  // an outside press closes it (and takes nothing from the board)
  await a.page.mouse.click(2, 300)
  await expect(reactionPicker(a.page)).toHaveCount(0)
  expect(await reactionsIn(a.page, N1)).toEqual({ up: [b.id] })
})

test('people who prefer reduced motion get one still copy of the burst, not five', async ({ join }) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await b.page.emulateMedia({ reducedMotion: 'reduce' })
  await twoNotes(a.page)
  await expectItemsEverywhere([b], [N1])
  for (const s of [a, b]) await showAll(s.page)
  await b.page.waitForTimeout(2_000) // what arrives with the board is not a reaction
  await reactWithMouse(a.page, N1, 'party')
  const burst = b.page.locator('[data-testid="note-reaction-burst"] [data-copies]')
  await expect(burst).toHaveAttribute('data-copies', '1')
  await expect(b.page.locator('[data-testid="note-reaction-burst"] [data-copy="spark"]')).toHaveCount(0)
})
