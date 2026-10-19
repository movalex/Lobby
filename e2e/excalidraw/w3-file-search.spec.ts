// Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): search inside files, end to end on the stack's real api, sync and preview
// worker (the current build: it reports extract-text@1, claims the op the api queued when the PDF became ready, reads
// the text with pdf.js in its child and sends it page by page).
//  - Ctrl+K on another board finds a word of page 2 of a PDF placed on this board: "Page 2 · Brief.pdf · <board>";
//    choosing it opens the board with the page viewer at page 2, and the address loses its ?file=&page=;
//  - the dashboard's "Inside boards" shows the same hit ("Page 2 · Brief.pdf") and opens the same way;
//  - a member without access to the board never gets the file's words or ids (read on the wire);
//  - the card deleted from the board, the file stops hitting at the next reindex;
//  - nothing leaves Lobby's origins (the e2e network assertion).
//
//   E2E_PORT_BASE=48300 pnpm --filter @draftroom/e2e excalidraw -- w3-file-search
import { randomBytes } from 'node:crypto'
import type { Page, Request } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { deleteItem, expect, expectSaved, openCanvasSession, test } from '../tests/support/canvas.ts'
import type { FilePayload } from '../tests/support/files.ts'
import { viewer, viewerCounter } from '../tests/support/media-2.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'
import { cardItems, fileCard, insertFiles } from './media-kit.ts'
import { focusCanvas, waitForNavigation } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/** A word no other board or file in this run contains (letters only). */
const word = (prefix: string) =>
  `${prefix}${[...randomBytes(6)].map((b) => String.fromCharCode(97 + (b % 26))).join('')}`

/** A three-page PDF whose page 2 alone holds `key`. */
async function briefPdf(key: string): Promise<FilePayload> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const lines = ['Cover page of the brief', `The ${key} pricing decision is final`, 'Appendix tables']
  for (const line of lines) doc.addPage([612, 792]).drawText(line, { x: 72, y: 600, size: 24, font })
  return { name: 'Brief.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) }
}

function foreignRequests(page: Page) {
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  const foreign: string[] = []
  page.on('request', (r: Request) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!own.has(url.origin)) foreign.push(r.url())
  })
  return foreign
}

const palette = (page: Page) => page.getByTestId('command-palette')
const input = (page: Page) => page.getByTestId('command-palette-input')
const option = (page: Page, id: string) =>
  page.locator(`[data-testid="command-palette-option"][data-entry-id="${id}"]`)

async function openPalette(page: Page) {
  await focusCanvas(page)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette(page)).toBeVisible()
}

/** Types `q` until the palette's workspace group shows `id` (the text is extracted and indexed in the background). */
async function paletteHit(page: Page, q: string, id: string) {
  await expect
    .poll(
      async () => {
        if (!(await palette(page).count())) await openPalette(page)
        await input(page).fill(q)
        try {
          await expect(option(page, id)).toBeVisible({ timeout: 4_000 })
          return true
        } catch {
          await page.keyboard.press('Escape')
          return false
        }
      },
      { timeout: 120_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe(true)
}

/** The workspace search's raw answer for `q`, as the page's own session asks it. */
const searchBody = (page: Page, wid: string, q: string) =>
  page.evaluate(
    async ({ wid, q }) =>
      (
        await fetch(`/api/workspaces/${wid}/search?${new URLSearchParams({ q })}`, { credentials: 'include' })
      ).text(),
    { wid, q },
  )

test('a word of page 2 of a placed PDF: Ctrl+K and the dashboard find it ("Page 2 · Brief.pdf"), open the viewer at page 2; a member without access gets nothing; deleting the card stops it', async ({
  canvasSession,
  board,
  users,
  browser,
}) => {
  test.setTimeout(300_000)
  const key = word('aardvark')
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  await insertFiles(a.page, [await briefPdf(key)])
  await expect(fileCard(a.page, 'Brief.pdf')).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
  const card = (await cardItems(a.page)).find((c) => c.facts.name === 'Brief.pdf')
  if (!card) throw new Error('no card')
  const versionId = card.facts.versionId
  const hitId = `ws:${board}:file:${versionId}.p2`
  const title = (await (await users.api('alice')).fetch('GET', `/api/boards/${board}`).then((r) => r.json()))
    .board.title as string

  // another board of alice's, where the palette's workspace group shows this board's hits
  const elsewhere = await users.createBoard('File search elsewhere')
  const e = await openCanvasSession(browser, elsewhere, await users.get('alice'))
  try {
    await test.step('Ctrl+K: "Page 2 · Brief.pdf · <board>", and it opens the viewer at page 2', async () => {
      await paletteHit(e.page, key, hitId)
      await expect(option(e.page, hitId)).toContainText(`Page 2 · Brief.pdf · ${title}`)
      await option(e.page, hitId).click()
      await expect(e.page).toHaveURL(new RegExp(`/b/${board}`))
      await waitForNavigation(e.page)
      await expect(viewer(e.page)).toBeVisible({ timeout: 20_000 })
      await expect(viewerCounter(e.page)).toHaveText('Page 2 of 3')
      // the link did its job: a reload lands on the board as usual
      await expect.poll(() => new URL(e.page.url()).search).toBe('')
      await e.page.keyboard.press('Escape')
      await expect(viewer(e.page)).toHaveCount(0)
    })

    await test.step('the dashboard: "Page 2 · Brief.pdf" under Inside boards, opening the same way', async () => {
      await e.page.getByRole('link', { name: 'Back to Dev Studio' }).click()
      await expect(e.page.getByTestId('dashboard')).toBeVisible()
      await e.page.getByTestId('dashboard-search').fill(key)
      const hit = e.page.locator(`[data-testid="content-search-hit"][data-object-id="file:${versionId}.p2"]`)
      await expect(hit).toBeVisible({ timeout: 20_000 })
      await expect(hit).toContainText('Page 2 · Brief.pdf')
      expect(await hit.getAttribute('href')).toBe(`/b/${board}?file=${versionId}&page=2`)
      await hit.click()
      await waitForNavigation(e.page)
      await expect(viewerCounter(e.page)).toHaveText('Page 2 of 3', { timeout: 20_000 })
    })
  } finally {
    await e.context.close()
  }

  await test.step('a member without access to the board gets neither its words nor its ids', async () => {
    // bob is a member of Dev Studio with no grant on this private board
    const res = await (await users.api('bob')).fetch(
      'GET',
      `/api/workspaces/${users.devStudioId}/search?${new URLSearchParams({ q: key })}`,
    )
    expect(res.status()).toBe(200)
    const body = await res.text()
    expect(body).not.toContain(versionId)
    expect(body).not.toContain(board)
    expect(body).not.toContain('Brief.pdf')
    expect(JSON.parse(body).groups).toEqual([])
  })

  await test.step('the card deleted, the file stops hitting at the next reindex', async () => {
    expect(await searchBody(a.page, users.devStudioId, key)).toContain(versionId)
    await deleteItem(a.page, card.id)
    await expectSaved(a.page)
    await expect
      .poll(async () => (await searchBody(a.page, users.devStudioId, key)).includes(versionId), {
        timeout: 90_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .toBe(false)
  })

  expect(foreign).toEqual([])
})
