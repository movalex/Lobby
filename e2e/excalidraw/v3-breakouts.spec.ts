// Wave V (WS4, V3): breakouts on the real board page against the real api and sync server (docs/WAVE-V-CONTRACTS.md
// §4). What must hold:
//   - a facilitator starts breakouts from the Facilitate menu's entry with two selected frames, and puts four people in
//     two groups from the panel; each person's chip says their group and their camera goes to their frame;
//   - "follow never leaks across groups": a summon of group 1 moves only group 1's cameras (they follow the
//     facilitator), and group 2's pages never even receive it; a message to group 2 reaches group 2 only; a message to
//     everyone reaches everyone;
//   - End: every chip says "Breakouts ended";
//   - a phone at 375 px picks its group from the chip (choose mode), with no sideways scroll; the keyboard alone starts
//     breakouts from the Facilitate menu and joins a group;
//   - no request leaves Lobby's own origins.
//
//   E2E_PORT_BASE=47300 pnpm exec playwright test excalidraw/v3-breakouts --project=chromium --workers=1   (from e2e/)
import { setViewport } from '../tests/support/canvas.ts'
import {
  eventsOf,
  expect,
  following,
  openBreakouts,
  type Person,
  sidOf,
  test,
  viewCentredIn,
} from './v3-kit.ts'
import { seed } from './workshops-kit.ts'

const FRAME_A = { id: 'brk-frame-a', x: 0, y: 0, w: 900, h: 600, name: 'Team Red' }
const FRAME_B = { id: 'brk-frame-b', x: 4000, y: 2500, w: 900, h: 600, name: 'Team Blue' }

const chip = (p: Person) => p.page.getByTestId('breakout-chip')

test('V3: two groups of two; a group summon moves only that group, a group message reaches only that group, End ends it for all', async ({
  person,
}) => {
  const alice = await person('alice')
  await seed(alice.page, { frames: [FRAME_A, FRAME_B] })
  const bob = await person('bob', 'editor')
  const carol = await person('carol', 'viewer')
  const dave = await person('dave', 'commenter')
  const erin = await person('erin', 'editor')
  const people = [bob, carol, dave, erin]

  await test.step('alice starts breakouts from the Facilitate menu with the two selected frames', async () => {
    await alice.page.evaluate(
      (ids) =>
        (
          window as unknown as { __lobbyBoard: { canvas: { select(ids: string[]): void } } }
        ).__lobbyBoard.canvas.select(ids),
      [FRAME_A.id, FRAME_B.id],
    )
    const panel = await openBreakouts(alice.page)
    await expect(panel.getByTestId('breakouts-src-selected')).toBeChecked()
    await panel.getByTestId('breakouts-mode-manual').check()
    await panel.getByTestId('breakouts-start').click()
    await expect(panel.getByTestId('breakouts-manage')).toBeVisible()
    await expect(panel.getByTestId('breakouts-group-g1')).toContainText('Team Red')
    await expect(panel.getByTestId('breakouts-group-g2')).toContainText('Team Blue')
    // everyone else waits for a group
    for (const p of people) await expect(chip(p)).toHaveAttribute('data-kind', 'waiting')
  })

  await test.step('alice puts bob and carol in Team Red, dave and erin in Team Blue (a picker per person)', async () => {
    const panel = alice.page.getByTestId('breakouts-panel')
    for (const [p, g] of [
      [bob, 'g1'],
      [carol, 'g1'],
      [dave, 'g2'],
      [erin, 'g2'],
    ] as const) {
      await panel.getByTestId(`breakouts-move-${p.id}`).selectOption(g)
      await expect(
        panel.getByTestId(`breakouts-group-${g}`).getByTestId(`breakouts-person-${p.id}`),
      ).toBeVisible()
    }
    for (const [p, g, frame] of [
      [bob, 'Team Red', FRAME_A],
      [carol, 'Team Red', FRAME_A],
      [dave, 'Team Blue', FRAME_B],
      [erin, 'Team Blue', FRAME_B],
    ] as const) {
      await expect(chip(p)).toHaveAttribute('data-kind', 'member')
      await expect(p.page.getByTestId('breakout-chip-title')).toHaveText(g)
      await expect(p.page.getByTestId('breakout-chip-time')).toHaveText(/^\d+:\d\d left$/)
      // their camera went to their group's frame
      await expect.poll(() => viewCentredIn(p.page, frame), { message: `${p.handle} sees ${g}` }).toBe(true)
    }
  })

  await test.step('a summon of Team Red moves only Team Red: they follow alice; Team Blue never receives it', async () => {
    await setViewport(alice.page, { x: -3000, y: -2000, zoom: 0.8 })
    const before = await Promise.all([dave, erin].map((p) => viewCentredIn(p.page, FRAME_B)))
    expect(before).toEqual([true, true])
    await alice.page.getByTestId('breakouts-summon-g1').click()
    const aliceSid = await sidOf(alice.page)
    for (const p of [bob, carol]) {
      await expect.poll(() => following(p.page), { message: `${p.handle} follows alice` }).toBe(aliceSid)
      await expect(p.page.getByTestId('breakout-summon-toast')).toContainText('Alice')
    }
    // give a leaked event every chance to arrive, then check the other group
    await bob.page.waitForTimeout(1_500)
    for (const p of [dave, erin]) {
      expect(eventsOf(p, 'workshop.breakout.summon'), p.handle).toEqual([])
      expect(await following(p.page), p.handle).toBeNull()
      expect(await viewCentredIn(p.page, FRAME_B), p.handle).toBe(true)
      await expect(p.page.getByTestId('breakout-summon-toast')).toHaveCount(0)
    }
    expect(await following(alice.page)).toBeNull()
  })

  await test.step('a message to Team Blue reaches Team Blue only; one to everyone reaches everyone', async () => {
    const panel = alice.page.getByTestId('breakouts-panel')
    await panel.getByTestId('breakouts-broadcast-text').fill('Blue: two minutes left')
    await panel.getByTestId('breakouts-broadcast-to').selectOption('g2')
    await panel.getByTestId('breakouts-broadcast-send').click()
    for (const p of [dave, erin])
      await expect(p.page.getByTestId('breakout-broadcast-toast')).toContainText('Blue: two minutes left')
    await bob.page.waitForTimeout(1_000)
    for (const p of [bob, carol]) {
      expect(eventsOf(p, 'workshop.breakout.broadcast'), p.handle).toEqual([])
      await expect(p.page.getByTestId('breakout-broadcast-toast')).toHaveCount(0)
    }
    // one message per 3 s per session
    await alice.page.waitForTimeout(3_100)
    await panel.getByTestId('breakouts-broadcast-text').fill('Everyone back in two minutes')
    await panel.getByTestId('breakouts-broadcast-to').selectOption('')
    await panel.getByTestId('breakouts-broadcast-send').click()
    for (const p of people)
      await expect(p.page.getByTestId('breakout-broadcast-toast')).toContainText(
        'Everyone back in two minutes',
      )
  })

  await test.step('End: every chip says the breakouts ended', async () => {
    await alice.page.getByTestId('breakouts-panel').getByTestId('breakouts-end').click()
    for (const p of people) await expect(chip(p)).toHaveAttribute('data-kind', 'ended')
    await expect(alice.page.getByTestId('breakouts-setup')).toBeVisible()
  })

  // editing was never fenced: bob (in Team Red) still edits next to Team Blue's frame. A note there is accepted.
  await test.step('editing is not fenced to a group frame', async () => {
    await seed(bob.page, {
      notes: [{ id: 'brk-note-anywhere', x: FRAME_B.x + 50, y: FRAME_B.y + 50, text: 'Hi' }],
    })
  })

  for (const p of [alice, ...people]) expect(p.foreign, p.handle).toEqual([])
})

