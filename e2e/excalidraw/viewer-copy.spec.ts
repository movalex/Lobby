// CR-3A-4 on the Excalidraw board page: viewers and commenters copy, as far as the board's export policy
// lets them. Where the policy says "everyone" a viewer or a commenter selects a note, presses Ctrl/Cmd+C or
// chooses Copy in the context menu, and the note's words are on the clipboard (a reviewer pasting a note's
// text into an email); where the owner turned exporting off ("editors") the same keys only say why, the
// clipboard stays as it was and the menu has no Copy; and the owner's switch reaches them live. A name-only
// guest copies only under 'everyone-including-guests' (the rule exportAllowedFor states), never under
// 'everyone'. Editors keep the engine's own copy under every policy that lets them.
//
// Before: the input layer let only editors copy (canCopy defaulted to `role === 'editor'`, the keymap
// blocked and prevented a read-only role's Ctrl+C), and the board page never passed a policy to it.
import type { Page } from '@playwright/test'
import {
  clickItem,
  createNote,
  expect,
  select,
  selectNone,
  test,
  waitForItem,
} from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { settled } from './board-kit.ts'
import { createGuestLink, joinAsGuest } from './guests-kit.ts'

type Policy = 'everyone' | 'editors' | 'everyone-including-guests'

const OFF = 'The board owner turned off exporting for viewers'
const SENTINEL = 'clipboard sentinel'

/** The owner's switch (the Share dialog's setting, through the api the dialog uses). */
async function setPolicy(page: Page, board: string, exportPolicy: Policy): Promise<void> {
  const status = await page.evaluate(
    async ({ bid, policy }) => {
      const r = await fetch(`/api/boards/${encodeURIComponent(bid)}/export-policy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ exportPolicy: policy }),
      })
      return r.status
    },
    { bid: board, policy: exportPolicy },
  )
  expect(status).toBe(200)
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())
const prime = (page: Page) => page.evaluate((v) => navigator.clipboard.writeText(v), SENTINEL)

/** Selects `ids` (the facade), gives the board the keyboard and presses the platform's Copy chord. */
async function pressCopy(page: Page, ids: string[]): Promise<void> {
  await select(page, ids)
  await page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
  await page.keyboard.press('ControlOrMeta+c')
}

/** Right-clicks `id` (it gets selected, the context menu opens). */
async function menuOn(page: Page, id: string) {
  await clickItem(page, id, { button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  return menu
}

test('viewers and commenters copy a note’s text with Ctrl+C and the menu’s Copy while the export policy lets them; the owner’s switch reaches them live; editors keep the engine’s copy', async ({
  canvasSession,
  board,
}) => {
  const a = await canvasSession('alice')
  const first = await settled(a.page, createNote(a.page, { x: 0, y: 0, text: 'Call the client' }))
  const second = await settled(a.page, createNote(a.page, { x: 400, y: 0, text: 'Send the quote' }))
  const readers = [
    { who: await canvasSession('bob', { role: 'viewer' }), label: 'viewer' },
    { who: await canvasSession('carol', { role: 'commenter' }), label: 'commenter' },
  ]
  for (const { who } of readers) {
    await who.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
    await waitForItem(who.page, first)
    await waitForItem(who.page, second)
  }
  await a.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })

  for (const { who, label } of readers) {
    await test.step(`the default policy ("everyone"): a ${label} copies one note and two notes with Ctrl+C, and a note with the menu’s Copy`, async () => {
      await prime(who.page)
      await pressCopy(who.page, [first])
      await expect.poll(() => clipboard(who.page)).toBe('Call the client')
      // two notes: the words top to bottom, then left to right, one per line
      await prime(who.page)
      await pressCopy(who.page, [second, first])
      await expect.poll(() => clipboard(who.page)).toBe('Call the client\nSend the quote')
      // the context menu's Copy (a right-click on an item outside the selection selects just that item)
      await prime(who.page)
      await selectNone(who.page)
      const menu = await menuOn(who.page, second)
      await expect(menu.getByTestId('context-menu.copy')).toBeVisible()
      await menu.getByTestId('context-menu.copy').click()
      await expect.poll(() => clipboard(who.page)).toBe('Send the quote')
      // nothing was written to the board by any of it
      await expect(who.page.getByTestId('export-off-notice')).toHaveCount(0)
    })
  }

  await test.step('the owner turns exporting off ("editors"): the same keys only say why, the clipboard stays, the menu has no Copy', async () => {
    await setPolicy(a.page, board, 'editors')
    for (const { who, label } of readers) {
      await prime(who.page)
      await expect
        .poll(
          async () => {
            await pressCopy(who.page, [first])
            return who.page.getByTestId('export-off-notice').count()
          },
          { message: `the ${label}'s Ctrl+C says why` },
        )
        .toBeGreaterThan(0)
      await expect(who.page.getByTestId('export-off-notice')).toContainText(OFF)
      await who.page.waitForTimeout(300)
      expect(await clipboard(who.page), `the ${label}'s clipboard`).toBe(SENTINEL)
      const menu = await menuOn(who.page, first)
      await expect(menu.getByTestId('context-menu.dr-export-off')).toContainText(OFF)
      await expect(menu.getByTestId('context-menu.copy')).toHaveCount(0)
      await who.page.keyboard.press('Escape')
      await expect(who.page.getByTestId('context-menu')).toHaveCount(0)
    }
  })

  await test.step('the owner (an editor) still copies under "editors": the engine’s own clipboard holds the note', async () => {
    await a.page.evaluate((v) => navigator.clipboard.writeText(v), SENTINEL)
    await pressCopy(a.page, [first])
    await expect.poll(() => clipboard(a.page)).toContain('Call the client')
    expect(await clipboard(a.page)).not.toBe(SENTINEL)
  })

  await test.step('the owner switches it back on: both copy again without a reload', async () => {
    await setPolicy(a.page, board, 'everyone')
    for (const { who, label } of readers) {
      await expect
        .poll(
          async () => {
            await prime(who.page)
            await pressCopy(who.page, [second])
            await who.page.waitForTimeout(100)
            return clipboard(who.page)
          },
          { message: `the ${label} copies again` },
        )
        .toBe('Send the quote')
      const menu = await menuOn(who.page, first)
      await expect(menu.getByTestId('context-menu.copy')).toBeVisible()
      await who.page.keyboard.press('Escape')
    }
  })

  await test.step('with nothing selected Ctrl+C copies nothing, and says nothing', async () => {
    const viewer = readers[0]?.who
    if (!viewer) throw new Error('no viewer')
    const who = viewer
    await prime(who.page)
    await who.page.evaluate(() => {
      const c = (window as unknown as { __lobbyBoard: { canvas: { select(ids: string[]): void } } })
        .__lobbyBoard.canvas
      c.select([])
    })
    await who.page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
    await who.page.keyboard.press('ControlOrMeta+c')
    await who.page.waitForTimeout(300)
    expect(await clipboard(who.page)).toBe(SENTINEL)
    await expect(who.page.getByTestId('export-off-notice')).toHaveCount(0)
  })
})

