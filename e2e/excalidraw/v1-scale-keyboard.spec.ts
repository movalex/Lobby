// OWNER: WS2 (wave V, V1). A named scale run with the keyboard only: the facilitator reaches "Poll or word cloud" in
// the Facilitate menu with the arrow keys, sets up a 1-5 scale with end labels and Anonymous off (the dialog says what
// that means), and a participant answers from the start notice with Tab and the arrow keys; the numbers have names a
// screen reader reads ("5, Completely"). After the reveal the facilitator alone sees who answered what; the
// participant never sees a name. Results to board makes the scale's chart.
import { expectSaved } from '../tests/support/canvas.ts'
import { expect, expectAnswered, panel, placed, test, withLive } from './v1-kit.ts'

test('a named 1-5 scale, set up and answered with the keyboard; names reach the facilitator alone, after the reveal', async ({
  join,
}) => {
  const alice = await withLive(await join('alice'))
  const bob = await withLive(await join('bob', 'editor'))
  const a = alice.page

  // the Facilitate menu by keyboard: the button, Enter, arrow down to the entry, Enter
  await a.getByTestId('facilitate-button').focus()
  await a.keyboard.press('Enter')
  await expect(a.getByTestId('facilitate-menu')).toBeVisible()
  for (let i = 0; i < 12; i++) {
    const at = await a.evaluate(() => document.activeElement?.getAttribute('data-testid'))
    if (at === 'facilitate-activities') break
    await a.keyboard.press('ArrowDown')
  }
  await expect(a.getByTestId('facilitate-activities')).toBeFocused()
  await a.keyboard.press('Enter')
  const d = a.getByTestId('la-setup-dialog')
  await expect(d).toBeVisible()
  // the dialog opens on the question; the kind is the radio group before it
  await expect(d.getByTestId('la-prompt-input')).toBeFocused()
  await a.keyboard.type('How confident are you in the plan?')
  await a.keyboard.press('Shift+Tab')
  await a.keyboard.press('ArrowRight')
  await expect(d.getByTestId('la-kind-scale')).toBeChecked()
  await d.getByTestId('la-min-label').focus()
  await a.keyboard.type('Not at all')
  await a.keyboard.press('Tab')
  await a.keyboard.type('Completely')
  // Anonymous off: the dialog says what the facilitator will see
  await d.getByTestId('la-anonymous').focus()
  await a.keyboard.press('Space')
  await expect(d.getByTestId('la-anonymous-hint')).toContainText(
    'Answers show who gave them to you after the reveal',
  )
  await d.getByTestId('la-setup-submit').focus()
  await a.keyboard.press('Enter')
  await expect(d).toHaveCount(0)
  await expect(panel(a)).toHaveAttribute('data-kind', 'scale')

  // the participant: the notice's Answer, then Tab into the numbers and the arrows
  const b = bob.page
  const answer = b.getByTestId('la-start-toast-answer')
  await answer.focus()
  await b.keyboard.press('Enter')
  const sheet = panel(b)
  await expect(sheet.getByTestId('la-anonymity')).toContainText('Named')
  await expect(sheet.getByRole('radio', { name: '5, Completely' })).toBeAttached()
  await expect(sheet.getByRole('radio', { name: '1, Not at all' })).toBeAttached()
  await sheet.getByRole('radio', { name: '1, Not at all' }).focus()
  await b.keyboard.press('ArrowRight')
  await b.keyboard.press('ArrowRight')
  await b.keyboard.press('ArrowRight')
  await expect(sheet.getByTestId('la-scale-4')).toBeChecked()
  await sheet.getByTestId('la-answer-send').focus()
  await b.keyboard.press('Enter')
  await expect(sheet.getByTestId('la-answer-status')).toContainText('Your answer is in')

  await expectAnswered(a, 1)
  await panel(a).getByTestId('la-reveal').click()
  await expect(panel(a).getByTestId('la-scale-summary')).toHaveText('Average 4 · median 4')
  await expect(panel(b).getByTestId('la-scale-summary')).toHaveText('Average 4 · median 4')

  // who answered what: the facilitator, after the reveal; never the participant
  await panel(a).getByTestId('la-named').locator('summary').click()
  await expect(panel(a).getByTestId('la-named-list')).toContainText(`${bob.name}: 4`)
  await expect(panel(b).getByTestId('la-named')).toHaveCount(0)
  await expect(panel(b)).not.toContainText(alice.name)

  await panel(a).getByTestId('la-to-board').click()
  await expectSaved(a)
  const chart = await placed(a, 'poll-chart')
  expect(chart.filter((e) => e.type === 'rectangle')).toHaveLength(1)
  // a named activity's chart still names nobody: it is the aggregate
  const texts = chart.map((e) => (e as unknown as { text?: string }).text ?? '').join('\n')
  expect(texts).not.toContain(bob.name)
  expect(texts).toContain('5 = Completely')
})
