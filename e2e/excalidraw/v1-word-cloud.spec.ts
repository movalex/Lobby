// OWNER: WS2 (wave V, V1; docs/WAVE-V-CONTRACTS.md §2.1, §2.5). A word cloud end to end: answers in different cases
// and widths group as one word (normalizeWord: NFKC, lower case), shown in its most frequent spelling; the facilitator
// sees the words live and hides one, which leaves the results and the board; the reveal shows them to everyone; "Word
// cloud to board" is one undo step of free texts tagged 'word-cloud' inside their frame (laid out by the packer over
// the server's text metrics), and "As sticky notes" one note per word with its count.
import type { BrowserContext } from '@playwright/test'
import { expectSaved } from '../tests/support/canvas.ts'
import {
  answerWords,
  expect,
  expectAnswered,
  focusCanvas,
  guestJoins,
  panel,
  placed,
  startActivity,
  test,
  withLive,
  workshopLink,
} from './v1-kit.ts'

const KIND = 'word-cloud'
const textOf = (e: unknown) => (e as { text?: string }).text ?? ''

test('a word cloud groups case and width variants, hides a word before and after the reveal, and goes to the board as words or as notes', async ({
  join,
  board,
  browser,
}) => {
  const alice = await withLive(await join('alice'))
  const bob = await withLive(await join('bob', 'editor'))
  const carol = await withLive(await join('carol', 'commenter'))
  const opened: BrowserContext[] = []
  try {
    const guest = await guestJoins(browser, await workshopLink(alice, board), 'Gus Guest', opened)
    await startActivity(alice.page, { kind: 'words', prompt: 'One word for this sprint?', maxWords: 3 })

    await answerWords(bob.page, ['Agile', 'Speed', 'coffee'])
    await answerWords(carol.page, ['agile', 'Focus'])
    // fullwidth letters fold (NFKC) into the same word
    await answerWords(guest.page, ['Ａｇｉｌｅ', 'speed'])
    // one person's same word twice is refused before it is sent
    const p = panel(bob.page)
    await p.getByTestId('la-word-2').fill('AGILE')
    await p.getByTestId('la-answer-send').click()
    await expect(p.getByTestId('la-answer-error')).toHaveText('Each word once.')
    await p.getByTestId('la-word-2').fill('coffee')

    await expectAnswered(alice.page, 3)
    // the facilitator sees the words while it runs (aggregates only), the others do not
    const live = panel(alice.page).getByTestId('la-words-results')
    await expect(live.locator('li').first()).toContainText('Agile')
    await expect(live.locator('li').first()).toHaveAttribute('data-count', '3')
    await expect(panel(bob.page).getByTestId('la-words-results')).toHaveCount(0)

    // moderation: coffee leaves the results
    await live.getByRole('button', { name: 'Hide the word coffee' }).click()
    await expect(panel(alice.page).getByTestId('la-hidden-words')).toContainText('coffee')
    await expect(live).not.toContainText('coffee')

    await panel(alice.page).getByTestId('la-reveal').click()
    for (const page of [alice.page, bob.page, carol.page, guest.page]) {
      const list = panel(page).getByTestId('la-words-results')
      await expect(list.locator('li')).toHaveCount(3)
      await expect(list).toContainText('Agile')
      await expect(list).toContainText('Speed')
      await expect(list).toContainText('Focus')
      await expect(list).not.toContainText('coffee')
    }

    // the integration, against the real api: a word hidden AFTER the reveal leaves everyone's results and the board too
    await panel(alice.page)
      .getByTestId('la-words-results')
      .getByRole('button', { name: 'Hide the word Focus' })
      .click()
    await expect(panel(alice.page).getByTestId('la-hidden-words')).toContainText(/focus/i)
    for (const page of [alice.page, bob.page, carol.page, guest.page]) {
      const list = panel(page).getByTestId('la-words-results')
      await expect(list.locator('li')).toHaveCount(2)
      await expect(list).not.toContainText('Focus')
    }

    await panel(alice.page).getByTestId('la-to-board').click()
    await expectSaved(alice.page)
    const els = await placed(alice.page, KIND)
    const frame = els.find((e) => e.type === 'frame')
    expect(frame).toBeDefined()
    const words = els.filter((e) => e.type === 'text' && ['Agile', 'Speed', 'Focus'].includes(textOf(e)))
    expect(words.map(textOf).sort()).toEqual(['Agile', 'Speed'])
    expect(els.some((e) => textOf(e).includes('coffee') || textOf(e).includes('Focus'))).toBe(false)
    for (const w of words) {
      expect(w.frameId).toBe(frame?.id)
      expect(w.x).toBeGreaterThanOrEqual(frame?.x ?? 0)
      expect(w.x + w.width).toBeLessThanOrEqual((frame?.x ?? 0) + (frame?.width ?? 0) + 1)
      expect(w.y + w.height).toBeLessThanOrEqual((frame?.y ?? 0) + (frame?.height ?? 0) + 1)
    }
    // the most frequent word is the biggest
    const size = (t: string) =>
      (words.find((w) => textOf(w) === t) as unknown as { fontSize: number }).fontSize
    expect(size('Agile')).toBeGreaterThan(size('Speed'))
    await expect.poll(async () => (await placed(bob.page, KIND)).length).toBe(els.length)

    // one undo step, then the other form: one note per word with its count
    await focusCanvas(alice.page)
    await alice.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await placed(alice.page, KIND)).length).toBe(0)
    await panel(alice.page).getByTestId('la-to-board-notes').click()
    await expectSaved(alice.page)
    const notes = (await placed(alice.page, KIND)).filter((e) => e.type === 'stickynote')
    expect(notes).toHaveLength(2)
    await expect
      .poll(async () => {
        const texts: string[] = []
        for (const n of notes)
          texts.push(
            await alice.page.evaluate(
              (id) =>
                (
                  window as unknown as { __lobbyBoard: { canvas: { text: { of(id: string): string } } } }
                ).__lobbyBoard.canvas.text.of(id),
              n.id,
            ),
          )
        return texts.sort()
      })
      .toEqual(['Agile (3)', 'Speed (2)'])
  } finally {
    for (const c of opened) await c.close()
  }
})