test('a name-only guest copies only when the owner includes guests: never under "everyone" or "editors"', async ({
  browser,
  canvasSession,
  board,
}) => {
  const a = await canvasSession('alice')
  const note = await settled(a.page, createNote(a.page, { x: 0, y: 0, text: 'Client feedback' }))
  const link = await createGuestLink(a.page, board, 'review')
  const guest = await joinAsGuest(browser, link, 'Gus')
  try {
    await guest.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
    await waitForItem(guest.page, note)
    const tries = async (): Promise<string> => {
      await prime(guest.page)
      await pressCopy(guest.page, [note])
      await guest.page.waitForTimeout(250)
      return clipboard(guest.page)
    }

    await setPolicy(a.page, board, 'editors')
    await expect.poll(tries, { message: 'under "editors"' }).toBe(SENTINEL)
    await expect(guest.page.getByTestId('export-off-notice')).toContainText('turned off exporting')

    // "everyone" covers people with an account: a name-only guest is still an outsider (audit L3)
    await setPolicy(a.page, board, 'everyone')
    await guest.page.waitForTimeout(500)
    expect(await tries(), 'under "everyone"').toBe(SENTINEL)
    const menu = await menuOn(guest.page, note)
    await expect(menu.getByTestId('context-menu.copy')).toHaveCount(0)
    await guest.page.keyboard.press('Escape')

    await setPolicy(a.page, board, 'everyone-including-guests')
    await expect.poll(tries, { message: 'under "everyone-including-guests"' }).toBe('Client feedback')
    const open = await menuOn(guest.page, note)
    await expect(open.getByTestId('context-menu.copy')).toBeVisible()
  } finally {
    await guest.context.close()
  }
})