test('V3: a phone at 375 px picks its group from the chip (choose mode); the keyboard starts breakouts and joins', async ({
  person,
}) => {
  const alice = await person('alice')
  await seed(alice.page, { frames: [FRAME_A, FRAME_B] })
  const phone = await person('erin', 'viewer', { phone: true })
  const kb = await person('dave', 'commenter')

  await test.step('the keyboard: Facilitate menu, Breakouts, Let people choose, Start', async () => {
    await alice.page.evaluate(
      (ids) =>
        (
          window as unknown as { __lobbyBoard: { canvas: { select(ids: string[]): void } } }
        ).__lobbyBoard.canvas.select(ids),
      [FRAME_A.id, FRAME_B.id],
    )
    await alice.page.getByTestId('facilitate-button').focus()
    await alice.page.keyboard.press('Enter')
    await expect(alice.page.getByTestId('facilitate-menu')).toBeVisible()
    // the registered entries come after the built-ins: Breakouts is the last one
    await alice.page.keyboard.press('End')
    await expect(alice.page.getByTestId('breakouts-entry')).toBeFocused()
    await alice.page.keyboard.press('Enter')
    const panel = alice.page.getByTestId('breakouts-panel')
    await expect(panel).toBeVisible()
    await panel.getByTestId('breakouts-mode-choose').focus()
    await alice.page.keyboard.press('Space')
    await expect(panel.getByTestId('breakouts-mode-choose')).toBeChecked()
    await panel.getByTestId('breakouts-cap').focus()
    await alice.page.keyboard.type('1')
    await panel.getByTestId('breakouts-start').focus()
    await alice.page.keyboard.press('Enter')
    await expect(panel.getByTestId('breakouts-manage')).toBeVisible()
  })

  await test.step('the phone: the chip fits, Pick a group opens the panel, Join puts it in Team Blue', async () => {
    const c = phone.page.getByTestId('breakout-chip')
    await expect(c).toHaveAttribute('data-kind', 'choose')
    const box = await c.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true)
    await phone.page.getByTestId('breakout-pick').tap()
    const choose = phone.page.getByTestId('breakouts-choose')
    await expect(choose).toBeVisible()
    await choose.getByRole('button', { name: 'Join Team Blue' }).tap()
    await expect(c).toHaveAttribute('data-kind', 'member')
    await expect(phone.page.getByTestId('breakout-chip-title')).toHaveText('Team Blue')
    const sideways = await phone.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(sideways).toBeLessThanOrEqual(0)
    await expect.poll(() => viewCentredIn(phone.page, FRAME_B)).toBe(true)
  })

  await test.step('the keyboard: a full group cannot be joined; Team Red can, with Enter', async () => {
    await kb.page.getByTestId('breakout-pick').focus()
    await kb.page.keyboard.press('Enter')
    const choose = kb.page.getByTestId('breakouts-choose')
    await expect(choose).toBeVisible()
    await expect(choose.getByRole('button', { name: 'Team Blue is full' })).toBeDisabled()
    await choose.getByRole('button', { name: 'Join Team Red' }).focus()
    await kb.page.keyboard.press('Enter')
    await expect(kb.page.getByTestId('breakout-chip-title')).toHaveText('Team Red')
    // Go to my frame from the chip, with the keyboard
    await setViewport(kb.page, { x: -5000, y: -5000, zoom: 1 })
    await kb.page.getByTestId('breakout-go').focus()
    await kb.page.keyboard.press('Enter')
    await expect.poll(() => viewCentredIn(kb.page, FRAME_A)).toBe(true)
  })

  for (const p of [alice, phone, kb]) expect(p.foreign, p.handle).toEqual([])
})
